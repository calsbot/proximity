import { Hono } from 'hono';
import { db } from '../db';
import { groups, groupMembers, groupInvites, groupKeys, profiles } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { wsClients } from '../index';

export const groupRoutes = new Hono();

/** Broadcast a system message to all online members of a group via WebSocket.
 *  NOT persisted server-side — the server shouldn't know group activity details.
 *  Clients store these locally if they're online when it happens. */
async function broadcastSystemMessage(groupId: string, text: string) {
	const members = await db.select({ did: groupMembers.did })
		.from(groupMembers)
		.where(eq(groupMembers.groupId, groupId))
		.all();
	for (const m of members) {
		const ws = wsClients.get(m.did);
		if (ws) {
			ws.send(JSON.stringify({ type: 'system_message', groupId, text }));
		}
	}
}

/** Get display name for a DID. */
async function getDisplayName(did: string): Promise<string> {
	const profile = await db.select({ displayName: profiles.displayName })
		.from(profiles).where(eq(profiles.did, did)).get();
	return profile?.displayName ?? did.slice(-8);
}

/** SHA-256 hash a string to hex (for invite key verification). */
async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * POST /groups
 * Create a new group chat.
 */
groupRoutes.post('/', async (c) => {
	const body = await c.req.json<{
		name: string;
		creatorDid: string;
		initialMembers?: string[]; // DIDs to invite
	}>();

	if (!body.name || !body.creatorDid) {
		return c.json({ error: 'name and creatorDid required' }, 400);
	}

	const groupId = nanoid();
	const memberId = nanoid();

	await db.insert(groups).values({
		id: groupId,
		name: body.name,
		creatorDid: body.creatorDid,
	});

	// Add creator as admin
	await db.insert(groupMembers).values({
		id: memberId,
		groupId,
		did: body.creatorDid,
		role: 'admin',
	});

	// Send invites to initial members
	if (body.initialMembers) {
		for (const inviteeDid of body.initialMembers) {
			if (inviteeDid === body.creatorDid) continue;
			await db.insert(groupInvites).values({
				id: nanoid(),
				groupId,
				inviterDid: body.creatorDid,
				inviteeDid,
				status: 'pending',
			});
		}
	}

	return c.json({ ok: true, groupId });
});

/**
 * GET /groups?did=...
 * List groups that a DID is a member of.
 */
groupRoutes.get('/', async (c) => {
	const did = c.req.query('did');
	if (!did) return c.json({ error: 'did required' }, 400);

	const memberships = await db.select({
		groupId: groupMembers.groupId,
		role: groupMembers.role,
	}).from(groupMembers).where(eq(groupMembers.did, did)).all();

	const result = [];
	for (const m of memberships) {
		const group = await db.select().from(groups).where(eq(groups.id, m.groupId)).get();
		if (!group) continue;

		const members = await db.select({
			did: groupMembers.did,
			role: groupMembers.role,
		}).from(groupMembers).where(eq(groupMembers.groupId, m.groupId)).all();

		result.push({
			...group,
			role: m.role,
			members,
		});
	}

	return c.json(result);
});

/**
 * GET /groups/my-admin-join-requests
 * List ALL pending join requests across all groups where the caller is admin.
 */
groupRoutes.get('/my-admin-join-requests', async (c) => {
	const did = c.req.query('did');
	if (!did) return c.json({ error: 'did required' }, 400);

	// Find all groups where user is admin
	const adminMemberships = await db.select({ groupId: groupMembers.groupId })
		.from(groupMembers)
		.where(and(eq(groupMembers.did, did), eq(groupMembers.role, 'admin')))
		.all();

	if (adminMemberships.length === 0) return c.json([]);

	const result = [];
	for (const membership of adminMemberships) {
		const requests = await db.select()
			.from(groupInvites)
			.where(and(
				eq(groupInvites.groupId, membership.groupId),
				eq(groupInvites.status, 'requested')
			))
			.all();

		if (requests.length === 0) continue;

		// Get group name
		const group = await db.select({ name: groups.name })
			.from(groups).where(eq(groups.id, membership.groupId)).get();

		for (const req of requests) {
			const profile = await db.select({ displayName: profiles.displayName })
				.from(profiles).where(eq(profiles.did, req.inviteeDid)).get();
			result.push({
				id: req.id,
				groupId: membership.groupId,
				groupName: group?.name ?? 'unknown',
				requesterDid: req.inviteeDid,
				requesterName: profile?.displayName ?? 'unknown',
				createdAt: req.createdAt,
			});
		}
	}

	return c.json(result);
});

