import { Hono } from 'hono';
import { db } from '../db';
import { encryptedMessages, groupMembers, groups } from '../db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';

export const messageRoutes = new Hono();

/**
 * POST /messages
 * Store an encrypted message. Server cannot read the content.
 */
messageRoutes.post('/', async (c) => {
	const body = await c.req.json<{
		groupId: string;
		senderDid: string;
		recipientDid: string;
		epoch: number;
		ciphertext: string; // base64
		nonce: string; // base64
		dhPublicKey?: string; // base64 — Double Ratchet header
		previousCounter?: number; // Double Ratchet header
	}>();

	// Reject messages from non-members of actual groups (skip for 1-to-1 DM conversations)
	const group = await db.select().from(groups).where(eq(groups.id, body.groupId)).get();
	if (group) {
		const isMember = await db.select()
			.from(groupMembers)
			.where(and(eq(groupMembers.groupId, body.groupId), eq(groupMembers.did, body.senderDid)))
			.get();
		if (!isMember) {
			return c.json({ error: 'Not a group member' }, 403);
		}
	}

	const id = nanoid();
	await db.insert(encryptedMessages).values({
		id,
		groupId: body.groupId,
		senderDid: body.senderDid,
		recipientDid: body.recipientDid,
		epoch: body.epoch,
		ciphertext: body.ciphertext,
		nonce: body.nonce,
		dhPublicKey: body.dhPublicKey ?? null,
		previousCounter: body.previousCounter ?? null,
	});

	return c.json({ ok: true, id });
});

/**
 * GET /messages?did=...&since=timestamp
 * Fetch encrypted messages for a DID since a given time.
 */
messageRoutes.get('/', async (c) => {
	const did = c.req.query('did');
	const sinceParam = c.req.query('since');

	if (!did) {
		return c.json({ error: 'did parameter required' }, 400);
	}

	const since = sinceParam ? new Date(sinceParam) : new Date(0);

	const messages = await db.select()
		.from(encryptedMessages)
		.where(
			and(
				eq(encryptedMessages.recipientDid, did),
				gte(encryptedMessages.createdAt, since)
			)
		)
		.all();

	return c.json(messages);
});
