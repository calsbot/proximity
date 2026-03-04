import { Hono } from 'hono';
import { db } from '../db';
import { profiles, authChallenges } from '../db/schema';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

export const auth = new Hono();

/**
 * POST /auth/register
 * Register a new identity (DID + profile + encryption keys).
 */
auth.post('/register', async (c) => {
	const body = await c.req.json<{
		did: string;
		displayName: string;
		publicKey: string; // base64 Ed25519
		boxPublicKey: string; // base64 X25519
	}>();

	if (!body.did?.startsWith('did:key:z')) {
		return c.json({ error: 'Invalid DID format' }, 400);
	}

	const existing = await db.select().from(profiles).where(eq(profiles.did, body.did)).get();
	if (existing) {
		// Allow re-registration to update keys (but don't overwrite display name)
		await db.update(profiles).set({
			publicKey: body.publicKey,
			boxPublicKey: body.boxPublicKey,
			lastSeen: new Date()
		}).where(eq(profiles.did, body.did));
		return c.json({ ok: true, did: body.did, updated: true });
	}

	await db.insert(profiles).values({
		did: body.did,
		displayName: body.displayName,
		publicKey: body.publicKey,
		boxPublicKey: body.boxPublicKey,
	});

	return c.json({ ok: true, did: body.did });
});

/**
 * POST /auth/challenge
 */
auth.post('/challenge', async (c) => {
	const { did } = await c.req.json<{ did: string }>();

	const profile = await db.select().from(profiles).where(eq(profiles.did, did)).get();
	if (!profile) {
		return c.json({ error: 'Unknown DID' }, 404);
	}

	const challenge = nanoid(32);
	const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

	await db.insert(authChallenges)
		.values({ did, challenge, expiresAt })
		.onConflictDoUpdate({
			target: authChallenges.did,
			set: { challenge, expiresAt }
		});

	return c.json({ challenge });
});

/**
 * POST /auth/verify
 */
auth.post('/verify', async (c) => {
	const { did, challenge, signature } = await c.req.json<{
		did: string;
		challenge: string;
		signature: string;
	}>();

	const stored = await db.select().from(authChallenges).where(eq(authChallenges.did, did)).get();
	if (!stored || stored.challenge !== challenge) {
		return c.json({ error: 'Invalid challenge' }, 401);
	}
	if (stored.expiresAt < new Date()) {
		return c.json({ error: 'Challenge expired' }, 401);
	}

	await db.delete(authChallenges).where(eq(authChallenges.did, did));
	const token = `${did}:${nanoid(32)}`;
	return c.json({ token, did });
});