/**
 * GET /groups/my-pending-requests
 * List the caller's own pending join requests (so they can see status in the requests tab).
 */
groupRoutes.get('/my-pending-requests', async (c) => {
	const did = c.req.query('did');
	if (!did) return c.json({ error: 'did required' }, 400);

	const requests = await db.select()
		.from(groupInvites)
		.where(and(
			eq(groupInvites.inviteeDid, did),
			eq(groupInvites.status, 'requested')
		))
		.all();

	const result = [];
	for (const req of requests) {
		const group = await db.select({ name: groups.name })
			.from(groups).where(eq(groups.id, req.groupId)).get();
		result.push({
			id: req.id,
			groupId: req.groupId,
			groupName: group?.name ?? 'unknown',
			status: req.status,
			createdAt: req.createdAt,
		});
	}

	return c.json(result);
});

/**
 * GET /groups/:id
 * Get group details + members.
 */
groupRoutes.get('/:id', async (c) => {
	const id = c.req.param('id');
	const group = await db.select().from(groups).where(eq(groups.id, id)).get();
	if (!group) return c.json({ error: 'Group not found' }, 404);

	const members = await db.select({
		did: groupMembers.did,
		role: groupMembers.role,
	}).from(groupMembers).where(eq(groupMembers.groupId, id)).all();

	// Get display names for members
	const memberProfiles = [];
	for (const m of members) {
		const profile = await db.select({
			did: profiles.did,
			displayName: profiles.displayName,
			boxPublicKey: profiles.boxPublicKey,
		}).from(profiles).where(eq(profiles.did, m.did)).get();
		memberProfiles.push({
			...m,
			displayName: profile?.displayName ?? 'unknown',
			boxPublicKey: profile?.boxPublicKey ?? null,
		});
	}

	return c.json({ ...group, members: memberProfiles });
});

/**
 * POST /groups/:id/invite
 * Invite a DID to join a group.
 */
groupRoutes.post('/:id/invite', async (c) => {
	const groupId = c.req.param('id');
	const { inviterDid, inviteeDid } = await c.req.json<{
		inviterDid: string;
		inviteeDid: string;
	}>();

	// Verify inviter is a member
	const isMember = await db.select()
		.from(groupMembers)
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.did, inviterDid)))
		.get();

	if (!isMember) {
		return c.json({ error: 'Not a group member' }, 403);
	}

	// Only admins can invite
	if (isMember.role !== 'admin') {
		return c.json({ error: 'Only admins can invite members' }, 403);
	}

	// Check if already a member
	const alreadyMember = await db.select()
		.from(groupMembers)
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.did, inviteeDid)))
		.get();

	if (alreadyMember) {
		return c.json({ error: 'Already a member' }, 409);
	}

	const inviteId = nanoid();
	await db.insert(groupInvites).values({
		id: inviteId,
		groupId,
		inviterDid,
		inviteeDid,
		status: 'pending',
	});

	// Notify the invitee in real-time so they see the invite without refreshing
	const ws = wsClients.get(inviteeDid);
	if (ws) {
		const group = await db.select().from(groups).where(eq(groups.id, groupId)).get();
		ws.send(JSON.stringify({
			type: 'group_invite',
			groupId,
			inviteId,
			groupName: group?.name ?? '',
			inviterDid,
		}));
	}

	return c.json({ ok: true, inviteId });
});

/**
 * GET /groups/invites?did=...
 * List pending invites for a DID.
 */
groupRoutes.get('/invites/pending', async (c) => {
	const did = c.req.query('did');
	if (!did) return c.json({ error: 'did required' }, 400);

	const invites = await db.select()
		.from(groupInvites)
		.where(and(eq(groupInvites.inviteeDid, did), eq(groupInvites.status, 'pending')))
		.all();

	// Enrich with group names, description, member count, and inviter display name
	const result = [];
	for (const inv of invites) {
		const group = await db.select({ name: groups.name, description: groups.description }).from(groups).where(eq(groups.id, inv.groupId)).get();
		const members = await db.select({ did: groupMembers.did }).from(groupMembers).where(eq(groupMembers.groupId, inv.groupId)).all();
		const inviter = await db.select({ displayName: profiles.displayName }).from(profiles).where(eq(profiles.did, inv.inviterDid)).get();
		result.push({
			...inv,
			groupName: group?.name ?? 'unknown',
			groupDescription: group?.description ?? '',
			memberCount: members.length,
			inviterDisplayName: inviter?.displayName ?? inv.inviterDid.slice(-8),
		});
	}

	return c.json(result);
});

