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
	encryptedFields: text('encrypted_fields'), // base64 nacl.secretbox ciphertext of JSON {bio, age, tags}
	encryptedFieldsNonce: text('encrypted_fields_nonce'), // base64 nonce
	profileKeyVersion: integer('profile_key_version').default(0), // increments on key rotation
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
	description: text('description').default(''),
	creatorDid: text('creator_did').notNull().references(() => profiles.did),
	inviteLinkHash: text('invite_link_hash'), // SHA-256 hex of invite key (key lives in URL fragment, never sent to server)
	inviteLinkMaxUses: integer('invite_link_max_uses'), // null = unlimited
	inviteLinkUsedCount: integer('invite_link_used_count').default(0),
	inviteLinkExpiresAt: integer('invite_link_expires_at', { mode: 'timestamp' }), // null = never expires
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
	previousTokenHash: text('previous_token_hash'), // previous hash — allows graceful token rotation
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

// --- Profile encryption keys ---

export const profileKeys = sqliteTable('profile_keys', {
	id: text('id').primaryKey(), // nanoid
	ownerDid: text('owner_did').notNull().references(() => profiles.did),
	recipientDid: text('recipient_did').notNull().references(() => profiles.did),
	wrappedKey: text('wrapped_key').notNull(), // base64 nacl.box encrypted profile key
	wrappedKeyNonce: text('wrapped_key_nonce').notNull(), // base64 nonce for unwrapping
	keyVersion: integer('key_version').notNull().default(0),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// --- DM Invitations ---

export const dmInvitations = sqliteTable('dm_invitations', {
	id: text('id').primaryKey(), // nanoid
	senderDid: text('sender_did').notNull().references(() => profiles.did),
	recipientDid: text('recipient_did').notNull().references(() => profiles.did),
	groupId: text('group_id').notNull(), // deterministic DM groupId
	senderDisplayName: text('sender_display_name').notNull(),
	senderAvatarMediaId: text('sender_avatar_media_id'),
	senderAvatarKey: text('sender_avatar_key'),
	senderAvatarNonce: text('sender_avatar_nonce'),
	senderGeohashCell: text('sender_geohash_cell'), // for fuzzy distance
	firstMessageCiphertext: text('first_message_ciphertext').notNull(), // base64 (Double Ratchet encrypted)
	firstMessageNonce: text('first_message_nonce').notNull(),
	firstMessageEpoch: integer('first_message_epoch').notNull(),
	firstMessageDhPublicKey: text('first_message_dh_public_key'),
	firstMessagePreviousCounter: integer('first_message_previous_counter'),
	status: text('status').notNull().default('pending'), // 'pending' | 'accepted' | 'blocked'
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// --- DM leave records ---

export const dmLeaves = sqliteTable('dm_leaves', {
	id: text('id').primaryKey(), // nanoid
	groupId: text('group_id').notNull(), // deterministic DM groupId
	leaverDid: text('leaver_did').notNull().references(() => profiles.did),
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

// --- Community moderation: DID-signed flags ---

export const flags = sqliteTable('flags', {
	id: text('id').primaryKey(), // nanoid
	flaggerDid: text('flagger_did').notNull().references(() => profiles.did),
	flaggedDid: text('flagged_did').notNull().references(() => profiles.did),
	category: text('category').notNull(), // 'fake_profile' | 'harassment' | 'underage' | 'spam'
	signedBlob: text('signed_blob').notNull(), // base64 Ed25519-signed JSON
	signature: text('signature').notNull(), // base64 Ed25519 signature
	weight: integer('weight').notNull().default(1), // stored as integer * 10 (e.g. 10 = 1.0, 3 = 0.3)
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

export const flagThrottles = sqliteTable('flag_throttles', {
	did: text('did').primaryKey().references(() => profiles.did),
	level: text('level').notNull().default('none'), // 'none' | 'throttled' | 'hidden'
	reason: text('reason'),
	effectiveAt: integer('effective_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
	expiresAt: integer('expires_at', { mode: 'timestamp' }), // null = permanent until appeal
	appealedAt: integer('appealed_at', { mode: 'timestamp' }),
});

export const csamHashes = sqliteTable('csam_hashes', {
	id: text('id').primaryKey(), // nanoid
	mediaId: text('media_id').notNull(),
	perceptualHash: text('perceptual_hash').notNull(),
	matchResult: text('match_result'), // 'clear' | 'match' | 'error'
	checkedAt: integer('checked_at', { mode: 'timestamp' }),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});
