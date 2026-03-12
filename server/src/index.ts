import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { auth } from './routes/auth';
import { profileRoutes } from './routes/profiles';
import { messageRoutes } from './routes/messages';
import { keyPackageRoutes } from './routes/keypackages';
import { groupRoutes } from './routes/groups';
import { moderationRoutes } from './routes/moderation';
import { mediaRoutes } from './routes/media';
import { newsletterRoutes } from './routes/newsletter';
import { invitationRoutes } from './routes/invitations';
import { pushRoutes, sendPushNotification } from './routes/push';
import { db } from './db';
import { profiles, groupMembers, groups, media, deliveryTokens, sealedMessages, groupDeliveryTokens, pushSubscriptions } from './db/schema';
import { eq, and, lte, or } from 'drizzle-orm';

const app = new Hono();

// CORS — allow dev origins; in production, Caddy serves everything from same origin
app.use('/*', cors({
	origin: (origin) => {
		const devOrigins = ['http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173', 'http://127.0.0.1:4173'];
		if (!origin || devOrigins.includes(origin)) return origin || '*';
		return origin; // Allow any origin (production is same-origin via reverse proxy)
	},
	allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'Authorization']
}));

// Health check
app.get('/', (c) => c.json({
	name: 'proximity-server',
	version: '0.0.2',
	status: 'ok'
}));

// Mount routes
app.route('/auth', auth);
app.route('/profiles', profileRoutes);
app.route('/messages', messageRoutes);
app.route('/key-packages', keyPackageRoutes);
app.route('/groups', groupRoutes);
app.route('/moderation', moderationRoutes);
app.route('/media', mediaRoutes);
app.route('/newsletter', newsletterRoutes);
app.route('/invitations', invitationRoutes);
app.route('/push', pushRoutes);

// --- Serve static frontend in production ---
import { existsSync } from 'fs';
import { join, resolve } from 'path';

const STATIC_DIR = resolve(import.meta.dir, '../../frontend/build');
const isProduction = existsSync(STATIC_DIR);

