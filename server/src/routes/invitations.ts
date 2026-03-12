import { Hono } from 'hono';
import { db } from '../db';
import { dmInvitations, dmLeaves, blocks, profiles, encryptedMessages } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { wsClients } from '../index';

export const invitationRoutes = new Hono();

/**
 * POST /invitations/dm
 * Create a DM invitation (first contact with someone).
 * Includes sender profile snapshot + encrypted first message.
 */
invitationRoutes.post('/dm', async (c) => {
	const body = await c.req.json<{
		senderDid: string;
		recipientDid: string;
		groupId: string;
		senderDisplayName: string;
		senderAvatarMediaId?: string;
		senderAvatarKey?: string;
		senderAvatarNonce?: string;
		senderGeohashCell?: string;
		firstMessageCiphertext: string;
		firstMessageNonce: string;
		firstMessageEpoch: number;
		firstMessageDhPublicKey?: string;
		firstMessagePreviousCounter?: number;
	}>();

	if (!body.senderDid || !body.recipientDid || !body.groupId) {
		return c.json({ error: 'Missing required fields' }, 400);
	}

	// Check not blocked (either direction)
	const blocked = await db.select().from(blocks).where(
		and(eq(blocks.blockerDid, body.recipientDid), eq(blocks.blockedDid, body.senderDid))
	).get();
	if (blocked) {
		return c.json({ error: 'Cannot send invitation' }, 403);
	}
	const reverseBlocked = await db.select().from(blocks).where(
		and(eq(blocks.blockerDid, body.senderDid), eq(blocks.blockedDid, body.recipientDid))
	).get();
	if (reverseBlocked) {
		return c.json({ error: 'Cannot send invitation' }, 403);
	}

	// Check for existing pending invitation from same sender to same recipient
	const existing = await db.select().from(dmInvitations).where(
		and(
			eq(dmInvitations.senderDid, body.senderDid),
			eq(dmInvitations.recipientDid, body.recipientDid),
			eq(dmInvitations.status, 'pending')
		)
	).get();
	if (existing) {
		return c.json({ error: 'Invitation already pending' }, 409);
	}

	const id = nanoid();
	await db.insert(dmInvitations).values({
		id,
		senderDid: body.senderDid,
		recipientDid: body.recipientDid,
		groupId: body.groupId,
		senderDisplayName: body.senderDisplayName,
		senderAvatarMediaId: body.senderAvatarMediaId ?? null,
		senderAvatarKey: body.senderAvatarKey ?? null,
		senderAvatarNonce: body.senderAvatarNonce ?? null,
		senderGeohashCell: body.senderGeohashCell ?? null,
		firstMessageCiphertext: body.firstMessageCiphertext,
		firstMessageNonce: body.firstMessageNonce,
		firstMessageEpoch: body.firstMessageEpoch,
		firstMessageDhPublicKey: body.firstMessageDhPublicKey ?? null,
		firstMessagePreviousCounter: body.firstMessagePreviousCounter ?? null,
	});

	// Notify recipient in real-time so their badge updates
	const ws = wsClients.get(body.recipientDid);
	if (ws) {
		ws.send(JSON.stringify({ type: 'dm_invitation', senderDisplayName: body.senderDisplayName, groupId: body.groupId }));
	}

	return c.json({ ok: true, id });
});

/**
 * GET /invitations/dm?did=...
 * Get pending DM invitations for a recipient.
 */
invitationRoutes.get('/dm', async (c) => {
	const did = c.req.query('did');
	if (!did) return c.json({ error: 'did required' }, 400);

	const pending = await db.select().from(dmInvitations).where(
		and(eq(dmInvitations.recipientDid, did), eq(dmInvitations.status, 'pending'))
	).all();

	// Enrich with sender's boxPublicKey for crypto
	const results = [];
	for (const inv of pending) {
		const sender = await db.select({
			boxPublicKey: profiles.boxPublicKey,
		}).from(profiles).where(eq(profiles.did, inv.senderDid)).get();

		results.push({
			id: inv.id,
			senderDid: inv.senderDid,
			recipientDid: inv.recipientDid,
			groupId: inv.groupId,
			senderDisplayName: inv.senderDisplayName,
			senderAvatarMediaId: inv.senderAvatarMediaId,
			senderAvatarKey: inv.senderAvatarKey,
			senderAvatarNonce: inv.senderAvatarNonce,
			senderGeohashCell: inv.senderGeohashCell,
			senderBoxPublicKey: sender?.boxPublicKey ?? null,
			firstMessageCiphertext: inv.firstMessageCiphertext,
			firstMessageNonce: inv.firstMessageNonce,
			firstMessageEpoch: inv.firstMessageEpoch,
			firstMessageDhPublicKey: inv.firstMessageDhPublicKey,
			firstMessagePreviousCounter: inv.firstMessagePreviousCounter,
			createdAt: inv.createdAt,
		});
	}

	return c.json(results);
});

/**
 * POST /invitations/dm/:id/accept
 * Mark a DM invitation as accepted.
 */
