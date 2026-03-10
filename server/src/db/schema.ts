import { sqliteTable, text, integer, blob } from 'drizzle-orm/sqlite-core';

export const profiles = sqliteTable('profiles', {
	did: text('did').primaryKey(), // did:key:z6Mk...
	displayName: text('display_name').notNull(),
	bio: text('bio').default(''),
	age: integer('age'),
	publicKey: text('public_key'), // base64 Ed25519 signing key
	boxPublicKey: text('box_public_key'), // base64 X25519 encryption key
	signedProfileBlob: text('signed_profile_blob'), // JSON signed by identity key
	avatarMediaId: text('avatar_media_id'), // references media.id
	avatarKey: text('avatar_key'), // base64 symmetric key to decrypt avatar blob
	avatarNonce: text('avatar_nonce'), // base64 nonce for avatar decryption
	instagram: text('instagram'), // instagram handle (no @ prefix)
	profileLink: text('profile_link'), // optional external link (twitter, personal site, etc.)
	geohashCells: text('geohash_cells'), // JSON array of cells where discoverable
	lastSeen: integer('last_seen', { mode: 'timestamp' }),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

export const keyPackages = sqliteTable('key_packages', {
	id: text('id').primaryKey(), // nanoid
	did: text('did').notNull().references(() => profiles.did),
	keyPackageBlob: text('key_package_blob').notNull(), // base64 serialized KeyPackage
	consumed: integer('consumed', { mode: 'boolean' }).default(false),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

export const encryptedMessages = sqliteTable('encrypted_messages', {
	id: text('id').primaryKey(), // nanoid
	groupId: text('group_id').notNull(),
	senderDid: text('sender_did').notNull(),
	recipientDid: text('recipient_did').notNull(),
	epoch: integer('epoch').notNull(),
	ciphertext: text('ciphertext').notNull(), // base64
	nonce: text('nonce').notNull(), // base64
	// Double Ratchet header fields
	dhPublicKey: text('dh_public_key'), // base64 — sender's ephemeral DH ratchet public key
	previousCounter: integer('previous_counter'), // messages sent in previous sending chain
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

export const media = sqliteTable('media', {
	id: text('id').primaryKey(), // nanoid
	uploaderDid: text('uploader_did'), // nullable for sealed uploads; references profiles.did when set
	encryptedBlob: blob('encrypted_blob'), // encrypted file bytes stored as blob
	mediaKeyWrapped: text('media_key_wrapped'), // base64, key encrypted for self
	mimeType: text('mime_type').notNull(),
	size: integer('size').notNull(),
	viewOnce: integer('view_once', { mode: 'boolean' }).default(false),
	expiresAt: integer('expires_at', { mode: 'timestamp' }),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

export const authChallenges = sqliteTable('auth_challenges', {
	did: text('did').primaryKey(),
	challenge: text('challenge').notNull(),
	expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull()
});

// --- Group chat tables ---

export const groups = sqliteTable('groups', {
	id: text('id').primaryKey(), // nanoid
	name: text('name').notNull(),
	creatorDid: text('creator_did').notNull().references(() => profiles.did),
	inviteLinkHash: text('invite_link_hash'), // SHA-256 hex of invite key (key lives in URL fragment, never sent to server)
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

export const groupMembers = sqliteTable('group_members', {
	id: text('id').primaryKey(), // nanoid
	groupId: text('group_id').notNull().references(() => groups.id),
	did: text('did').notNull().references(() => profiles.did),
	role: text('role').notNull().default('member'), // 'admin' | 'member'
	joinedAt: integer('joined_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

export const groupInvites = sqliteTable('group_invites', {
	id: text('id').primaryKey(), // nanoid
	groupId: text('group_id').notNull().references(() => groups.id),
	inviterDid: text('inviter_did').notNull().references(() => profiles.did),
	inviteeDid: text('invitee_did').notNull().references(() => profiles.did),
	status: text('status').notNull().default('pending'), // 'pending' | 'accepted' | 'declined'
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// --- Group encryption keys ---

export const groupKeys = sqliteTable('group_keys', {
	id: text('id').primaryKey(), // nanoid
	groupId: text('group_id').notNull().references(() => groups.id),
	memberDid: text('member_did').notNull().references(() => profiles.did),
	wrappedKey: text('wrapped_key').notNull(), // base64 nacl.box encrypted group key
	wrappedKeyNonce: text('wrapped_key_nonce').notNull(), // base64 nonce for unwrapping
	senderDid: text('sender_did').notNull(), // who wrapped this key (need their boxPublicKey to unwrap)
	epoch: integer('epoch').notNull().default(0), // key rotation counter
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// --- Sealed sender tables ---

export const deliveryTokens = sqliteTable('delivery_tokens', {
	did: text('did').primaryKey(), // user who registered this token
	tokenHash: text('token_hash').notNull(), // SHA-256 hex of the actual token (server never sees plaintext)
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

export const sealedMessages = sqliteTable('sealed_messages', {
	id: text('id').primaryKey(), // nanoid
	recipientDid: text('recipient_did').notNull(), // only field linking to a user
	deliveryTokenHash: text('delivery_token_hash').notNull(), // proves sender has a valid token
	sealedPayload: text('sealed_payload').notNull(), // base64 — outer nacl.box ciphertext (contains encrypted inner envelope)
	ephemeralPublicKey: text('ephemeral_public_key').notNull(), // base64 — sender's ephemeral X25519 public key for unsealing
	nonce: text('nonce').notNull(), // base64 — nonce for outer nacl.box
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

export const groupDeliveryTokens = sqliteTable('group_delivery_tokens', {
	groupId: text('group_id').primaryKey(), // one token per group
	tokenHash: text('token_hash').notNull(), // SHA-256 hex of the group delivery token
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// --- Moderation tables ---

export const blocks = sqliteTable('blocks', {
	id: text('id').primaryKey(), // nanoid
	blockerDid: text('blocker_did').notNull().references(() => profiles.did),
	blockedDid: text('blocked_did').notNull().references(() => profiles.did),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

export const reports = sqliteTable('reports', {
	id: text('id').primaryKey(), // nanoid
	reporterDid: text('reporter_did').notNull().references(() => profiles.did),
	reportedDid: text('reported_did').notNull().references(() => profiles.did),
	reason: text('reason').notNull(), // 'spam' | 'harassment' | 'underage' | 'impersonation' | 'other'
	details: text('details').default(''),
	status: text('status').notNull().default('pending'), // 'pending' | 'reviewed' | 'actioned'
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});
