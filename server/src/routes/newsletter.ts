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

	const authHeader = 'Basic ' + btoa(`${adminUser}:${adminPass}`);
	const headers = { 'Content-Type': 'application/json', 'Authorization': authHeader };

	try {
		// Step 1: Create subscriber
		const res = await fetch(`${listmonkUrl}/api/subscribers`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				email,
				name: name || 'User',
				status: 'enabled',
				lists: [3]
			})
		});

		if (!res.ok) {
			const body = await res.text();
			console.error('[newsletter] Listmonk create error:', res.status, body);
		} else {
			// Step 2: Add subscriber to list (Listmonk v6 ignores lists on create)
			const { data } = await res.json() as { data: { id: number } };
			const listRes = await fetch(`${listmonkUrl}/api/subscribers/lists`, {
				method: 'PUT',
				headers,
				body: JSON.stringify({
					ids: [data.id],
					action: 'add',
					target_list_ids: [3],
					status: 'confirmed'
				})
			});
			if (!listRes.ok) {
				const body = await listRes.text();
				console.error('[newsletter] Listmonk list-add error:', listRes.status, body);
			}
		}
	} catch (err) {
		console.error('[newsletter] Failed to reach Listmonk:', err);
	}

	// Always return ok — don't block signup if Listmonk fails
	return c.json({ ok: true });
});