/**
 * POST /groups/invites/:id/respond
 * Accept or decline an invite.
 */
groupRoutes.post('/invites/:id/respond', async (c) => {
	const inviteId = c.req.param('id');
	const { action } = await c.req.json<{ action: 'accept' | 'decline' }>();

	const invite = await db.select().from(groupInvites).where(eq(groupInvites.id, inviteId)).get();
	if (!invite || invite.status !== 'pending') {
		return c.json({ error: 'Invalid invite' }, 400);
	}

	if (action === 'accept') {
		await db.update(groupInvites).set({ status: 'accepted' }).where(eq(groupInvites.id, inviteId));
		await db.insert(groupMembers).values({
			id: nanoid(),
			groupId: invite.groupId,
			did: invite.inviteeDid,
			role: 'member',
		});
		const name = await getDisplayName(invite.inviteeDid);
		await broadcastSystemMessage(invite.groupId, `${name} joined the group`);

		// Notify all existing members that someone joined — any member with the key can redistribute
		const allMembers = await db.select({ did: groupMembers.did })
			.from(groupMembers)
			.where(eq(groupMembers.groupId, invite.groupId))
			.all();
		for (const m of allMembers) {
			if (m.did === invite.inviteeDid) continue;
			const ws = wsClients.get(m.did);
			if (ws) {
				ws.send(JSON.stringify({ type: 'member_joined', groupId: invite.groupId, memberDid: invite.inviteeDid }));
			}
		}

		return c.json({ ok: true, groupId: invite.groupId });
	} else {
		await db.update(groupInvites).set({ status: 'declined' }).where(eq(groupInvites.id, inviteId));
		return c.json({ ok: true });
	}
});

/**
 * POST /groups/:id/leave
 * Leave a group. Admins must transfer admin role first (or be the last member).
 */
groupRoutes.post('/:id/leave', async (c) => {
	const groupId = c.req.param('id');
	const { did } = await c.req.json<{ did: string }>();

	// Check if the user is admin
	const member = await db.select()
		.from(groupMembers)
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.did, did)))
		.get();

	if (member?.role === 'admin') {
		// Count remaining members (excluding self)
		const allMembers = db.select({ did: groupMembers.did })
			.from(groupMembers)
			.where(eq(groupMembers.groupId, groupId))
			.all();
		const others = allMembers.filter(m => m.did !== did);

		if (others.length > 0) {
			// Check if there's another admin
			const allAdmins = db.select()
				.from(groupMembers)
				.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.role, 'admin')))
				.all();
			const otherAdmins = allAdmins.filter(m => m.did !== did);

			if (otherAdmins.length === 0) {
				return c.json({ error: 'Transfer admin to another member before leaving' }, 400);
			}
		}
		// Last member or another admin exists — ok to leave
	}

	const name = await getDisplayName(did);
	await db.delete(groupMembers)
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.did, did)));

	// Notify remaining members so their member list updates
	const remaining = await db.select({ did: groupMembers.did })
		.from(groupMembers)
		.where(eq(groupMembers.groupId, groupId))
		.all();
	for (const m of remaining) {
		const ws = wsClients.get(m.did);
		if (ws) {
			ws.send(JSON.stringify({ type: 'member_removed', groupId, targetDid: did }));
		}
	}
	await broadcastSystemMessage(groupId, `${name} left the group`);

	return c.json({ ok: true });
});

/**
 * POST /groups/:id/transfer-admin
 * Transfer admin role to another member.
 */
