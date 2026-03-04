import { Hono } from 'hono';
import { db } from '../db';
import { blocks, reports } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';

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
