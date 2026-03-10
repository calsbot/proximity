import { Hono } from 'hono';
import { db } from '../db';
import { encryptedMessages, groupMembers, groups, deliveryTokens, sealedMessages, groupDeliveryTokens } from '../db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';

export const messageRoutes = new Hono();

/** SHA-256 hex hash using Bun's built-in crypto. */
function sha256Hex(input: string): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(input);
	return hasher.digest('hex');
}

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
 * Returns { messages: [...], sealed: [...] } so client gets both types.
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

	const sealed = await db.select()
		.from(sealedMessages)
		.where(
			and(
				eq(sealedMessages.recipientDid, did),
				gte(sealedMessages.createdAt, since)
			)
		)
		.all();

	return c.json({ messages, sealed });
});

/**
 * POST /messages/delivery-token
 * Register (or update) a delivery token hash for a DID.
 * The server stores only the hash — never the actual token.
 */
messageRoutes.post('/delivery-token', async (c) => {
	const { did, tokenHash } = await c.req.json<{ did: string; tokenHash: string }>();

	if (!did || !tokenHash) {
		return c.json({ error: 'did and tokenHash required' }, 400);
	}

	// Upsert — replace existing token for this DID
	const existing = await db.select().from(deliveryTokens).where(eq(deliveryTokens.did, did)).get();
	if (existing) {
		await db.update(deliveryTokens).set({ tokenHash }).where(eq(deliveryTokens.did, did));
	} else {
		await db.insert(deliveryTokens).values({ did, tokenHash });
	}

	return c.json({ ok: true });
});

/**
 * POST /messages/sealed
 * Store a sealed message. Server cannot see senderDid — only recipientDid + opaque blob.
 * Validates delivery token hash before accepting.
 */
messageRoutes.post('/sealed', async (c) => {
	const body = await c.req.json<{
		recipientDid: string;
		deliveryToken: string; // plaintext token — server hashes it to verify
		sealedPayload: string; // base64
		ephemeralPublicKey: string; // base64
		nonce: string; // base64
	}>();

	if (!body.recipientDid || !body.deliveryToken || !body.sealedPayload || !body.ephemeralPublicKey || !body.nonce) {
		return c.json({ error: 'missing required fields' }, 400);
	}

	// Hash the provided token and check it matches a registered one
	const tokenHash = sha256Hex(body.deliveryToken);
	const token = await db.select().from(deliveryTokens).where(eq(deliveryTokens.tokenHash, tokenHash)).get();
	if (!token) {
		return c.json({ error: 'invalid delivery token' }, 403);
	}

	const id = nanoid();
	await db.insert(sealedMessages).values({
		id,
		recipientDid: body.recipientDid,
		deliveryTokenHash: tokenHash,
		sealedPayload: body.sealedPayload,
		ephemeralPublicKey: body.ephemeralPublicKey,
		nonce: body.nonce,
	});

	return c.json({ ok: true, id });
});

/**
 * POST /messages/group-delivery-token
 * Register (or update) a delivery token hash for a group.
 * Called by the group creator/admin.
 */
messageRoutes.post('/group-delivery-token', async (c) => {
	const { groupId, tokenHash } = await c.req.json<{ groupId: string; tokenHash: string }>();

	if (!groupId || !tokenHash) {
		return c.json({ error: 'groupId and tokenHash required' }, 400);
	}

	const existing = await db.select().from(groupDeliveryTokens).where(eq(groupDeliveryTokens.groupId, groupId)).get();
	if (existing) {
		await db.update(groupDeliveryTokens).set({ tokenHash }).where(eq(groupDeliveryTokens.groupId, groupId));
	} else {
		await db.insert(groupDeliveryTokens).values({ groupId, tokenHash });
	}

	return c.json({ ok: true });
});

/**
 * POST /messages/sealed-group
 * Store a sealed group message. Server cannot see senderDid.
 * Validates group delivery token, then fans out to all group members.
 * The ciphertext is group-key encrypted — same blob for all recipients.
 */
messageRoutes.post('/sealed-group', async (c) => {
	const body = await c.req.json<{
		groupId: string;
		deliveryToken: string; // plaintext — server hashes to verify
		ciphertext: string; // base64 — group-key encrypted (contains senderDid inside)
		nonce: string; // base64
		epoch: number;
	}>();

	if (!body.groupId || !body.deliveryToken || !body.ciphertext || !body.nonce) {
		return c.json({ error: 'missing required fields' }, 400);
	}

	// Validate group delivery token
	const tokenHash = sha256Hex(body.deliveryToken);
	const token = await db.select().from(groupDeliveryTokens).where(eq(groupDeliveryTokens.tokenHash, tokenHash)).get();
	if (!token) {
		return c.json({ error: 'invalid group delivery token' }, 403);
	}

	// Get all group members to fan out
	const members = await db.select().from(groupMembers).where(eq(groupMembers.groupId, body.groupId)).all();

	// Store one message per member (senderDid is 'sealed' — server doesn't know who sent it)
	const ids: string[] = [];
	for (const member of members) {
		const id = nanoid();
		await db.insert(encryptedMessages).values({
			id,
			groupId: body.groupId,
			senderDid: 'sealed',
			recipientDid: member.did,
			epoch: body.epoch,
			ciphertext: body.ciphertext,
			nonce: body.nonce,
		});
		ids.push(id);
	}

	return c.json({ ok: true, ids });
});