if (isProduction) {
	console.log(`Serving static files from ${STATIC_DIR}`);
	// Serve static files — check for file first, fall back to index.html (SPA)
	app.get('*', async (c) => {
		const urlPath = new URL(c.req.url).pathname;

		// Skip API routes
		if (urlPath.startsWith('/auth') || urlPath.startsWith('/profiles') || urlPath.startsWith('/messages') ||
			urlPath.startsWith('/key-packages') || urlPath.startsWith('/groups') || urlPath.startsWith('/moderation') ||
			urlPath.startsWith('/media') || urlPath.startsWith('/newsletter') || urlPath.startsWith('/invitations')) {
			return c.notFound();
		}

		// Try to serve the exact file
		const filePath = join(STATIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
		const file = Bun.file(filePath);
		if (await file.exists()) {
			return new Response(file);
		}

		// Try with .html extension
		const htmlPath = filePath + '.html';
		const htmlFile = Bun.file(htmlPath);
		if (await htmlFile.exists()) {
			return new Response(htmlFile);
		}

		// SPA fallback — serve index.html for client-side routing
		const indexFile = Bun.file(join(STATIC_DIR, 'index.html'));
		if (await indexFile.exists()) {
			return new Response(indexFile, {
				headers: { 'Content-Type': 'text/html' }
			});
		}

		return c.notFound();
	});
}

// --- Create tables on startup ---
function initDb() {
	const sqliteDb = (db as any).$client;
	sqliteDb.exec(`
		CREATE TABLE IF NOT EXISTS profiles (
			did TEXT PRIMARY KEY,
			display_name TEXT NOT NULL,
			bio TEXT DEFAULT '',
			age INTEGER,
			public_key TEXT,
			box_public_key TEXT,
			signed_profile_blob TEXT,
			avatar_media_id TEXT,
			geohash_cells TEXT,
			last_seen INTEGER,
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE TABLE IF NOT EXISTS key_packages (
			id TEXT PRIMARY KEY,
			did TEXT NOT NULL REFERENCES profiles(did),
			key_package_blob TEXT NOT NULL,
			consumed INTEGER DEFAULT 0,
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE TABLE IF NOT EXISTS encrypted_messages (
			id TEXT PRIMARY KEY,
			group_id TEXT NOT NULL,
			sender_did TEXT NOT NULL,
			recipient_did TEXT NOT NULL,
			epoch INTEGER NOT NULL,
			ciphertext TEXT NOT NULL,
			nonce TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE TABLE IF NOT EXISTS media (
			id TEXT PRIMARY KEY,
			uploader_did TEXT,
			encrypted_blob BLOB,
			media_key_wrapped TEXT,
			mime_type TEXT NOT NULL,
			size INTEGER NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE TABLE IF NOT EXISTS auth_challenges (
			did TEXT PRIMARY KEY,
			challenge TEXT NOT NULL,
			expires_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS groups (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			creator_did TEXT NOT NULL REFERENCES profiles(did),
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE TABLE IF NOT EXISTS group_members (
			id TEXT PRIMARY KEY,
			group_id TEXT NOT NULL REFERENCES groups(id),
			did TEXT NOT NULL REFERENCES profiles(did),
			role TEXT NOT NULL DEFAULT 'member',
			joined_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE TABLE IF NOT EXISTS group_invites (
			id TEXT PRIMARY KEY,
			group_id TEXT NOT NULL REFERENCES groups(id),
			inviter_did TEXT NOT NULL REFERENCES profiles(did),
			invitee_did TEXT NOT NULL REFERENCES profiles(did),
			status TEXT NOT NULL DEFAULT 'pending',
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE TABLE IF NOT EXISTS blocks (
			id TEXT PRIMARY KEY,
			blocker_did TEXT NOT NULL REFERENCES profiles(did),
			blocked_did TEXT NOT NULL REFERENCES profiles(did),
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE TABLE IF NOT EXISTS reports (
			id TEXT PRIMARY KEY,
			reporter_did TEXT NOT NULL REFERENCES profiles(did),
			reported_did TEXT NOT NULL REFERENCES profiles(did),
			reason TEXT NOT NULL,
			details TEXT DEFAULT '',
			status TEXT NOT NULL DEFAULT 'pending',
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE INDEX IF NOT EXISTS idx_messages_recipient ON encrypted_messages(recipient_did, created_at);
		CREATE INDEX IF NOT EXISTS idx_messages_group ON encrypted_messages(group_id);
		CREATE INDEX IF NOT EXISTS idx_keypackages_did ON key_packages(did, consumed);
		CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
		CREATE INDEX IF NOT EXISTS idx_group_members_did ON group_members(did);
		CREATE INDEX IF NOT EXISTS idx_group_invites_invitee ON group_invites(invitee_did, status);
		CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks(blocker_did);
	`);

	// Add columns to existing databases
	try { sqliteDb.exec('ALTER TABLE profiles ADD COLUMN public_key TEXT'); } catch {}
	try { sqliteDb.exec('ALTER TABLE profiles ADD COLUMN box_public_key TEXT'); } catch {}
	try { sqliteDb.exec('ALTER TABLE profiles ADD COLUMN avatar_media_id TEXT'); } catch {}
	// Double Ratchet header columns
	try { sqliteDb.exec('ALTER TABLE encrypted_messages ADD COLUMN dh_public_key TEXT'); } catch {}
	try { sqliteDb.exec('ALTER TABLE encrypted_messages ADD COLUMN previous_counter INTEGER'); } catch {}
	// Invite link columns on groups
	try { sqliteDb.exec('ALTER TABLE groups ADD COLUMN invite_link_hash TEXT'); } catch {}
	try { sqliteDb.exec('ALTER TABLE groups ADD COLUMN invite_link_max_uses INTEGER'); } catch {}
	try { sqliteDb.exec('ALTER TABLE groups ADD COLUMN invite_link_used_count INTEGER DEFAULT 0'); } catch {}
	try { sqliteDb.exec('ALTER TABLE groups ADD COLUMN invite_link_expires_at INTEGER'); } catch {}
	try { sqliteDb.exec('ALTER TABLE groups ADD COLUMN description TEXT DEFAULT \'\''); } catch {}

	// Group encryption keys table
	sqliteDb.exec(`
		CREATE TABLE IF NOT EXISTS group_keys (
			id TEXT PRIMARY KEY,
			group_id TEXT NOT NULL REFERENCES groups(id),
			member_did TEXT NOT NULL REFERENCES profiles(did),
			wrapped_key TEXT NOT NULL,
			wrapped_key_nonce TEXT NOT NULL,
			sender_did TEXT NOT NULL,
			epoch INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE INDEX IF NOT EXISTS idx_group_keys_group_member ON group_keys(group_id, member_did);
	`);

	// Sealed sender tables
	sqliteDb.exec(`
		CREATE TABLE IF NOT EXISTS delivery_tokens (
			did TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE TABLE IF NOT EXISTS sealed_messages (
			id TEXT PRIMARY KEY,
			recipient_did TEXT NOT NULL,
			delivery_token_hash TEXT NOT NULL,
			sealed_payload TEXT NOT NULL,
			ephemeral_public_key TEXT NOT NULL,
			nonce TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE INDEX IF NOT EXISTS idx_sealed_messages_recipient ON sealed_messages(recipient_did, created_at);
		CREATE TABLE IF NOT EXISTS group_delivery_tokens (
			group_id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
	`);

	// Delivery tokens: add previous_token_hash for token rotation resilience
	try { sqliteDb.exec('ALTER TABLE delivery_tokens ADD COLUMN previous_token_hash TEXT'); } catch {}

	// Media view-once support
	try { sqliteDb.exec('ALTER TABLE media ADD COLUMN view_once INTEGER DEFAULT 0'); } catch {}
	try { sqliteDb.exec('ALTER TABLE media ADD COLUMN expires_at INTEGER'); } catch {}

	// Profile instagram + link columns
	try { sqliteDb.exec('ALTER TABLE profiles ADD COLUMN instagram TEXT'); } catch {}
	try { sqliteDb.exec('ALTER TABLE profiles ADD COLUMN profile_link TEXT'); } catch {}

	// Encrypted avatar key/nonce columns
	try { sqliteDb.exec('ALTER TABLE profiles ADD COLUMN avatar_key TEXT'); } catch {}
	try { sqliteDb.exec('ALTER TABLE profiles ADD COLUMN avatar_nonce TEXT'); } catch {}

	// Profile encryption columns
	try { sqliteDb.exec('ALTER TABLE profiles ADD COLUMN encrypted_fields TEXT'); } catch {}
	try { sqliteDb.exec('ALTER TABLE profiles ADD COLUMN encrypted_fields_nonce TEXT'); } catch {}
	try { sqliteDb.exec('ALTER TABLE profiles ADD COLUMN profile_key_version INTEGER DEFAULT 0'); } catch {}

	// Profile encryption keys table
	sqliteDb.exec(`
		CREATE TABLE IF NOT EXISTS profile_keys (
			id TEXT PRIMARY KEY,
			owner_did TEXT NOT NULL REFERENCES profiles(did),
			recipient_did TEXT NOT NULL REFERENCES profiles(did),
			wrapped_key TEXT NOT NULL,
			wrapped_key_nonce TEXT NOT NULL,
			key_version INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE INDEX IF NOT EXISTS idx_profile_keys_recipient ON profile_keys(recipient_did, owner_did);
		CREATE INDEX IF NOT EXISTS idx_profile_keys_owner ON profile_keys(owner_did, key_version);
	`);

	// DM invitations table
	sqliteDb.exec(`
		CREATE TABLE IF NOT EXISTS dm_invitations (
			id TEXT PRIMARY KEY,
			sender_did TEXT NOT NULL REFERENCES profiles(did),
			recipient_did TEXT NOT NULL REFERENCES profiles(did),
			group_id TEXT NOT NULL,
			sender_display_name TEXT NOT NULL,
			sender_avatar_media_id TEXT,
			sender_avatar_key TEXT,
			sender_avatar_nonce TEXT,
			sender_geohash_cell TEXT,
			first_message_ciphertext TEXT NOT NULL,
			first_message_nonce TEXT NOT NULL,
			first_message_epoch INTEGER NOT NULL,
			first_message_dh_public_key TEXT,
			first_message_previous_counter INTEGER,
			status TEXT NOT NULL DEFAULT 'pending',
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE INDEX IF NOT EXISTS idx_dm_invitations_recipient ON dm_invitations(recipient_did, status);
		CREATE INDEX IF NOT EXISTS idx_dm_invitations_sender ON dm_invitations(sender_did);
	`);

	// DM leave records table
	sqliteDb.exec(`
		CREATE TABLE IF NOT EXISTS dm_leaves (
			id TEXT PRIMARY KEY,
			group_id TEXT NOT NULL,
			leaver_did TEXT NOT NULL REFERENCES profiles(did),
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE INDEX IF NOT EXISTS idx_dm_leaves_group ON dm_leaves(group_id);
	`);

	// Groups description column
	try { sqliteDb.exec('ALTER TABLE groups ADD COLUMN description TEXT DEFAULT \'\''); } catch {}

	// Community moderation tables
	sqliteDb.exec(`
		CREATE TABLE IF NOT EXISTS flags (
			id TEXT PRIMARY KEY,
			flagger_did TEXT NOT NULL REFERENCES profiles(did),
			flagged_did TEXT NOT NULL REFERENCES profiles(did),
			category TEXT NOT NULL,
			signed_blob TEXT NOT NULL,
			signature TEXT NOT NULL,
			weight INTEGER NOT NULL DEFAULT 10,
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE INDEX IF NOT EXISTS idx_flags_flagged ON flags(flagged_did, category);
		CREATE INDEX IF NOT EXISTS idx_flags_flagger ON flags(flagger_did);

		CREATE TABLE IF NOT EXISTS flag_throttles (
			did TEXT PRIMARY KEY REFERENCES profiles(did),
			level TEXT NOT NULL DEFAULT 'none',
			reason TEXT,
			effective_at INTEGER NOT NULL DEFAULT (unixepoch()),
			expires_at INTEGER,
			appealed_at INTEGER
		);

		CREATE TABLE IF NOT EXISTS csam_hashes (
			id TEXT PRIMARY KEY,
			media_id TEXT NOT NULL,
			perceptual_hash TEXT NOT NULL,
			match_result TEXT,
			checked_at INTEGER,
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE INDEX IF NOT EXISTS idx_csam_hashes_media ON csam_hashes(media_id);
	`);

	// Push notification subscriptions
	sqliteDb.exec(`
		CREATE TABLE IF NOT EXISTS push_subscriptions (
			id TEXT PRIMARY KEY,
			did TEXT NOT NULL REFERENCES profiles(did),
			endpoint TEXT NOT NULL,
			p256dh TEXT NOT NULL,
			auth TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		);
		CREATE INDEX IF NOT EXISTS idx_push_subscriptions_did ON push_subscriptions(did);
	`);

	// Migration: make media.uploader_did nullable (for sealed uploads)
	// SQLite can't ALTER COLUMN, so recreate the table if it has the NOT NULL constraint
	try {
		const colInfo = sqliteDb.prepare("PRAGMA table_info(media)").all() as Array<{ name: string; notnull: number }>;
		const uploaderCol = colInfo.find((c: any) => c.name === 'uploader_did');
		if (uploaderCol && uploaderCol.notnull === 1) {
			sqliteDb.exec('PRAGMA foreign_keys = OFF');
			sqliteDb.exec(`
				CREATE TABLE media_new (
					id TEXT PRIMARY KEY,
					uploader_did TEXT,
					encrypted_blob BLOB,
					media_key_wrapped TEXT,
					mime_type TEXT NOT NULL,
					size INTEGER NOT NULL,
					view_once INTEGER DEFAULT 0,
					expires_at INTEGER,
					created_at INTEGER NOT NULL DEFAULT (unixepoch())
				);
				INSERT INTO media_new SELECT id, uploader_did, encrypted_blob, media_key_wrapped, mime_type, size, view_once, expires_at, created_at FROM media;
				DROP TABLE media;
				ALTER TABLE media_new RENAME TO media;
			`);
			sqliteDb.exec('PRAGMA foreign_keys = ON');
			console.log('[db] Migrated media table: uploader_did now nullable');
		}
	} catch (e) {
		console.error('[db] Media migration error:', e);
	}
}

initDb();

// Periodic cleanup of expired view-once media (every 5 minutes)
setInterval(async () => {
	try {
		await db.delete(media).where(
			and(eq(media.viewOnce, true), lte(media.expiresAt, new Date()))
		);
	} catch {}
}, 5 * 60 * 1000);

// --- WebSocket for real-time messages ---
const wsClients = new Map<string, any>(); // did -> ws

export { wsClients };

// Update lastSeen for a DID (debounced — max once per 30 seconds per user)
const lastSeenUpdates = new Map<string, number>();
function touchLastSeen(did: string) {
	const now = Date.now();
	const last = lastSeenUpdates.get(did) ?? 0;
	if (now - last < 30000) return; // debounce: 30s
	lastSeenUpdates.set(did, now);
	db.update(profiles).set({ lastSeen: new Date() }).where(eq(profiles.did, did)).then(() => {}).catch(() => {});
}

const port = Number(process.env.PORT) || 3000;
console.log(`Proximity server starting on port ${port}`);

export default {
	port,
	fetch(req: Request, server: any) {
		// Handle WebSocket upgrade requests
		if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
			const success = server.upgrade(req);
			if (success) return undefined;
			return new Response('WebSocket upgrade failed', { status: 400 });
		}
		// All other requests go through Hono
		return app.fetch(req);
	},
	websocket: {
		open(ws: any) {
			// Client identifies via register message
		},
		async message(ws: any, message: string) {
			try {
				const data = JSON.parse(message);

				if (data.type === 'register') {
					wsClients.set(data.did, ws);
					(ws as any).did = data.did;
					touchLastSeen(data.did);
					ws.send(JSON.stringify({ type: 'registered', did: data.did }));
					return;
				}

				if (data.type === 'heartbeat') {
					// Only update lastSeen when the client reports the user is
					// actively viewing the app (tab visible + recent interaction).
					if (data.active) {
						const did = (ws as any).did;
						if (did) touchLastSeen(did);
					}
					return;
				}

				if (data.type === 'message' && data.recipientDid) {
					const senderDid = (ws as any).did;
					if (senderDid) touchLastSeen(senderDid);
					const recipient = wsClients.get(data.recipientDid);
					if (recipient) {
						recipient.send(JSON.stringify(data));
					} else {
						// Recipient offline — send push notification
						const senderProfile = senderDid
							? await db.select({ displayName: profiles.displayName }).from(profiles).where(eq(profiles.did, senderDid)).get()
							: null;
						sendPushNotification(data.recipientDid, {
							title: senderProfile?.displayName ?? 'New message',
							body: 'You have a new message',
							tag: `msg-${data.groupId || 'dm'}`,
							data: { url: data.groupId ? `/chat/${data.groupId}` : '/chat' },
						}).catch(() => {});
					}
				}

				// Sealed sender message — server intentionally ignores (ws as any).did
			if (data.type === 'sealed_message' && data.recipientDid && data.deliveryToken) {
				// Validate delivery token
				const hasher = new Bun.CryptoHasher('sha256');
				hasher.update(data.deliveryToken);
				const tokenHash = hasher.digest('hex');
				const tokenRow = await db.select().from(deliveryTokens).where(
					or(eq(deliveryTokens.tokenHash, tokenHash), eq(deliveryTokens.previousTokenHash, tokenHash))
				).get();
				if (tokenRow) {
					const recipient = wsClients.get(data.recipientDid);
					if (recipient) {
						// Relay only sealed fields — no sender identity
						recipient.send(JSON.stringify({
							type: 'sealed_message',
							sealedPayload: data.sealedPayload,
							ephemeralPublicKey: data.ephemeralPublicKey,
							nonce: data.nonce,
						}));
					} else {
						// Recipient offline — push notification (can't reveal sender for sealed messages)
						sendPushNotification(data.recipientDid, {
							title: 'New message',
							body: 'You have a new message',
							tag: 'msg-sealed',
							data: { url: '/chat' },
						}).catch(() => {});
					}
				}
			}

				// Relay media_viewed notification to sender
			if (data.type === 'media_viewed' && data.recipientDid) {
				const recipient = wsClients.get(data.recipientDid);
				if (recipient) {
					recipient.send(JSON.stringify(data));
				}
			}

			// Relay key_rotation event to group members
			if (data.type === 'key_rotation' && data.memberDids && Array.isArray(data.memberDids)) {
				const senderDid = (ws as any).did;
				for (const memberDid of data.memberDids) {
					if (memberDid === senderDid) continue;
					const member = wsClients.get(memberDid);
					if (member) {
						member.send(JSON.stringify({ type: 'key_rotation', groupId: data.groupId, epoch: data.epoch }));
					}
				}
			}

			// Sealed group message — server doesn't know senderDid
			if (data.type === 'sealed_group_message' && data.groupId && data.deliveryToken) {
				const hasher2 = new Bun.CryptoHasher('sha256');
				hasher2.update(data.deliveryToken);
				const gTokenHash = hasher2.digest('hex');
				const gToken = await db.select().from(groupDeliveryTokens).where(eq(groupDeliveryTokens.tokenHash, gTokenHash)).get();
				if (gToken) {
					// Get all group members and relay
					const members = await db.select().from(groupMembers).where(eq(groupMembers.groupId, data.groupId)).all();
					for (const m of members) {
						const client = wsClients.get(m.did);
						if (client && client !== ws) {
							client.send(JSON.stringify({
								type: 'group_message',
								groupId: data.groupId,
								senderDid: 'sealed',
								ciphertext: data.ciphertext,
								nonce: data.nonce,
								epoch: data.epoch,
							}));
						}
					}
				}
			}

			if (data.type === 'group_message' && data.groupId) {
					// Verify sender is still a member before relaying
					const senderDid = (ws as any).did;
					const group = await db.select().from(groups).where(eq(groups.id, data.groupId)).get();
					if (group) {
						const isMember = await db.select()
							.from(groupMembers)
							.where(and(eq(groupMembers.groupId, data.groupId), eq(groupMembers.did, senderDid)))
							.get();
						if (!isMember) return;
					}
					if (data.memberDids && Array.isArray(data.memberDids)) {
						for (const memberDid of data.memberDids) {
							if (memberDid === senderDid) continue;
							const member = wsClients.get(memberDid);
							if (member) {
								member.send(JSON.stringify({
									...data,
									memberDids: undefined
								}));
							}
						}
					}
				}
			} catch {}
		},
		close(ws: any) {
			if ((ws as any).did) {
				wsClients.delete((ws as any).did);
			}
		}
	}
};