groupRoutes.post('/:id/transfer-admin', async (c) => {
	const groupId = c.req.param('id');
	const { did, targetDid } = await c.req.json<{ did: string; targetDid: string }>();

	// Verify caller is admin
	const caller = await db.select()
		.from(groupMembers)
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.did, did)))
		.get();
	if (!caller || caller.role !== 'admin') {
		return c.json({ error: 'Not authorized' }, 403);
	}

	// Verify target is a member
	const target = await db.select()
		.from(groupMembers)
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.did, targetDid)))
		.get();
	if (!target) {
		return c.json({ error: 'Target is not a member' }, 400);
	}

	// Promote target to admin
	await db.update(groupMembers)
		.set({ role: 'admin' })
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.did, targetDid)));

	// Demote caller to member
	await db.update(groupMembers)
		.set({ role: 'member' })
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.did, did)));

	const targetName = await getDisplayName(targetDid);
	await broadcastSystemMessage(groupId, `${targetName} is now the group admin`);

	// Notify all members to refresh their member list (roles changed).
	// Use 'role_changed' — NOT 'member_joined' — to avoid triggering unnecessary
	// key redistribution which adds latency and 403 errors during leave.
	const allMembers = await db.select({ did: groupMembers.did })
		.from(groupMembers)
		.where(eq(groupMembers.groupId, groupId))
		.all();
	for (const m of allMembers) {
		const ws = wsClients.get(m.did);
		if (ws) {
			ws.send(JSON.stringify({ type: 'role_changed', groupId, memberDid: targetDid }));
		}
	}

	return c.json({ ok: true });
});

/**
 * POST /groups/:id/kick
 * Remove a member from the group (admin only).
 */
groupRoutes.post('/:id/kick', async (c) => {
	const groupId = c.req.param('id');
	const { did, targetDid } = await c.req.json<{ did: string; targetDid: string }>();

	// Verify caller is admin
	const caller = await db.select()
		.from(groupMembers)
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.did, did)))
		.get();
	if (!caller || caller.role !== 'admin') {
		return c.json({ error: 'Not authorized' }, 403);
	}

	// Can't kick yourself
	if (did === targetDid) {
		return c.json({ error: 'Use leave instead' }, 400);
	}

	await db.delete(groupMembers)
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.did, targetDid)));

	// Notify the kicked user via WebSocket so their UI updates
	const kickedWs = wsClients.get(targetDid);
	if (kickedWs) {
		kickedWs.send(JSON.stringify({ type: 'kicked', groupId }));
	}

	// Notify remaining members so their member list updates + system message
	const targetName = await getDisplayName(targetDid);
	const remaining = await db.select({ did: groupMembers.did })
		.from(groupMembers)
		.where(eq(groupMembers.groupId, groupId))
		.all();
	for (const m of remaining) {
		const ws = wsClients.get(m.did);
		if (ws) {
			ws.send(JSON.stringify({ type: 'member_removed', groupId, targetDid }));
			ws.send(JSON.stringify({ type: 'system_message', groupId, text: `${targetName} was removed from the group` }));
		}
	}

	return c.json({ ok: true });
});

// --- Invite Links (Signal-style: key in URL fragment, server stores hash only) ---

/**
 * POST /groups/:id/invite-link
 * Set or rotate the invite link hash. Client generates the key, hashes it, sends the hash.
 */
groupRoutes.post('/:id/invite-link', async (c) => {
	const groupId = c.req.param('id');
	const { did, inviteKeyHash, maxUses, expiresInHours } = await c.req.json<{
		did: string;
		inviteKeyHash: string;
		maxUses?: number | null;
		expiresInHours?: number | null;
	}>();

	// Verify caller is a member
	const member = await db.select()
		.from(groupMembers)
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.did, did)))
		.get();
	if (!member) return c.json({ error: 'Not a group member' }, 403);
	if (member.role !== 'admin') return c.json({ error: 'Only admins can create invite links' }, 403);

	const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000) : null;

	await db.update(groups)
		.set({
			inviteLinkHash: inviteKeyHash,
			inviteLinkMaxUses: maxUses ?? null,
			inviteLinkUsedCount: 0,
			inviteLinkExpiresAt: expiresAt,
		})
		.where(eq(groups.id, groupId));

	return c.json({ ok: true });
});

/**
 * POST /groups/:id/join
 * Join a group via invite key. Server hashes the provided key and compares.
 */
