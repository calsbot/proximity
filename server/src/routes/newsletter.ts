import { Hono } from 'hono';

export const newsletterRoutes = new Hono();

/**
 * POST /newsletter/subscribe
 * Proxies email subscription to Listmonk.
 * If Listmonk is not configured or fails, logs the error but doesn't block signup.
 */
newsletterRoutes.post('/subscribe', async (c) => {
	const { email, name } = await c.req.json<{ email: string; name: string }>();

	if (!email) {
		return c.json({ error: 'email required' }, 400);
	}

	const listmonkUrl = process.env.LISTMONK_API_URL || 'http://localhost:9000';
	const adminUser = process.env.LISTMONK_ADMIN_USER || 'admin';
	const adminPass = process.env.LISTMONK_ADMIN_PASSWORD || 'admin';

	try {
		const res = await fetch(`${listmonkUrl}/api/subscribers`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': 'Basic ' + btoa(`${adminUser}:${adminPass}`)
			},
			body: JSON.stringify({
				email,
				name: name || 'User',
				status: 'enabled',
				lists: [1] // Default list ID
			})
		});

		if (!res.ok) {
			const body = await res.text();
			console.error('[newsletter] Listmonk error:', res.status, body);
		}
	} catch (err) {
		console.error('[newsletter] Failed to reach Listmonk:', err);
	}

	// Always return ok — don't block signup if Listmonk fails
	return c.json({ ok: true });
});
