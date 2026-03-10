import { Hono } from 'hono';
import { db } from '../db';
import { media, deliveryTokens } from '../db/schema';
import { eq } from 'drizzle-orm';
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

	if (!file || !deliveryToken || !mimeType) {
		return c.json({ error: 'file, deliveryToken, and mimeType required' }, 400);
	}

	// Validate delivery token
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(deliveryToken);
	const tokenHash = hasher.digest('hex');
	const token = await db.select().from(deliveryTokens).where(eq(deliveryTokens.tokenHash, tokenHash)).get();
	if (!token) {
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
 * Mark view-once media as viewed — deletes the blob from server.
 */
mediaRoutes.post('/:id/viewed', async (c) => {
	const id = c.req.param('id');
	const { did } = await c.req.json<{ did: string }>();

	const item = await db.select().from(media).where(eq(media.id, id)).get();
	if (!item) return c.json({ ok: true }); // Already gone

	if (item.viewOnce) {
		await db.delete(media).where(eq(media.id, id));
	}

	return c.json({ ok: true });
});
