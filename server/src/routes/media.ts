import { Hono } from 'hono';
import { db } from '../db';
import { media, deliveryTokens, groupDeliveryTokens, groupMembers } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';

export const mediaRoutes = new Hono();

/**
 * POST /media/upload
 * Upload an encrypted media blob.
 * The file is already encrypted client-side — the server stores opaque bytes.
 */
mediaRoutes.post('/upload', async (c) => {
	const formData = await c.req.formData();
	const file = formData.get('file') as File | null;
	const uploaderDid = formData.get('uploaderDid') as string | null;
	const mediaKeyWrapped = formData.get('mediaKeyWrapped') as string | null;
	const mimeType = formData.get('mimeType') as string | null;
	const viewOnce = formData.get('viewOnce') === 'true';
	const groupId = formData.get('groupId') as string | null;

	if (!file || !uploaderDid || !mimeType) {
		return c.json({ error: 'file, uploaderDid, and mimeType required' }, 400);
	}

	const id = nanoid();
	const buffer = await file.arrayBuffer();
	const encryptedBlob = new Uint8Array(buffer);

	await db.insert(media).values({
		id,
		uploaderDid,
		encryptedBlob: Buffer.from(encryptedBlob),
		mediaKeyWrapped: mediaKeyWrapped ?? '',
		mimeType,
		size: encryptedBlob.length,
		viewOnce,
		groupId: groupId ?? null,
		viewedBy: null,
		expiresAt: viewOnce ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null,
	});

	return c.json({ ok: true, mediaId: id });
});

/**
 * POST /media/upload-sealed
 * Upload an encrypted media blob without revealing uploaderDid.
 * Authenticates via delivery token instead.
 */
mediaRoutes.post('/upload-sealed', async (c) => {
	const formData = await c.req.formData();
	const file = formData.get('file') as File | null;
	const deliveryToken = formData.get('deliveryToken') as string | null;
	const mimeType = formData.get('mimeType') as string | null;
	const viewOnce = formData.get('viewOnce') === 'true';
	const groupId = formData.get('groupId') as string | null;

	if (!file || !deliveryToken || !mimeType) {
		return c.json({ error: 'file, deliveryToken, and mimeType required' }, 400);
	}

	// Validate delivery token — check both DM and group token tables
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(deliveryToken);
	const tokenHash = hasher.digest('hex');
	const dmToken = await db.select().from(deliveryTokens).where(eq(deliveryTokens.tokenHash, tokenHash)).get();
	const groupToken = await db.select().from(groupDeliveryTokens).where(eq(groupDeliveryTokens.tokenHash, tokenHash)).get();
	if (!dmToken && !groupToken) {
		return c.json({ error: 'invalid delivery token' }, 403);
	}

	const id = nanoid();
	const buffer = await file.arrayBuffer();
	const encryptedBlob = new Uint8Array(buffer);

	await db.insert(media).values({
		id,
		uploaderDid: null, // Anonymous — no DID stored for sealed uploads
		encryptedBlob: Buffer.from(encryptedBlob),
		mediaKeyWrapped: '',
		mimeType,
		size: encryptedBlob.length,
		viewOnce,
		groupId: groupId ?? null,
		viewedBy: null,
		expiresAt: viewOnce ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null,
	});

	return c.json({ ok: true, mediaId: id });
});

/**
 * GET /media/:id
 * Download an encrypted media blob.
 */
mediaRoutes.get('/:id', async (c) => {
	const id = c.req.param('id');
	const item = await db.select().from(media).where(eq(media.id, id)).get();

	if (!item) {
		return c.json({ error: 'Media not found' }, 404);
	}

	// Return metadata + encrypted blob
	return c.json({
		id: item.id,
		uploaderDid: item.uploaderDid,
		mediaKeyWrapped: item.mediaKeyWrapped,
		mimeType: item.mimeType,
		size: item.size,
		// Return encrypted blob as base64
		encryptedBlob: item.encryptedBlob
			? Buffer.from(item.encryptedBlob as any).toString('base64')
			: null,
	});
});

/**
 * GET /media/:id/blob
 * Download raw encrypted blob as binary.
 */
mediaRoutes.get('/:id/blob', async (c) => {
	const id = c.req.param('id');
	const item = await db.select().from(media).where(eq(media.id, id)).get();

	if (!item || !item.encryptedBlob) {
		return c.json({ error: 'Media not found' }, 404);
	}

	// Check if expired view-once media
	if (item.viewOnce && item.expiresAt && new Date(item.expiresAt) < new Date()) {
		return c.json({ error: 'Media expired' }, 410);
	}

	const cacheControl = item.viewOnce ? 'no-store' : 'public, max-age=3600';

	return new Response(item.encryptedBlob as any, {
		headers: {
			'Content-Type': item.mimeType || 'application/octet-stream',
			'Content-Length': String(item.size),
			'Cache-Control': cacheControl,
		}
	});
});

/**
 * DELETE /media/:id
 * Delete a media item (only by uploader).
 */
mediaRoutes.delete('/:id', async (c) => {
	const id = c.req.param('id');
	const { did } = await c.req.json<{ did: string }>();

	const item = await db.select().from(media).where(eq(media.id, id)).get();
	if (!item) return c.json({ error: 'Not found' }, 404);
	if (item.uploaderDid !== did) return c.json({ error: 'Unauthorized' }, 403);

	await db.delete(media).where(eq(media.id, id));
	return c.json({ ok: true });
});

/**
 * POST /media/:id/viewed
 * Mark view-once media as viewed.
 * For DMs: deletes the blob immediately.
 * For groups: tracks per-member views, only deletes when all members have viewed.
 */
mediaRoutes.post('/:id/viewed', async (c) => {
	const id = c.req.param('id');
	const { did } = await c.req.json<{ did: string }>();

	const item = await db.select().from(media).where(eq(media.id, id)).get();
	if (!item) return c.json({ ok: true }); // Already gone

	if (!item.viewOnce) return c.json({ ok: true });

	if (item.groupId) {
		// Group view-once: track this viewer, delete only when all non-uploader members have viewed
		const viewed: string[] = item.viewedBy ? JSON.parse(item.viewedBy) : [];
		if (!viewed.includes(did)) {
			viewed.push(did);
		}

		// Get total group member count
		const members = await db.select({ did: groupMembers.did })
			.from(groupMembers)
			.where(eq(groupMembers.groupId, item.groupId))
			.all();

		// For sealed uploads (uploaderDid is null), we don't know who uploaded.
		// The uploader never calls "viewed" on their own media, so we check:
		// viewed count >= total members - 1 (everyone except the uploader)
		const requiredViews = item.uploaderDid
			? members.filter(m => m.did !== item.uploaderDid).length
			: members.length - 1; // Assume 1 member is the uploader

		if (viewed.length >= requiredViews) {
			// Everyone has viewed — delete the blob
			await db.delete(media).where(eq(media.id, id));
		} else {
			// Update the viewedBy list
			await db.update(media).set({ viewedBy: JSON.stringify(viewed) }).where(eq(media.id, id));
		}
	} else {
		// DM view-once: delete immediately (only 2 parties)
		await db.delete(media).where(eq(media.id, id));
	}

	return c.json({ ok: true });
});
