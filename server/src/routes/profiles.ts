import { Hono } from 'hono';
import { db } from '../db';
import { profiles, blocks } from '../db/schema';
import { eq, sql } from 'drizzle-orm';

export const profileRoutes = new Hono();

/**
 * GET /profiles/discover?cells=hash1,hash2,...&requesterDid=...
 * Returns profiles in the requested geohash cells.
 * Filters out blocked users if requesterDid is provided.
 */
profileRoutes.get('/discover', async (c) => {
	const cellsParam = c.req.query('cells');
	const requesterDid = c.req.query('requesterDid');

	if (!cellsParam) {
		return c.json({ error: 'cells parameter required' }, 400);
	}

	const cells = cellsParam.split(',').map(s => s.trim()).filter(Boolean);
	if (cells.length === 0 || cells.length > 100) {
		return c.json({ error: 'Provide 1-100 cells' }, 400);
	}

	// Get blocked DIDs for the requester
	let blockedDids: Set<string> = new Set();
	if (requesterDid) {
		const blockRows = await db.select({ blockedDid: blocks.blockedDid })
			.from(blocks)
			.where(eq(blocks.blockerDid, requesterDid))
			.all();
		blockedDids = new Set(blockRows.map(b => b.blockedDid));

		// Also get users who blocked the requester (mutual block)
		const reverseBlockRows = await db.select({ blockerDid: blocks.blockerDid })
			.from(blocks)
			.where(eq(blocks.blockedDid, requesterDid))
			.all();
		for (const b of reverseBlockRows) blockedDids.add(b.blockerDid);
	}

	const allProfiles = await db.select({
		did: profiles.did,
		displayName: profiles.displayName,
		bio: profiles.bio,
		age: profiles.age,
		boxPublicKey: profiles.boxPublicKey,
		avatarMediaId: profiles.avatarMediaId,
		avatarKey: profiles.avatarKey,
		avatarNonce: profiles.avatarNonce,
		instagram: profiles.instagram,
		profileLink: profiles.profileLink,
		geohashCells: profiles.geohashCells,
		lastSeen: profiles.lastSeen
	}).from(profiles).all();

	// Hide profiles not seen in over 24 hours
	const staleThreshold = Date.now() - 24 * 60 * 60 * 1000;

	const matching = allProfiles.filter(p => {
		if (!p.geohashCells) return false;
		if (blockedDids.has(p.did)) return false;
		// Filter out stale profiles
		if (p.lastSeen) {
			const lastSeenMs = p.lastSeen instanceof Date ? p.lastSeen.getTime() : Number(p.lastSeen) * 1000;
			if (lastSeenMs < staleThreshold) return false;
		}
		try {
			const profileCells: string[] = JSON.parse(p.geohashCells);
			// Support prefix matching: a query cell "gcpuu" (precision 5) matches profile cell "gcpuuz1" (precision 7)
			return profileCells.some(pc => cells.some(qc => pc.startsWith(qc) || qc.startsWith(pc)));
		} catch {
			return false;
		}
	});

	const results = matching.map(p => {
		const profileCells: string[] = JSON.parse(p.geohashCells!);
		const matchedCell = profileCells.find(pc => cells.some(qc => pc.startsWith(qc) || qc.startsWith(pc))) ?? profileCells[0];
		return {
			did: p.did,
			displayName: p.displayName,
			bio: p.bio,
			age: p.age,
			boxPublicKey: p.boxPublicKey,
			avatarMediaId: p.avatarMediaId,
			avatarKey: p.avatarKey,
			avatarNonce: p.avatarNonce,
			instagram: p.instagram,
			profileLink: p.profileLink,
			geohashCell: matchedCell,
			lastSeen: p.lastSeen
		};
	});

	return c.json(results);
});

/**
 * GET /profiles/search?q=name&requesterDid=...
 * Search profiles by display name (case-insensitive substring match).
 */
