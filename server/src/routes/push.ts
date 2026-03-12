import { Hono } from 'hono';
import webpush from 'web-push';
import { db } from '../db';
import { pushSubscriptions, profiles } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';

export const pushRoutes = new Hono();

// VAPID keys — in production these should be in env vars
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BJAPP9TPB67UG_201BXDuil1NsWAgYoKGP0kYUpi9K8qWfu3yweBVAt6oBFfvk1yx9ukWLapXsZiLJTdyR-RRXM';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'QVd0T-iFA3CRl0F92XfoBAmk7q_w0DpwaH3nYvw7RdA';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@meetmarket.io';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

/**
 * GET /push/vapid-public-key
 * Return the VAPID public key so the client can subscribe.
 */
pushRoutes.get('/vapid-public-key', (c) => {
	return c.json({ publicKey: VAPID_PUBLIC_KEY });
});

/**
 * POST /push/subscribe
 * Register a push subscription for a DID.
 * Client sends their PushSubscription object.
 */
pushRoutes.post('/subscribe', async (c) => {
	const body = await c.req.json<{
		did: string;
		subscription: {
			endpoint: string;
			keys: {
				p256dh: string;
				auth: string;
			};
		};
	}>();

	if (!body.did || !body.subscription?.endpoint || !body.subscription?.keys?.p256dh || !body.subscription?.keys?.auth) {
		return c.json({ error: 'did and subscription required' }, 400);
	}

	// Remove existing subscription for this endpoint (re-subscribe)
	await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, body.subscription.endpoint));

	await db.insert(pushSubscriptions).values({
		id: nanoid(),
		did: body.did,
		endpoint: body.subscription.endpoint,
		p256dh: body.subscription.keys.p256dh,
		auth: body.subscription.keys.auth,
	});

	return c.json({ ok: true });
});

/**
 * POST /push/unsubscribe
 * Remove a push subscription.
 */
pushRoutes.post('/unsubscribe', async (c) => {
	const { did, endpoint } = await c.req.json<{ did: string; endpoint?: string }>();
	if (!did) return c.json({ error: 'did required' }, 400);

	if (endpoint) {
		// Remove specific subscription
		await db.delete(pushSubscriptions).where(
			and(eq(pushSubscriptions.did, did), eq(pushSubscriptions.endpoint, endpoint))
		);
	} else {
		// Remove all subscriptions for this DID
		await db.delete(pushSubscriptions).where(eq(pushSubscriptions.did, did));
	}

	return c.json({ ok: true });
});

/**
 * Send a push notification to a DID.
 * Called internally by the server (not exposed as API route).
 */
export async function sendPushNotification(
	recipientDid: string,
	payload: { title: string; body: string; tag?: string; data?: Record<string, string> }
): Promise<void> {
	const subs = await db.select().from(pushSubscriptions)
		.where(eq(pushSubscriptions.did, recipientDid)).all();

	if (subs.length === 0) return;

	const payloadStr = JSON.stringify(payload);

	for (const sub of subs) {
		try {
			await webpush.sendNotification(
				{
					endpoint: sub.endpoint,
					keys: { p256dh: sub.p256dh, auth: sub.auth },
				},
				payloadStr
			);
		} catch (err: any) {
			// 410 Gone or 404 = subscription expired, clean up
			if (err.statusCode === 410 || err.statusCode === 404) {
				await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
			}
			// Other errors — log and continue (don't break other subscriptions)
			console.warn(`[push] Failed to send to ${sub.endpoint.slice(0, 40)}:`, err.statusCode || err.message);
		}
	}
}
