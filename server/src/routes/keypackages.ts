import { Hono } from 'hono';
import { db } from '../db';
import { keyPackages } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';

export const keyPackageRoutes = new Hono();

/**
 * POST /key-packages
 * Upload new KeyPackages for async key exchange.
 */
keyPackageRoutes.post('/', async (c) => {
	const body = await c.req.json<{
		did: string;
		keyPackages: string[]; // base64 serialized KeyPackages
	}>();

	const ids: string[] = [];
	for (const blob of body.keyPackages) {
		const id = nanoid();
		await db.insert(keyPackages).values({
			id,
			did: body.did,
			keyPackageBlob: blob
		});
		ids.push(id);
	}

	return c.json({ ok: true, ids });
});

/**
 * GET /key-packages/:did
 * Consume one KeyPackage for the given DID (for starting a conversation).
 */
keyPackageRoutes.get('/:did', async (c) => {
	const did = c.req.param('did');

	const pkg = await db.select()
		.from(keyPackages)
		.where(and(eq(keyPackages.did, did), eq(keyPackages.consumed, false)))
		.limit(1)
		.get();

	if (!pkg) {
		return c.json({ error: 'No key packages available' }, 404);
	}

	// Mark as consumed
	await db.update(keyPackages)
		.set({ consumed: true })
		.where(eq(keyPackages.id, pkg.id));

	return c.json({ id: pkg.id, keyPackageBlob: pkg.keyPackageBlob });
});