invitationRoutes.post('/dm/:id/accept', async (c) => {
	const id = c.req.param('id');

	const inv = await db.select().from(dmInvitations).where(eq(dmInvitations.id, id)).get();
	if (!inv || inv.status !== 'pending') {
		return c.json({ error: 'Invalid invitation' }, 400);
	}

	await db.update(dmInvitations).set({ status: 'accepted' }).where(eq(dmInvitations.id, id));

	// Clear any DM leave records (reconnection case)
	await db.delete(dmLeaves).where(eq(dmLeaves.groupId, inv.groupId));

	// Now deliver the first message into encrypted_messages so the recipient gets it
	// Skip if empty ciphertext (reconnection request with no message)
	if (inv.firstMessageCiphertext) {
		await db.insert(encryptedMessages).values({
			id: nanoid(),
			groupId: inv.groupId,
			senderDid: inv.senderDid,
			recipientDid: inv.recipientDid,
			epoch: inv.firstMessageEpoch,
			ciphertext: inv.firstMessageCiphertext,
			nonce: inv.firstMessageNonce,
			dhPublicKey: inv.firstMessageDhPublicKey ?? null,
			previousCounter: inv.firstMessagePreviousCounter ?? null,
		});
	}

	// Notify the invitation sender via WebSocket that the DM was accepted
	const ws = wsClients.get(inv.senderDid);
	if (ws) {
		ws.send(JSON.stringify({ type: 'dm_accepted', groupId: inv.groupId }));
	}

	return c.json({ ok: true, groupId: inv.groupId });
});

/**
 * POST /invitations/dm/:id/decline
 * Decline a DM invitation without blocking (for "ignore").
 */
invitationRoutes.post('/dm/:id/decline', async (c) => {
	const id = c.req.param('id');

	const inv = await db.select().from(dmInvitations).where(eq(dmInvitations.id, id)).get();
	if (!inv || inv.status !== 'pending') {
		return c.json({ error: 'Invalid invitation' }, 400);
	}

	await db.update(dmInvitations).set({ status: 'declined' }).where(eq(dmInvitations.id, id));

	return c.json({ ok: true });
});

/**
 * POST /invitations/dm/:id/block
 * Block the sender and mark invitation as blocked.
 */
invitationRoutes.post('/dm/:id/block', async (c) => {
	const id = c.req.param('id');

	const inv = await db.select().from(dmInvitations).where(eq(dmInvitations.id, id)).get();
	if (!inv || inv.status !== 'pending') {
		return c.json({ error: 'Invalid invitation' }, 400);
	}

	await db.update(dmInvitations).set({ status: 'blocked' }).where(eq(dmInvitations.id, id));

	// Create block entry
	await db.insert(blocks).values({
		id: nanoid(),
		blockerDid: inv.recipientDid,
		blockedDid: inv.senderDid,
	});

	return c.json({ ok: true });
});

/**
 * POST /invitations/dm-leave
 * Record that a user left a DM conversation.
 */
invitationRoutes.post('/dm-leave', async (c) => {
	const { groupId, did } = await c.req.json<{ groupId: string; did: string }>();
	if (!groupId || !did) return c.json({ error: 'groupId and did required' }, 400);

	// Check not already recorded
	const existing = await db.select().from(dmLeaves).where(
		and(eq(dmLeaves.groupId, groupId), eq(dmLeaves.leaverDid, did))
	).get();
	if (!existing) {
		await db.insert(dmLeaves).values({ id: nanoid(), groupId, leaverDid: did });
	}

	// Notify the peer via WebSocket so they see it in real-time
	// Find the peer from a previous invitation for this groupId
	const inv = await db.select({ senderDid: dmInvitations.senderDid, recipientDid: dmInvitations.recipientDid })
		.from(dmInvitations)
		.where(eq(dmInvitations.groupId, groupId))
		.limit(1).all();
	if (inv.length > 0) {
		const peerDid = inv[0].senderDid === did ? inv[0].recipientDid : inv[0].senderDid;
		const ws = wsClients.get(peerDid);
		if (ws) {
			ws.send(JSON.stringify({ type: 'dm_peer_left', groupId, leaverDid: did }));
		}
	}

	return c.json({ ok: true });
});

/**
 * GET /invitations/dm-status?groupId=...
 * Get leave records for a DM conversation.
 */
invitationRoutes.get('/dm-status', async (c) => {
	const groupId = c.req.query('groupId');
	if (!groupId) return c.json({ error: 'groupId required' }, 400);

	const leaves = await db.select({
		leaverDid: dmLeaves.leaverDid,
		createdAt: dmLeaves.createdAt,
	}).from(dmLeaves).where(eq(dmLeaves.groupId, groupId)).all();

	return c.json(leaves);
});

/**
 * DELETE /invitations/dm-leave
 * Clear leave records for a DM (when reconnecting).
 */
invitationRoutes.delete('/dm-leave', async (c) => {
	const { groupId } = await c.req.json<{ groupId: string }>();
	if (!groupId) return c.json({ error: 'groupId required' }, 400);

	await db.delete(dmLeaves).where(eq(dmLeaves.groupId, groupId));
	return c.json({ ok: true });
});