profileRoutes.get('/search', async (c) => {
	const q = c.req.query('q')?.trim();
	const requesterDid = c.req.query('requesterDid');
	if (!q || q.length < 1) {
		return c.json([]);
	}

	let blockedDids: Set<string> = new Set();
	if (requesterDid) {
		const blockRows = await db.select({ blockedDid: blocks.blockedDid })
			.from(blocks)
			.where(eq(blocks.blockerDid, requesterDid))
			.all();
		blockedDids = new Set(blockRows.map(b => b.blockedDid));
		const reverseBlockRows = await db.select({ blockerDid: blocks.blockerDid })
			.from(blocks)
			.where(eq(blocks.blockedDid, requesterDid))
			.all();
		for (const b of reverseBlockRows) blockedDids.add(b.blockerDid);
	}

	const allProfiles = await db.select({
		did: profiles.did,
		displayName: profiles.displayName,
		boxPublicKey: profiles.boxPublicKey,
	}).from(profiles).all();

	const lowerQ = q.toLowerCase();
	const results = allProfiles.filter(p => {
		if (requesterDid && p.did === requesterDid) return false;
		if (blockedDids.has(p.did)) return false;
		return p.displayName.toLowerCase().includes(lowerQ);
	}).slice(0, 20);

	return c.json(results);
});

/**
 * GET /profiles/:did
 */
profileRoutes.get('/:did', async (c) => {
	const did = c.req.param('did');
	const profile = await db.select().from(profiles).where(eq(profiles.did, did)).get();

	if (!profile) {
		return c.json({ error: 'Profile not found' }, 404);
	}

	return c.json(profile);
});

/**
 * PUT /profiles/:did
 */
profileRoutes.put('/:did', async (c) => {
	const did = c.req.param('did');
	const body = await c.req.json<{
		displayName?: string;
		bio?: string;
		age?: number;
		signedProfileBlob?: string;
		geohashCells?: string[];
		avatarMediaId?: string;
		avatarKey?: string;
		avatarNonce?: string;
		instagram?: string;
		profileLink?: string;
	}>();

	await db.update(profiles).set({
		...(body.displayName && { displayName: body.displayName }),
		...(body.bio !== undefined && { bio: body.bio }),
		...(body.age !== undefined && { age: body.age }),
		...(body.signedProfileBlob && { signedProfileBlob: body.signedProfileBlob }),
		...(body.geohashCells && { geohashCells: JSON.stringify(body.geohashCells) }),
		...(body.avatarMediaId && { avatarMediaId: body.avatarMediaId }),
		...(body.avatarKey !== undefined && { avatarKey: body.avatarKey }),
		...(body.avatarNonce !== undefined && { avatarNonce: body.avatarNonce }),
		...(body.instagram !== undefined && { instagram: body.instagram }),
		...(body.profileLink !== undefined && { profileLink: body.profileLink }),
		lastSeen: new Date()
	}).where(eq(profiles.did, did));

	return c.json({ ok: true });
});

/**
 * DELETE /profiles/:did
 * Remove a profile from the server.
 */
profileRoutes.delete('/:did', async (c) => {
	const did = c.req.param('did');
	// Clean up related data first (foreign key constraints)
	const sqliteDb = (db as any).$client;
	sqliteDb.exec(`DELETE FROM group_members WHERE did = '${did.replace(/'/g, "''")}'`);
	sqliteDb.exec(`DELETE FROM group_invites WHERE inviter_did = '${did.replace(/'/g, "''")}' OR invitee_did = '${did.replace(/'/g, "''")}'`);
	sqliteDb.exec(`DELETE FROM blocks WHERE blocker_did = '${did.replace(/'/g, "''")}' OR blocked_did = '${did.replace(/'/g, "''")}'`);
	sqliteDb.exec(`DELETE FROM reports WHERE reporter_did = '${did.replace(/'/g, "''")}' OR reported_did = '${did.replace(/'/g, "''")}'`);
	sqliteDb.exec(`DELETE FROM encrypted_messages WHERE sender_did = '${did.replace(/'/g, "''")}' OR recipient_did = '${did.replace(/'/g, "''")}'`);
	sqliteDb.exec(`DELETE FROM key_packages WHERE did = '${did.replace(/'/g, "''")}'`);
	await db.delete(profiles).where(eq(profiles.did, did));
	return c.json({ ok: true });
});