groupRoutes.post('/:id/join', async (c) => {
	const groupId = c.req.param('id');
	const { did, inviteKey } = await c.req.json<{ did: string; inviteKey: string }>();

	const group = await db.select().from(groups).where(eq(groups.id, groupId)).get();
	if (!group) return c.json({ error: 'Group not found' }, 404);
	if (!group.inviteLinkHash) return c.json({ error: 'No invite link active' }, 403);

	// Check expiration
	if (group.inviteLinkExpiresAt && new Date(group.inviteLinkExpiresAt) < new Date()) {
		return c.json({ error: 'This invite link has expired' }, 403);
	}

	// Check usage limit
	if (group.inviteLinkMaxUses && (group.inviteLinkUsedCount ?? 0) >= group.inviteLinkMaxUses) {
		return c.json({ error: 'This invite link has reached its usage limit' }, 403);
	}

	// Verify the key
	const hash = await sha256Hex(inviteKey);
	if (hash !== group.inviteLinkHash) {
		return c.json({ error: 'Invalid invite key' }, 403);
	}

	// Check if already a member
	const existing = await db.select()
		.from(groupMembers)
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.did, did)))
		.get();
	if (existing) return c.json({ ok: true, groupId, alreadyMember: true });

	// Add as member
	await db.insert(groupMembers).values({
		id: nanoid(),
		groupId,
		did,
		role: 'member',
	});

	// Increment usage count
	await db.update(groups)
		.set({ inviteLinkUsedCount: (group.inviteLinkUsedCount ?? 0) + 1 })
		.where(eq(groups.id, groupId));

	const name = await getDisplayName(did);
	await broadcastSystemMessage(groupId, `${name} joined the group`);

	// Notify all existing members that someone joined — any member with the key can redistribute
	const allMembers = await db.select({ did: groupMembers.did })
		.from(groupMembers)
		.where(eq(groupMembers.groupId, groupId))
		.all();
	for (const m of allMembers) {
		if (m.did === did) continue; // skip the new member themselves
		const ws = wsClients.get(m.did);
		if (ws) {
			ws.send(JSON.stringify({ type: 'member_joined', groupId, memberDid: did }));
		}
	}

	return c.json({ ok: true, groupId });
});

/**
 * DELETE /groups/:id/invite-link
 * Revoke the invite link (admin/creator only).
 */
groupRoutes.delete('/:id/invite-link', async (c) => {
	const groupId = c.req.param('id');
	const { did } = await c.req.json<{ did: string }>();

	const member = await db.select()
		.from(groupMembers)
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.did, did)))
		.get();
	if (!member || member.role !== 'admin') {
		return c.json({ error: 'Not authorized' }, 403);
	}

	await db.update(groups)
		.set({ inviteLinkHash: null })
		.where(eq(groups.id, groupId));

	return c.json({ ok: true });
});

// --- Join Requests ---

/**
 * POST /groups/:id/request-join
 * Request to join a group (e.g. after being kicked).
 */
groupRoutes.post('/:id/request-join', async (c) => {
	const groupId = c.req.param('id');
	const { did } = await c.req.json<{ did: string }>();

	const group = await db.select().from(groups).where(eq(groups.id, groupId)).get();
	if (!group) return c.json({ error: 'Group not found' }, 404);

	// Check if already a member
	const existing = await db.select()
		.from(groupMembers)
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.did, did)))
		.get();
	if (existing) return c.json({ ok: true, alreadyMember: true });

	// Check for existing pending request
	const existingRequest = await db.select()
		.from(groupInvites)
		.where(and(
			eq(groupInvites.groupId, groupId),
			eq(groupInvites.inviteeDid, did),
			eq(groupInvites.status, 'requested')
		))
		.get();
	if (existingRequest) return c.json({ ok: true, alreadyRequested: true });

	await db.insert(groupInvites).values({
		id: nanoid(),
		groupId,
		inviterDid: did,
		inviteeDid: did,
		status: 'requested',
	});

	// Notify admins via WebSocket
	const admins = await db.select({ did: groupMembers.did })
		.from(groupMembers)
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.role, 'admin')))
		.all();

	const requester = await db.select({ displayName: profiles.displayName })
		.from(profiles).where(eq(profiles.did, did)).get();

	for (const admin of admins) {
		const ws = wsClients.get(admin.did);
		if (ws) {
			ws.send(JSON.stringify({
				type: 'join_request',
				groupId,
				requesterDid: did,
				requesterName: requester?.displayName ?? did.slice(-8),
			}));
		}
	}

	return c.json({ ok: true });
});

/**
 * GET /groups/:id/join-requests
 * List pending join requests for a group (admin only).
 */
