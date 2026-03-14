import { Hono } from 'hono';
import { db } from '../db';
import { profiles, blocks, flagThrottles } from '../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';

export const profileRoutes = new Hono();

/**
 * GET /profiles/discover?cells=hash1,hash2,...&requesterDid=...
 * Returns profiles in the requested geohash cells.
 * Filters out blocked users if requesterDid is provided.
 */
profileRoutes.get('/discover', async (c) => {
	const cellsParam = c.req.query('cells');
	const requesterDid = c.req.query('requesterDid');
	const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200);
	const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0;

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
		tags: profiles.tags,
		profileKey: profiles.profileKey,
		encryptedFields: profiles.encryptedFields,
		encryptedFieldsNonce: profiles.encryptedFieldsNonce,
		geohashCells: profiles.geohashCells,
		lastSeen: profiles.lastSeen
	}).from(profiles).all();

	// Get hidden profiles (flagged with level = 'hidden')
	const hiddenProfiles = await db.select({ did: flagThrottles.did })
		.from(flagThrottles).where(eq(flagThrottles.level, 'hidden')).all();
	const hiddenDids = new Set(hiddenProfiles.map(h => h.did));

	// Hide profiles not seen in over 24 hours
	const staleThreshold = Date.now() - 24 * 60 * 60 * 1000;

	const matching = allProfiles.filter(p => {
		if (!p.geohashCells) return false;
		if (blockedDids.has(p.did)) return false;
		if (hiddenDids.has(p.did)) return false;
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

	// Sort by geohash proximity (longest shared prefix = closest) then by lastSeen as tiebreaker
	// Higher-precision query cells (longer strings) are the requester's actual location
	const queryCellsByLength = [...cells].sort((a, b) => b.length - a.length);

	function proximityScore(profile: typeof matching[0]): number {
		try {
			const profileCells: string[] = JSON.parse(profile.geohashCells!);
			let best = 0;
			for (const pc of profileCells) {
				for (const qc of queryCellsByLength) {
					// Count shared prefix length
					const minLen = Math.min(pc.length, qc.length);
					let shared = 0;
					for (let i = 0; i < minLen; i++) {
						if (pc[i] === qc[i]) shared++;
						else break;
					}
					if (shared > best) best = shared;
					// Early exit — can't do better than this query cell's length
					if (best >= qc.length) return best;
				}
			}
			return best;
		} catch { return 0; }
	}

	// Pre-compute scores to avoid re-calculating during sort
	const scores = new Map<string, number>();
	for (const m of matching) scores.set(m.did, proximityScore(m));

	matching.sort((a, b) => {
		const scoreDiff = (scores.get(b.did) ?? 0) - (scores.get(a.did) ?? 0);
		if (scoreDiff !== 0) return scoreDiff;
		// Tiebreak by lastSeen descending
		const aMs = a.lastSeen instanceof Date ? a.lastSeen.getTime() : Number(a.lastSeen ?? 0) * 1000;
		const bMs = b.lastSeen instanceof Date ? b.lastSeen.getTime() : Number(b.lastSeen ?? 0) * 1000;
		return bMs - aMs;
	});

	const total = matching.length;
	const page = matching.slice(offset, offset + limit);

	const results = page.map(p => {
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
			tags: p.tags ? JSON.parse(p.tags) : [],
			profileKey: p.profileKey,
			encryptedFields: p.encryptedFields,
			encryptedFieldsNonce: p.encryptedFieldsNonce,
			geohashCell: matchedCell,
			lastSeen: p.lastSeen
		};
	});

	return c.json({ profiles: results, total, limit, offset });
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
 * GET /profiles/popular-tags
 */
profileRoutes.get('/popular-tags', async (c) => {
	const rows = await db.select({ tags: profiles.tags }).from(profiles).all();
	const counts = new Map<string, number>();
	for (const row of rows) {
		if (!row.tags) continue;
		try {
			const parsed = JSON.parse(row.tags) as string[];
			for (const t of parsed) {
				const lower = t.toLowerCase();
				counts.set(lower, (counts.get(lower) ?? 0) + 1);
			}
		} catch {}
	}
	const sorted = Array.from(counts.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 20)
		.map(([tag]) => tag);
	return c.json(sorted);
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

	// Parse tags from JSON string for the response
	return c.json({
		...profile,
		tags: profile.tags ? JSON.parse(profile.tags) : [],
	});
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
		tags?: string[];
		signedProfileBlob?: string;
		geohashCells?: string[];
		avatarMediaId?: string;
		avatarKey?: string;
		avatarNonce?: string;
		instagram?: string;
		profileLink?: string;
		profileKey?: string;
		encryptedFields?: string;
		encryptedFieldsNonce?: string;
	}>();

	if (body.age !== undefined && body.age !== null && body.age < 18) {
		return c.json({ error: 'Must be at least 18' }, 400);
	}

	await db.update(profiles).set({
		...(body.displayName && { displayName: body.displayName }),
		...(body.bio !== undefined && { bio: body.bio }),
		...(body.age !== undefined && { age: body.age }),
		...(body.tags !== undefined && { tags: JSON.stringify(body.tags) }),
		...(body.signedProfileBlob && { signedProfileBlob: body.signedProfileBlob }),
		...(body.geohashCells && { geohashCells: JSON.stringify(body.geohashCells) }),
		...(body.avatarMediaId && { avatarMediaId: body.avatarMediaId }),
		...(body.avatarKey !== undefined && { avatarKey: body.avatarKey }),
		...(body.avatarNonce !== undefined && { avatarNonce: body.avatarNonce }),
		...(body.instagram !== undefined && { instagram: body.instagram }),
		...(body.profileLink !== undefined && { profileLink: body.profileLink }),
		...(body.profileKey !== undefined && { profileKey: body.profileKey }),
		...(body.encryptedFields !== undefined && { encryptedFields: body.encryptedFields }),
		...(body.encryptedFieldsNonce !== undefined && { encryptedFieldsNonce: body.encryptedFieldsNonce }),
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
