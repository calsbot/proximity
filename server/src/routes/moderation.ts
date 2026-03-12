import { Hono } from 'hono';
import { db } from '../db';
import { blocks, reports, flags, flagThrottles, csamHashes, profiles, groupMembers, encryptedMessages, media } from '../db/schema';
import { eq, and, gte, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import nacl from 'tweetnacl';

export const moderationRoutes = new Hono();

/**
 * POST /moderation/block
 * Block a user.
 */
moderationRoutes.post('/block', async (c) => {
	const { blockerDid, blockedDid } = await c.req.json<{
		blockerDid: string;
		blockedDid: string;
	}>();

	if (!blockerDid || !blockedDid) {
		return c.json({ error: 'blockerDid and blockedDid required' }, 400);
	}

	if (blockerDid === blockedDid) {
		return c.json({ error: 'Cannot block yourself' }, 400);
	}

	// Check if already blocked
	const existing = await db.select()
		.from(blocks)
		.where(and(eq(blocks.blockerDid, blockerDid), eq(blocks.blockedDid, blockedDid)))
		.get();

	if (existing) {
		return c.json({ ok: true, alreadyBlocked: true });
	}

	await db.insert(blocks).values({
		id: nanoid(),
		blockerDid,
		blockedDid,
	});

	return c.json({ ok: true });
});

/**
 * POST /moderation/unblock
 * Unblock a user.
 */
moderationRoutes.post('/unblock', async (c) => {
	const { blockerDid, blockedDid } = await c.req.json<{
		blockerDid: string;
		blockedDid: string;
	}>();

	await db.delete(blocks)
		.where(and(eq(blocks.blockerDid, blockerDid), eq(blocks.blockedDid, blockedDid)));

	return c.json({ ok: true });
});

/**
 * GET /moderation/blocks?did=...
 * List users blocked by this DID.
 */
moderationRoutes.get('/blocks', async (c) => {
	const did = c.req.query('did');
	if (!did) return c.json({ error: 'did required' }, 400);

	const blockedList = await db.select({
		blockedDid: blocks.blockedDid,
		createdAt: blocks.createdAt,
	}).from(blocks).where(eq(blocks.blockerDid, did)).all();

	return c.json(blockedList);
});

/**
 * POST /moderation/report
 * Report a user.
 */
moderationRoutes.post('/report', async (c) => {
	const body = await c.req.json<{
		reporterDid: string;
		reportedDid: string;
		reason: string; // 'spam' | 'harassment' | 'underage' | 'impersonation' | 'other'
		details?: string;
	}>();

	if (!body.reporterDid || !body.reportedDid || !body.reason) {
		return c.json({ error: 'reporterDid, reportedDid, and reason required' }, 400);
	}

	const validReasons = ['spam', 'harassment', 'underage', 'impersonation', 'other'];
	if (!validReasons.includes(body.reason)) {
		return c.json({ error: `Invalid reason. Must be one of: ${validReasons.join(', ')}` }, 400);
	}

	await db.insert(reports).values({
		id: nanoid(),
		reporterDid: body.reporterDid,
		reportedDid: body.reportedDid,
		reason: body.reason,
		details: body.details ?? '',
	});

	return c.json({ ok: true });
});

// --- Community Moderation: DID-signed flags ---

/**
 * Compute independence weight for a flag.
 * Users in the same group or with recent messages have lower weight
 * (to prevent coordinated abuse from within a group).
 */
async function computeIndependenceWeight(flaggerDid: string, flaggedDid: string): Promise<number> {
	// Check shared groups
	const flaggerGroups = await db.select({ groupId: groupMembers.groupId })
		.from(groupMembers).where(eq(groupMembers.did, flaggerDid)).all();
	const flaggedGroups = await db.select({ groupId: groupMembers.groupId })
		.from(groupMembers).where(eq(groupMembers.did, flaggedDid)).all();

	const flaggerGroupSet = new Set(flaggerGroups.map(g => g.groupId));
	const sharedGroup = flaggedGroups.some(g => flaggerGroupSet.has(g.groupId));

	if (sharedGroup) return 3; // 0.3 * 10

	// Check recent messages between them (last 7 days)
	const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
	const recentMsgs = await db.select({ id: encryptedMessages.id })
		.from(encryptedMessages)
		.where(and(
			eq(encryptedMessages.senderDid, flaggerDid),
			eq(encryptedMessages.recipientDid, flaggedDid),
			gte(encryptedMessages.createdAt, weekAgo)
		))
		.limit(1)
		.all();

	if (recentMsgs.length > 0) return 2; // 0.2 * 10

	return 10; // 1.0 * 10 (independent)
}

/**
 * Check and update throttle level based on flag weights.
 */
async function updateThrottleLevel(flaggedDid: string, category: string): Promise<void> {
	const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
	const recentFlags = await db.select({ weight: flags.weight })
		.from(flags)
		.where(and(
			eq(flags.flaggedDid, flaggedDid),
			eq(flags.category, category),
			gte(flags.createdAt, weekAgo)
		))
		.all();

	const totalWeight = recentFlags.reduce((sum, f) => sum + (f.weight ?? 10), 0);

	// Thresholds: >=50 (5.0) → hidden, >=30 (3.0) → throttled
	let level = 'none';
	if (totalWeight >= 50) level = 'hidden';
	else if (totalWeight >= 30) level = 'throttled';

	if (level === 'none') return;

	// Upsert throttle
	const existing = await db.select().from(flagThrottles).where(eq(flagThrottles.did, flaggedDid)).get();
	if (existing) {
		// Only escalate, never de-escalate automatically
		if (level === 'hidden' || (level === 'throttled' && existing.level === 'none')) {
			await db.update(flagThrottles).set({ level, reason: category, effectiveAt: new Date() })
				.where(eq(flagThrottles.did, flaggedDid));
		}
	} else {
		await db.insert(flagThrottles).values({
			did: flaggedDid,
			level,
			reason: category,
			effectiveAt: new Date(),
		});
	}
}

/**
 * POST /moderation/flag
 * Submit a DID-signed flag annotation.
 * Verifies Ed25519 signature, computes independence weight, checks thresholds.
 */
moderationRoutes.post('/flag', async (c) => {
	const body = await c.req.json<{
		flaggerDid: string;
		flaggedDid: string;
		category: string;
		signedBlob: string; // base64 JSON payload
		signature: string; // base64 Ed25519 signature
	}>();

	if (!body.flaggerDid || !body.flaggedDid || !body.category || !body.signedBlob || !body.signature) {
		return c.json({ error: 'All fields required' }, 400);
	}

	const validCategories = ['fake_profile', 'harassment', 'underage', 'spam'];
	if (!validCategories.includes(body.category)) {
		return c.json({ error: 'Invalid category' }, 400);
	}

	// Verify the flagger exists and get their public key
	const flagger = await db.select({ publicKey: profiles.publicKey })
		.from(profiles).where(eq(profiles.did, body.flaggerDid)).get();
	if (!flagger?.publicKey) {
		return c.json({ error: 'Flagger not found or missing public key' }, 400);
	}

	// Verify Ed25519 signature
	try {
		const signedBlobBytes = Buffer.from(body.signedBlob, 'base64');
		const signatureBytes = Buffer.from(body.signature, 'base64');
		const publicKeyBytes = Buffer.from(flagger.publicKey, 'base64');

		const valid = nacl.sign.detached.verify(
			new Uint8Array(signedBlobBytes),
			new Uint8Array(signatureBytes),
			new Uint8Array(publicKeyBytes)
		);
		if (!valid) {
			return c.json({ error: 'Invalid signature' }, 403);
		}
	} catch (err) {
		return c.json({ error: 'Signature verification failed', detail: String(err) }, 400);
	}

	// Compute independence weight
	const weight = await computeIndependenceWeight(body.flaggerDid, body.flaggedDid);

	await db.insert(flags).values({
		id: nanoid(),
		flaggerDid: body.flaggerDid,
		flaggedDid: body.flaggedDid,
		category: body.category,
		signedBlob: body.signedBlob,
		signature: body.signature,
		weight,
	});

	// Check thresholds and update throttle level
	await updateThrottleLevel(body.flaggedDid, body.category);

	return c.json({ ok: true });
});

/**
 * GET /moderation/flag-status?did=...
 * Check the throttle/hidden level for a DID.
 */
moderationRoutes.get('/flag-status', async (c) => {
	const did = c.req.query('did');
	if (!did) return c.json({ error: 'did required' }, 400);

	const throttle = await db.select().from(flagThrottles).where(eq(flagThrottles.did, did)).get();
	if (!throttle) {
		return c.json({ level: 'none' });
	}

	// Check if expired
	if (throttle.expiresAt && new Date(throttle.expiresAt) < new Date()) {
		return c.json({ level: 'none', expired: true });
	}

	return c.json({
		level: throttle.level,
		reason: throttle.reason,
		effectiveAt: throttle.effectiveAt,
		expiresAt: throttle.expiresAt,
		appealedAt: throttle.appealedAt,
	});
});

/**
 * POST /moderation/appeal
 * Record an appeal for a throttled/hidden user.
 */
moderationRoutes.post('/appeal', async (c) => {
	const { did } = await c.req.json<{ did: string }>();
	if (!did) return c.json({ error: 'did required' }, 400);

	const throttle = await db.select().from(flagThrottles).where(eq(flagThrottles.did, did)).get();
	if (!throttle || throttle.level === 'none') {
		return c.json({ error: 'Not throttled' }, 400);
	}

	await db.update(flagThrottles).set({ appealedAt: new Date() })
		.where(eq(flagThrottles.did, did));

	return c.json({ ok: true });
});

/**
 * POST /moderation/check-csam
 * Client sends perceptual hash of image before encryption.
 * Server stores hash and checks against known CSAM databases.
 * For MVP: stores hash, returns clear (Thorn API integration is placeholder).
 */
moderationRoutes.post('/check-csam', async (c) => {
	const body = await c.req.json<{
		mediaId: string;
		perceptualHash: string;
	}>();

	if (!body.mediaId || !body.perceptualHash) {
		return c.json({ error: 'mediaId and perceptualHash required' }, 400);
	}

	const id = nanoid();
	await db.insert(csamHashes).values({
		id,
		mediaId: body.mediaId,
		perceptualHash: body.perceptualHash,
	});

	// TODO: Call Thorn Safer Match API here
	// For now, store and return clear
	let matchResult = 'clear';

	// Placeholder for Thorn API call:
	// try {
	//   const thornResult = await callThornSaferMatch(body.perceptualHash);
	//   matchResult = thornResult.isMatch ? 'match' : 'clear';
	// } catch { matchResult = 'error'; }

	await db.update(csamHashes).set({
		matchResult,
		checkedAt: new Date(),
	}).where(eq(csamHashes.id, id));

	if (matchResult === 'match') {
		// Delete the media blob and flag the uploader
		await db.delete(media).where(eq(media.id, body.mediaId));
		return c.json({ blocked: true });
	}

	return c.json({ blocked: false });
});