groupRoutes.get('/:id/join-requests', async (c) => {
	const groupId = c.req.param('id');
	const did = c.req.query('did');
	if (!did) return c.json({ error: 'did required' }, 400);

	const caller = await db.select()
		.from(groupMembers)
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.did, did)))
		.get();
	if (!caller || caller.role !== 'admin') {
		return c.json({ error: 'Not authorized' }, 403);
	}

	const requests = await db.select()
		.from(groupInvites)
		.where(and(eq(groupInvites.groupId, groupId), eq(groupInvites.status, 'requested')))
		.all();

	const result = [];
	for (const req of requests) {
		const profile = await db.select({ displayName: profiles.displayName })
			.from(profiles).where(eq(profiles.did, req.inviteeDid)).get();
		result.push({
			id: req.id,
			did: req.inviteeDid,
			displayName: profile?.displayName ?? 'unknown',
			createdAt: req.createdAt,
		});
	}

	return c.json(result);
});

/**
 * POST /groups/:id/join-requests/:requestId/respond
 * Approve or deny a join request (admin only).
 */
groupRoutes.post('/:id/join-requests/:requestId/respond', async (c) => {
	const groupId = c.req.param('id');
	const requestId = c.req.param('requestId');
	const { did, action } = await c.req.json<{ did: string; action: 'approve' | 'deny' }>();

	const caller = await db.select()
		.from(groupMembers)
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.did, did)))
		.get();
	if (!caller || caller.role !== 'admin') {
		return c.json({ error: 'Not authorized' }, 403);
	}

	const request = await db.select().from(groupInvites).where(eq(groupInvites.id, requestId)).get();
	if (!request || request.status !== 'requested') {
		return c.json({ error: 'Invalid request' }, 400);
	}

	if (action === 'approve') {
		await db.update(groupInvites).set({ status: 'accepted' }).where(eq(groupInvites.id, requestId));
		await db.insert(groupMembers).values({
			id: nanoid(),
			groupId,
			did: request.inviteeDid,
			role: 'member',
		});

		const ws = wsClients.get(request.inviteeDid);
		if (ws) {
			ws.send(JSON.stringify({ type: 'join_approved', groupId }));
		}

		const name = await getDisplayName(request.inviteeDid);
		await broadcastSystemMessage(groupId, `${name} joined the group`);

		// Notify existing members so they redistribute sender keys + update member list
		const allMembers = await db.select({ did: groupMembers.did })
			.from(groupMembers)
			.where(eq(groupMembers.groupId, groupId))
			.all();
		for (const m of allMembers) {
			if (m.did === request.inviteeDid) continue;
			const mws = wsClients.get(m.did);
			if (mws) {
				mws.send(JSON.stringify({ type: 'member_joined', groupId, memberDid: request.inviteeDid }));
			}
		}

		return c.json({ ok: true });
	} else {
		await db.update(groupInvites).set({ status: 'declined' }).where(eq(groupInvites.id, requestId));

		const ws = wsClients.get(request.inviteeDid);
		if (ws) {
			ws.send(JSON.stringify({ type: 'join_denied', groupId }));
		}

		return c.json({ ok: true });
	}
});

// --- Group Encryption Keys ---

/**
 * POST /groups/:id/keys
 * Store wrapped group keys for members (called by key creator/rotator).
 */
groupRoutes.post('/:id/keys', async (c) => {
	const groupId = c.req.param('id');
	const { senderDid, keys, epoch } = await c.req.json<{
		senderDid: string;
		keys: Array<{ memberDid: string; wrappedKey: string; wrappedKeyNonce: string }>;
		epoch: number;
	}>();

	if (!senderDid || !keys || !Array.isArray(keys) || epoch === undefined) {
		return c.json({ error: 'senderDid, keys[], and epoch required' }, 400);
	}

	// Verify sender is a member
	const isMember = await db.select()
		.from(groupMembers)
		.where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.did, senderDid)))
		.get();
	if (!isMember) {
		return c.json({ error: 'Not a group member' }, 403);
	}

	// Store each wrapped key
	for (const k of keys) {
		await db.insert(groupKeys).values({
			id: nanoid(),
			groupId,
			memberDid: k.memberDid,
			wrappedKey: k.wrappedKey,
			wrappedKeyNonce: k.wrappedKeyNonce,
			senderDid,
			epoch,
		});
	}

	return c.json({ ok: true });
});

/**
 * GET /groups/:id/keys/:did
 * Get all wrapped keys for a member across all epochs.
 */
groupRoutes.get('/:id/keys/:did', async (c) => {
	const groupId = c.req.param('id');
	const did = c.req.param('did');

	const keys = await db.select()
		.from(groupKeys)
		.where(and(eq(groupKeys.groupId, groupId), eq(groupKeys.memberDid, did)))
		.all();

	return c.json(keys);
});
