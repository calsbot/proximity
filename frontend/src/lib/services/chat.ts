/**
 * Chat service: orchestrates Double Ratchet E2EE messaging with WebSocket + REST API.
 * Handles key derivation, encryption, decryption, and conversation management.
 */
import { get } from 'svelte/store';
import { identityStore } from '$lib/stores/identity';
import {
	conversationsStore,
	getOrCreateConversation,
	addMessage,
	updateConversationKeys,
	updateGroupConversationKeys,
	updateSenderKeys,
	markMediaViewed,
	deserializeKeys,
	loadConversations,
	markConversationLeft,
	unmarkConversationLeft,
	markConversationPeerLeft,
	unmarkConversationPeerLeft,
	setDeliveryTokens,
	setGroupDeliveryToken,
	resetSealedSender,
	type DecryptedMessage
} from '$lib/stores/conversations';
import {
	deriveConversationKeys,
	encryptMessage,
	decryptMessage,
	type ConversationKeys
} from '$lib/crypto/messaging';
import { decodeBase64, encodeBase64 } from '$lib/crypto/util';
import {
	generateDeliveryToken,
	hashDeliveryToken,
	sealMessage,
	unsealMessage,
	type SealedInnerEnvelope,
} from '$lib/crypto/sealed';
import {
	generateSenderKey,
	wrapSenderKeyForMembers,
	unwrapSenderKey,
	encryptGroupMessage,
	decryptGroupMessage,
	// Legacy compat
	generateGroupKey,
	wrapGroupKeyForMembers,
	unwrapGroupKey,
} from '$lib/crypto/group';
import { encryptMedia, fileToUint8Array } from '$lib/crypto/media';
import { computePerceptualHash } from '$lib/crypto/phash';
import {
	sendMessage as apiSendMessage,
	fetchMessages,
	getProfile,
	getGroup,
	storeGroupKeys,
	getMyGroupKeys,
	uploadMedia,
	uploadMediaSealed,
	notifyMediaViewed,
	registerDeliveryToken,
	registerGroupDeliveryToken,
	sendSealedMessage as apiSendSealedMessage,
	sendSealedGroupMessage as apiSendSealedGroupMessage,
	sendDMInvitation,
	checkCsam,
} from '$lib/api';
import { connect, onMessage, wsSend, disconnect } from './websocket';
import { requestCountStore } from '$lib/stores/requestCount';

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastPollTime: string | null = null;
let initialized = false;
let unsubMessage: (() => void) | null = null;
// Track server message IDs we've already processed (dedup for gte polling)
const processedServerIds = new Set<string>();

// --- Pending sealed group messages (retry on key_rotation) ---
// When a sealed group message arrives but can't be decrypted (sender key not yet available),
// queue it here. On key_rotation events, retry decryption for that group.
interface PendingGroupMessage {
	data: { groupId: string; senderDid: string; text?: string; ciphertext?: string; nonce?: string; epoch?: number; id?: string; createdAt?: string; recipientDid?: string; dhPublicKey?: string; previousCounter?: number };
	dedupId: string;
	retries: number;
	addedAt: number;
}
const pendingGroupMessages = new Map<string, PendingGroupMessage[]>(); // groupId → messages
const MAX_PENDING_RETRIES = 5;
const PENDING_TTL = 60_000; // discard after 60s

// --- Delivery Token Persistence (IndexedDB) ---

let myGlobalDeliveryToken: string | null = null;

async function getDeliveryTokenDb() {
	const { openDB } = await import('idb');
	return openDB('proximity', 1, {
		upgrade(db) {
			if (!db.objectStoreNames.contains('kv')) {
				db.createObjectStore('kv');
			}
		}
	});
}

async function loadOrCreateDeliveryToken(did: string): Promise<string> {
	if (myGlobalDeliveryToken) return myGlobalDeliveryToken;

	// Namespace delivery token by DID so each identity has its own token
	const tokenKey = `delivery-token-${did.slice(-12)}`;
	const legacyKey = 'delivery-token';
	try {
		const db = await getDeliveryTokenDb();
		// Try namespaced key first
		const existing = await db.get('kv', tokenKey);
		if (existing) {
			myGlobalDeliveryToken = existing;
			// Always re-register hash with server (in case server DB was cleared/rebuilt)
			hashDeliveryToken(existing)
				.then(h => registerDeliveryToken(did, h))
				.catch(() => {});
			return existing;
		}
		// Migrate from legacy (un-namespaced) key if it exists
		const legacy = await db.get('kv', legacyKey);
		if (legacy) {
			await db.put('kv', legacy, tokenKey);
			myGlobalDeliveryToken = legacy;
			// Re-register migrated token hash
			hashDeliveryToken(legacy)
				.then(h => registerDeliveryToken(did, h))
				.catch(() => {});
			return legacy;
		}
	} catch {}

	// Generate new token
	const token = generateDeliveryToken();
	myGlobalDeliveryToken = token;

	// Persist
	try {
		const db = await getDeliveryTokenDb();
		await db.put('kv', token, tokenKey);
	} catch {}

	// Register hash with server
	try {
		const tokenHash = await hashDeliveryToken(token);
		await registerDeliveryToken(did, tokenHash);
		console.log('[sealed] Delivery token registered with server');
	} catch (e) {
		console.error('[sealed] Failed to register delivery token:', e);
	}

	return token;
}

/**
 * Initialize the chat service: load conversations, connect WS, start polling.
 */
export async function initChat(): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) return;

	// Prevent duplicate initialization
	if (initialized) return;
	initialized = true;

	await loadConversations(state.identity.did);

	// Ensure delivery token exists and is registered with server
	await loadOrCreateDeliveryToken(state.identity.did);

	// Pre-populate processed IDs from existing messages to avoid re-processing
	// Also find the latest message timestamp to avoid re-fetching old messages
	const convos = get(conversationsStore);
	let latestTimestamp: string | null = null;
	for (const c of convos) {
		for (const m of c.messages) {
			if (m.id.startsWith('server-') || m.id.startsWith('srv-')) {
				processedServerIds.add(m.id);
			}
			if (!latestTimestamp || m.timestamp > latestTimestamp) {
				latestTimestamp = m.timestamp;
			}
		}
	}
	// Start polling from after the latest message we already have
	if (latestTimestamp) {
		lastPollTime = latestTimestamp;
	}

	connect(state.identity.did);

	// Handle incoming real-time messages (only register once)
	if (unsubMessage) unsubMessage();
	unsubMessage = onMessage(async (data) => {
		if (data.type === 'message') {
			await handleIncomingMessage(data);
		}
		if (data.type === 'sealed_message') {
			await handleIncomingSealedMessage(data);
		}
		if (data.type === 'group_message') {
			await handleIncomingGroupMessage(data);
		}
		if (data.type === 'kicked') {
			handleKicked(data);
		}
		if (data.type === 'member_removed') {
			window.dispatchEvent(new CustomEvent('group-member-removed', {
				detail: { groupId: data.groupId, targetDid: data.targetDid }
			}));
		}
		if (data.type === 'join_request') {
			window.dispatchEvent(new CustomEvent('group-join-request', {
				detail: { groupId: data.groupId, requesterDid: data.requesterDid, requesterName: data.requesterName }
			}));
		}
		if (data.type === 'join_approved') {
			unmarkConversationLeft(data.groupId);
			window.dispatchEvent(new CustomEvent('group-join-approved', {
				detail: { groupId: data.groupId }
			}));
		}
		if (data.type === 'join_denied') {
			window.dispatchEvent(new CustomEvent('group-join-denied', {
				detail: { groupId: data.groupId }
			}));
		}
		if (data.type === 'key_rotation') {
			await handleKeyRotation(data);
		}
		if (data.type === 'media_viewed') {
			handleMediaViewedEvent(data);
		}
		if (data.type === 'dm_peer_left') {
			// Persist peerLeft in conversation store so chat list shows the tag
			markConversationPeerLeft(data.groupId);
			window.dispatchEvent(new CustomEvent('dm-peer-left', {
				detail: { groupId: data.groupId, leaverDid: data.leaverDid }
			}));
		}
		if (data.type === 'dm_accepted') {
			unmarkConversationLeft(data.groupId);
			unmarkConversationPeerLeft(data.groupId);
			// Reset sealed sender so next message goes through unsealed path
			// (re-triggers token exchange naturally, avoids stale delivery tokens)
			resetSealedSender(data.groupId);
			window.dispatchEvent(new CustomEvent('dm-accepted', {
				detail: { groupId: data.groupId }
			}));
		}
		if (data.type === 'dm_invitation') {
			// New DM invitation received — increment request badge
			requestCountStore.update(n => n + 1);
			window.dispatchEvent(new CustomEvent('dm-invitation', {
				detail: { groupId: data.groupId, senderDisplayName: data.senderDisplayName }
			}));
		}
		if (data.type === 'group_invite') {
			// New group invitation received — increment request badge
			requestCountStore.update(n => n + 1);
			window.dispatchEvent(new CustomEvent('group-invite', {
				detail: { groupId: data.groupId, inviteId: data.inviteId, groupName: data.groupName, inviterDid: data.inviterDid }
			}));
		}
		if (data.type === 'system_message') {
			// Content-based dedup: same system text for same group within a 30-second window
			// Uses a time bucket so legitimate re-joins after 30s still show up
			const timeBucket = Math.floor(Date.now() / 30000);
			const sysDedupId = `sys-${data.groupId}-${data.text}-${timeBucket}`;
			if (processedServerIds.has(sysDedupId)) return;
			processedServerIds.add(sysDedupId);

			// Auto-create conversation if needed
			const convos = get(conversationsStore);
			if (!convos.find(c => c.groupId === data.groupId)) {
				try {
					const group = await getGroup(data.groupId);
					getOrCreateConversation(data.groupId, '', group.name, '', null, true);
				} catch {}
			}
			const msg: DecryptedMessage = {
				id: sysDedupId,
				senderDid: 'system',
				text: data.text,
				timestamp: new Date().toISOString(),
				isMine: false,
			};
			addMessage(data.groupId, msg);
		}
		if (data.type === 'member_joined') {
			// Auto-redistribute group key when a new member joins
			await handleMemberJoined(data);
			// Notify UI so member list and count update in real-time
			window.dispatchEvent(new CustomEvent('group-member-joined', {
				detail: { groupId: data.groupId, memberDid: data.memberDid }
			}));
		}
		if (data.type === 'role_changed') {
			// Role changed (e.g. admin transfer) — just refresh the UI, no key redistribution needed
			window.dispatchEvent(new CustomEvent('group-member-joined', {
				detail: { groupId: data.groupId, memberDid: data.memberDid }
			}));
		}
	});

	// Poll for missed messages every 10 seconds
	startPolling();
}

/**
 * Compute the deterministic conversation ID for a peer without creating/persisting the conversation.
 */
export async function getConversationId(
	peerDid: string,
	peerBoxPublicKey: string
): Promise<string> {
	const state = get(identityStore);
	if (!state.identity) throw new Error('No identity');

	const keys = await deriveConversationKeys(
		state.identity.boxSecretKey,
		state.identity.boxPublicKey,
		state.identity.did,
		decodeBase64(peerBoxPublicKey),
		peerDid
	);

	return keys.groupId;
}

/**
 * Start a conversation with a peer.
 */
export async function startConversation(
	peerDid: string,
	peerName: string,
	peerBoxPublicKey: string
): Promise<string> {
	const state = get(identityStore);
	if (!state.identity) throw new Error('No identity');

	const keys = await deriveConversationKeys(
		state.identity.boxSecretKey,
		state.identity.boxPublicKey,
		state.identity.did,
		decodeBase64(peerBoxPublicKey),
		peerDid
	);

	getOrCreateConversation(keys.groupId, peerDid, peerName, peerBoxPublicKey, keys);
	return keys.groupId;
}

/**
 * Send a text message in a conversation (Double Ratchet E2EE).
 * First-contact DMs are routed through the invitation endpoint.
 */
export async function sendChatMessage(groupId: string, text: string): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) throw new Error('No identity');

	const convos = get(conversationsStore);
	const convo = convos.find(c => c.groupId === groupId);
	if (!convo || !convo.keys) throw new Error('Conversation not found or missing keys');

	const keys = deserializeKeys(convo.keys);
	const { encrypted, updatedKeys } = await encryptMessage(keys, state.identity.did, text);

	// Add to local messages immediately
	const localMsg: DecryptedMessage = {
		id: crypto.randomUUID(),
		senderDid: state.identity.did,
		text,
		timestamp: new Date().toISOString(),
		isMine: true,
	};
	addMessage(groupId, localMsg, updatedKeys);

	// First-contact detection: DM with no prior messages → route through invitation
	const isFirstContact = !convo.isGroup && convo.messages.length === 0;
	if (isFirstContact) {
		try {
			// Fetch our own profile for snapshot
			const myProfile = await getProfile(state.identity.did);
			await sendDMInvitation({
				senderDid: state.identity.did,
				recipientDid: convo.peerDid,
				groupId: encrypted.groupId,
				senderDisplayName: myProfile.displayName,
				senderAvatarMediaId: myProfile.avatarMediaId ?? undefined,
				senderAvatarKey: myProfile.avatarKey ?? undefined,
				senderAvatarNonce: myProfile.avatarNonce ?? undefined,
				senderGeohashCell: myProfile.geohashCells ? JSON.parse(myProfile.geohashCells)?.[0] : undefined,
				firstMessageCiphertext: encrypted.ciphertext,
				firstMessageNonce: encrypted.nonce,
				firstMessageEpoch: encrypted.epoch,
				firstMessageDhPublicKey: encrypted.dhPublicKey,
				firstMessagePreviousCounter: encrypted.previousCounter,
			});
			console.log('[invitations] DM invitation sent to', convo.peerDid);
		} catch (e) {
			console.error('[invitations] Failed to send DM invitation:', e);
			// Fallback: send as regular message so the message isn't lost
			await apiSendMessage({
				groupId: encrypted.groupId,
				senderDid: encrypted.senderDid,
				recipientDid: encrypted.recipientDid,
				epoch: encrypted.epoch,
				ciphertext: encrypted.ciphertext,
				nonce: encrypted.nonce,
				dhPublicKey: encrypted.dhPublicKey,
				previousCounter: encrypted.previousCounter,
			});
		}
		// Don't send via WebSocket — first message is delivered only through the invitation flow
	} else if (!convo.isGroup && convo.sealedSenderEnabled && convo.peerDeliveryToken && convo.peerBoxPublicKey) {
		// Sealed path — server cannot see senderDid
		const sealed = sealMessage(encrypted, convo.peerBoxPublicKey, convo.peerDeliveryToken, state.identity.did);
		let sealedRestOk = false;
		try {
			await apiSendSealedMessage(sealed);
			sealedRestOk = true;
		} catch (e) {
			console.error('[sealed] Sealed send failed — resetting sealed sender for', groupId.slice(0, 8));
			// Reset sealed sender so next message falls through to unsealed path
			// (which will re-trigger token exchange naturally)
			resetSealedSender(groupId);
			// Send via unsealed path for THIS message so it isn't lost
			try {
				await apiSendMessage({
					groupId: encrypted.groupId,
					senderDid: encrypted.senderDid,
					recipientDid: encrypted.recipientDid,
					epoch: encrypted.epoch,
					ciphertext: encrypted.ciphertext,
					nonce: encrypted.nonce,
					dhPublicKey: encrypted.dhPublicKey,
					previousCounter: encrypted.previousCounter,
				});
			} catch (e2) {
				console.error('[sealed] Unsealed recovery also failed:', e2);
			}
		}
		if (sealedRestOk) {
			// Only send sealed via WS if REST succeeded (same delivery token)
			wsSend({
				type: 'sealed_message',
				recipientDid: sealed.recipientDid,
				deliveryToken: sealed.deliveryToken,
				sealedPayload: sealed.sealedPayload,
				ephemeralPublicKey: sealed.ephemeralPublicKey,
				nonce: sealed.nonce,
			});
		}
		// DM unsealed fallback: server relays via WS after REST store (no client-side wsSend needed)
	} else {
		// Unsealed path (subsequent messages before token exchange, or groups)
		try {
			await apiSendMessage({
				groupId: encrypted.groupId,
				senderDid: encrypted.senderDid,
				recipientDid: encrypted.recipientDid,
				epoch: encrypted.epoch,
				ciphertext: encrypted.ciphertext,
				nonce: encrypted.nonce,
				dhPublicKey: encrypted.dhPublicKey,
				previousCounter: encrypted.previousCounter,
			});
		} catch (e) {
			console.error('Failed to send message via REST:', e);
		}
		// For groups, relay via WS (server doesn't relay group messages from REST).
		// For DMs, the server now relays via WS after REST store — no client wsSend needed.
		if (convo.isGroup) {
			wsSend({
				type: 'message',
				groupId: encrypted.groupId,
				senderDid: encrypted.senderDid,
				recipientDid: encrypted.recipientDid,
				epoch: encrypted.epoch,
				ciphertext: encrypted.ciphertext,
				nonce: encrypted.nonce,
				dhPublicKey: encrypted.dhPublicKey,
				previousCounter: encrypted.previousCounter,
			});
		}

		// After first unsealed DM, trigger token exchange
		if (!convo.isGroup && !convo.myDeliveryToken && myGlobalDeliveryToken) {
			await sendTokenExchange(groupId, myGlobalDeliveryToken);
		}
	}

	// Track that we sent this epoch so polling won't try to decrypt it again
	processedServerIds.add(`server-${encrypted.epoch}-${state.identity.did}`);
}

/**
 * Send a view-once media message in a DM conversation (Double Ratchet E2EE).
 * Encrypts media with a random key, uploads the blob, then encrypts a JSON
 * payload containing mediaId + mediaKey using the Double Ratchet.
 */
export async function sendDMMediaMessage(
	groupId: string,
	file: File,
	viewOnce: boolean
): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) throw new Error('No identity');

	const convos = get(conversationsStore);
	const convo = convos.find(c => c.groupId === groupId);
	if (!convo || !convo.keys) throw new Error('Conversation not found or missing keys');

	// Encrypt the media file with a random symmetric key
	const fileData = await fileToUint8Array(file);
	const encrypted = encryptMedia(fileData);

	// Upload encrypted blob to server — use sealed upload if sealed sender is active
	const blob = new Blob([encrypted.encryptedBlob]);
	let result: { ok: boolean; mediaId: string };
	if (convo.sealedSenderEnabled && convo.peerDeliveryToken) {
		result = await uploadMediaSealed(convo.peerDeliveryToken, blob, 'application/octet-stream', viewOnce);
	} else {
		result = await uploadMedia(state.identity.did, blob, 'application/octet-stream', undefined, viewOnce);
	}

	// CSAM hash check: compute perceptual hash on plaintext, check with server
	try {
		const phash = await computePerceptualHash(fileData, file.type || 'image/jpeg');
		const csamResult = await checkCsam(result.mediaId, phash);
		if (csamResult.blocked) {
			throw new Error('Image blocked by safety check');
		}
	} catch (e: any) {
		if (e?.message === 'Image blocked by safety check') throw e;
		console.warn('[csam] Hash check failed (non-blocking):', e);
	}

	// Create structured JSON payload
	const payload = JSON.stringify({
		t: 'media',
		mediaId: result.mediaId,
		mediaKey: encrypted.key,
		mediaNonce: encrypted.nonce,
		mimeType: file.type || 'image/jpeg',
		viewOnce,
	});

	// Encrypt payload with Double Ratchet
	const keys = deserializeKeys(convo.keys);
	const { encrypted: encMsg, updatedKeys } = await encryptMessage(keys, state.identity.did, payload);

	// Add local message
	const localMsg: DecryptedMessage = {
		id: crypto.randomUUID(),
		senderDid: state.identity.did,
		text: viewOnce ? 'view-once photo' : 'photo',
		timestamp: new Date().toISOString(),
		isMine: true,
		mediaId: result.mediaId,
		mediaKey: encrypted.key,
		mediaNonce: encrypted.nonce,
		mimeType: file.type || 'image/jpeg',
		viewOnce,
		viewed: false,
	};
	addMessage(groupId, localMsg, updatedKeys);

	// Choose sealed or unsealed send path
	if (convo.sealedSenderEnabled && convo.peerDeliveryToken && convo.peerBoxPublicKey) {
		const sealed = sealMessage(encMsg, convo.peerBoxPublicKey, convo.peerDeliveryToken, state.identity.did);
		let sealedRestOk = false;
		try {
			await apiSendSealedMessage(sealed);
			sealedRestOk = true;
		} catch (e) {
			console.error('[sealed] Sealed media send failed — resetting sealed sender for', groupId.slice(0, 8));
			resetSealedSender(groupId);
			// Recovery: send via unsealed path so the media message isn't lost
			try {
				await apiSendMessage({
					groupId: encMsg.groupId,
					senderDid: encMsg.senderDid,
					recipientDid: encMsg.recipientDid,
					epoch: encMsg.epoch,
					ciphertext: encMsg.ciphertext,
					nonce: encMsg.nonce,
					dhPublicKey: encMsg.dhPublicKey,
					previousCounter: encMsg.previousCounter,
				});
			} catch (e2) {
				console.error('[sealed] Unsealed recovery also failed:', e2);
			}
		}
		if (sealedRestOk) {
			wsSend({
				type: 'sealed_message',
				recipientDid: sealed.recipientDid,
				deliveryToken: sealed.deliveryToken,
				sealedPayload: sealed.sealedPayload,
				ephemeralPublicKey: sealed.ephemeralPublicKey,
				nonce: sealed.nonce,
			});
		}
	} else {
		try {
			await apiSendMessage({
				groupId: encMsg.groupId,
				senderDid: encMsg.senderDid,
				recipientDid: encMsg.recipientDid,
				epoch: encMsg.epoch,
				ciphertext: encMsg.ciphertext,
				nonce: encMsg.nonce,
				dhPublicKey: encMsg.dhPublicKey,
				previousCounter: encMsg.previousCounter,
			});
		} catch (e) {
			console.error('Failed to send DM media via REST:', e);
		}
		// Server relays DM via WS after REST store — no client wsSend needed
	}

	processedServerIds.add(`server-${encMsg.epoch}-${state.identity.did}`);
}

/**
 * Send an encrypted message in a group chat.
 * Uses Sender Keys: encrypt with MY sender key (nacl.secretbox).
 * Recipients look up my key by my DID to decrypt.
 */
export async function sendGroupMessage(groupId: string, text: string, memberDids: string[]): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) throw new Error('No identity');

	let convos = get(conversationsStore);
	let convo = convos.find(c => c.groupId === groupId);
	if (!convo) throw new Error('Group conversation not found');

	// Ensure I have a sender key for this group
	let mySenderKey = convo.mySenderKey;
	if (!mySenderKey) {
		// Generate and distribute my sender key
		await distributeMySenderKey(groupId);
		convos = get(conversationsStore);
		convo = convos.find(c => c.groupId === groupId);
		mySenderKey = convo?.mySenderKey;
	}

	let ciphertext: string;
	let nonce: string;
	const epoch = convo?.mySenderKeyEpoch ?? 0;

	// For sealed groups, embed senderDid inside the encrypted payload
	const useSealed = !!(mySenderKey && convo?.groupDeliveryToken);
	let plainPayload: string;
	if (useSealed) {
		plainPayload = JSON.stringify({ t: 'sealed_group', senderDid: state.identity.did, text });
	} else {
		plainPayload = text;
	}

	if (mySenderKey) {
		const encrypted = encryptGroupMessage(plainPayload, mySenderKey);
		ciphertext = encrypted.ciphertext;
		nonce = encrypted.nonce;
	} else {
		ciphertext = btoa(plainPayload);
		nonce = btoa('group-msg');
	}

	// Add to local messages immediately
	const localMsg: DecryptedMessage = {
		id: crypto.randomUUID(),
		senderDid: state.identity.did,
		text,
		timestamp: new Date().toISOString(),
		isMine: true,
	};
	addMessage(groupId, localMsg);

	if (useSealed && convo?.groupDeliveryToken) {
		// Sealed path — server doesn't see senderDid
		try {
			await apiSendSealedGroupMessage({
				groupId,
				deliveryToken: convo.groupDeliveryToken,
				ciphertext,
				nonce,
				epoch,
			});
		} catch (e) {
			console.error('Failed to send sealed group message via REST:', e);
		}
		wsSend({
			type: 'sealed_group_message',
			groupId,
			deliveryToken: convo.groupDeliveryToken,
			ciphertext,
			nonce,
			epoch,
		});
	} else {
		// Unsealed path — send to each member with senderDid visible
		for (const recipientDid of memberDids) {
			if (recipientDid === state.identity.did) continue;
			try {
				await apiSendMessage({
					groupId,
					senderDid: state.identity.did,
					recipientDid,
					epoch,
					ciphertext,
					nonce,
				});
			} catch (e) {
				console.error('Failed to send group message to', recipientDid, e);
			}
		}
		wsSend({
			type: 'group_message',
			groupId,
			senderDid: state.identity.did,
			ciphertext,
			nonce,
			epoch,
			memberDids,
		});
	}
}

/**
 * Send a view-once media message in a group chat.
 * Uses Sender Keys: encrypts media payload with MY sender key.
 */
export async function sendGroupMediaMessage(
	groupId: string,
	file: File,
	viewOnce: boolean,
	memberDids: string[]
): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) throw new Error('No identity');

	let convos = get(conversationsStore);
	let convo = convos.find(c => c.groupId === groupId);
	if (!convo) throw new Error('Group conversation not found');

	// Ensure I have a sender key
	let mySenderKey = convo.mySenderKey;
	if (!mySenderKey) {
		await distributeMySenderKey(groupId);
		convos = get(conversationsStore);
		convo = convos.find(c => c.groupId === groupId);
		if (!convo) throw new Error('Group conversation not found');
		mySenderKey = convo.mySenderKey;
	}

	const epoch = convo.mySenderKeyEpoch ?? 0;

	// Encrypt the media with a random key
	const fileData = await fileToUint8Array(file);
	const encrypted = encryptMedia(fileData);

	// Upload encrypted blob — pass groupId so server can track per-member views for view-once
	const blob = new Blob([encrypted.encryptedBlob]);
	let result: { ok: boolean; mediaId: string };
	if (convo.groupDeliveryToken) {
		result = await uploadMediaSealed(convo.groupDeliveryToken, blob, 'application/octet-stream', viewOnce, groupId);
	} else {
		result = await uploadMedia(state.identity.did, blob, 'application/octet-stream', undefined, viewOnce, groupId);
	}

	// Create structured payload
	const mediaPayload = JSON.stringify({
		t: 'media',
		mediaId: result.mediaId,
		mediaKey: encrypted.key,
		mediaNonce: encrypted.nonce,
		mimeType: file.type || 'image/jpeg',
		viewOnce,
	});

	// For sealed groups, wrap with senderDid inside
	const useSealed = !!(mySenderKey && convo.groupDeliveryToken);
	const plainPayload = useSealed
		? JSON.stringify({ t: 'sealed_group', senderDid: state.identity.did, text: mediaPayload })
		: mediaPayload;

	let ciphertext: string;
	let nonce: string;

	if (mySenderKey) {
		const encPayload = encryptGroupMessage(plainPayload, mySenderKey);
		ciphertext = encPayload.ciphertext;
		nonce = encPayload.nonce;
	} else {
		ciphertext = btoa(plainPayload);
		nonce = btoa('group-msg');
	}

	// Add local message
	const localMsg: DecryptedMessage = {
		id: crypto.randomUUID(),
		senderDid: state.identity.did,
		text: viewOnce ? 'view-once photo' : 'photo',
		timestamp: new Date().toISOString(),
		isMine: true,
		mediaId: result.mediaId,
		mediaKey: encrypted.key,
		mediaNonce: encrypted.nonce,
		mimeType: file.type || 'image/jpeg',
		viewOnce,
		viewed: false,
	};
	addMessage(groupId, localMsg);

	if (useSealed && convo.groupDeliveryToken) {
		try {
			await apiSendSealedGroupMessage({
				groupId,
				deliveryToken: convo.groupDeliveryToken,
				ciphertext,
				nonce,
				epoch,
			});
		} catch (e) {
			console.error('Failed to send sealed group media via REST:', e);
		}
		wsSend({
			type: 'sealed_group_message',
			groupId,
			deliveryToken: convo.groupDeliveryToken,
			ciphertext,
			nonce,
			epoch,
		});
	} else {
		for (const recipientDid of memberDids) {
			if (recipientDid === state.identity.did) continue;
			try {
				await apiSendMessage({
					groupId,
					senderDid: state.identity.did,
					recipientDid,
					epoch,
					ciphertext,
					nonce,
				});
			} catch (e) {
				console.error('Failed to send media message to', recipientDid, e);
			}
		}
		wsSend({
			type: 'group_message',
			groupId,
			senderDid: state.identity.did,
			ciphertext,
			nonce,
			epoch,
			memberDids,
		});
	}
}

/**
 * Try decrypting a group message with all available sender keys.
 * Used for sealed group messages where senderDid is hidden ('sealed').
 * Returns the decrypted plaintext and the real senderDid, or null if all keys fail.
 */
function tryDecryptWithAllSenderKeys(
	ciphertext: string,
	nonce: string,
	senderKeys: Record<string, string>,
	legacyKeys?: Record<number, string>,
	epoch?: number,
): { plaintext: string; senderDid: string } | null {
	// Try each sender key
	for (const [did, key] of Object.entries(senderKeys)) {
		try {
			const plaintext = decryptGroupMessage(ciphertext, nonce, key);
			return { plaintext, senderDid: did };
		} catch {
			// Wrong key — try next
		}
	}
	// Try legacy epoch-based keys
	if (legacyKeys) {
		const legacyKey = legacyKeys[epoch ?? 0];
		if (legacyKey) {
			try {
				const plaintext = decryptGroupMessage(ciphertext, nonce, legacyKey);
				return { plaintext, senderDid: 'unknown' };
			} catch {}
		}
	}
	return null;
}

/**
 * Handle an incoming encrypted message (from WebSocket or polling).
 */
async function handleIncomingMessage(data: {
	groupId: string;
	senderDid: string;
	recipientDid?: string;
	epoch: number;
	ciphertext: string;
	nonce: string;
	dhPublicKey?: string;
	previousCounter?: number;
	createdAt?: string;
	id?: string;
}): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) return;

	// Don't process our own messages
	if (data.senderDid === state.identity.did) return;

	// Deduplicate: use server-assigned ID when available (polled), fall back to epoch+sender+dhKey (WS)
	// Include DH key prefix so post-ratchet messages (same epoch, different DH key) aren't falsely deduped
	const dedupId = data.id ? `srv-${data.id}` : `server-${data.epoch}-${data.senderDid}-${(data.dhPublicKey || data.ciphertext || '').slice(0, 12)}`;
	if (processedServerIds.has(dedupId)) return;

	// Also check cross-path dedup IDs early (before any await) to prevent concurrent processing
	const contentKey = data.ciphertext.slice(0, 40);
	const grpDedupId = `grp-${data.groupId}-${data.senderDid}-${contentKey}`;
	const wsId = `server-${data.epoch}-${data.senderDid}-${(data.dhPublicKey || data.ciphertext || '').slice(0, 12)}`;
	if (processedServerIds.has(grpDedupId) || processedServerIds.has(wsId)) {
		processedServerIds.add(dedupId);
		return;
	}

	// Claim ALL dedup IDs immediately (synchronously) to prevent concurrent polls/WS from racing
	processedServerIds.add(dedupId);
	processedServerIds.add(grpDedupId);
	processedServerIds.add(wsId);

	console.log(`[chat] Incoming message: group=${data.groupId.slice(0, 8)} epoch=${data.epoch} from=${data.senderDid.slice(-8)} id=${dedupId.slice(0, 16)} dh=${data.dhPublicKey ? 'yes' : 'no'}`);

	let convos = get(conversationsStore);
	let convo = convos.find(c => c.groupId === data.groupId);

	// If we don't have this conversation yet, auto-create it
	if (!convo) {
		try {
			// Try fetching as a group first
			try {
				const group = await getGroup(data.groupId);
				getOrCreateConversation(data.groupId, '', group.name, '', null, true);
				convos = get(conversationsStore);
				convo = convos.find(c => c.groupId === data.groupId);
				if (convo) {
					await bootstrapSenderKeys(data.groupId);
					convos = get(conversationsStore);
					convo = convos.find(c => c.groupId === data.groupId);
				}
			} catch {
				// Not a group — create as DM
				const senderProfile = await getProfile(data.senderDid);
				if (!senderProfile.boxPublicKey) {
					console.warn('Sender has no boxPublicKey:', data.senderDid);
					return;
				}

				const keys = await deriveConversationKeys(
					state.identity!.boxSecretKey,
					state.identity!.boxPublicKey,
					state.identity!.did,
					decodeBase64(senderProfile.boxPublicKey),
					data.senderDid
				);

				getOrCreateConversation(
					keys.groupId,
					data.senderDid,
					senderProfile.displayName,
					senderProfile.boxPublicKey,
					keys
				);

				convos = get(conversationsStore);
				convo = convos.find(c => c.groupId === data.groupId);
			}

			if (!convo) {
				console.warn('Failed to create conversation for incoming message');
				return;
			}
		} catch (e) {
			console.error('Failed to auto-create conversation:', e);
			return;
		}
	} else if (!convo.isGroup && !convo.keys) {
		// DM without keys — try to derive them
		try {
			const senderProfile = await getProfile(data.senderDid);
			if (!senderProfile.boxPublicKey) return;
			const keys = await deriveConversationKeys(
				state.identity!.boxSecretKey,
				state.identity!.boxPublicKey,
				state.identity!.did,
				decodeBase64(senderProfile.boxPublicKey),
				data.senderDid
			);
			updateConversationKeys(data.groupId, keys);
			convos = get(conversationsStore);
			convo = convos.find(c => c.groupId === data.groupId);
			if (!convo?.keys) return;
		} catch {
			return;
		}
	}

	// Don't process messages in conversations we've left — prevents ratchet desync
	// (sealed messages bypass the server's dm_leaves check since groupId is hidden)
	if (convo.left) {
		return;
	}

	// All dedup IDs were claimed immediately at the top (before async code)

	try {
		let plaintext: string;
		let updatedKeys: ConversationKeys | undefined;

		if (convo.isGroup) {
			const isSealed = data.senderDid === 'sealed';

			if (isSealed && convo.senderKeys && Object.keys(convo.senderKeys).length > 0) {
				// Sealed group message: try ALL sender keys (we don't know who sent it)
				const result = tryDecryptWithAllSenderKeys(
					data.ciphertext, data.nonce,
					convo.senderKeys, convo.groupKeys, data.epoch
				);
				if (result) {
					plaintext = result.plaintext;
				} else {
					// Keys might be stale — bootstrap and retry
					await bootstrapSenderKeys(data.groupId);
					const refreshed = get(conversationsStore).find(c => c.groupId === data.groupId);
					if (refreshed?.senderKeys) {
						const retry = tryDecryptWithAllSenderKeys(
							data.ciphertext, data.nonce,
							refreshed.senderKeys, refreshed.groupKeys, data.epoch
						);
						if (retry) {
							plaintext = retry.plaintext;
						} else {
							plaintext = 'message could not be decrypted';
						}
					} else {
						plaintext = 'message could not be decrypted';
					}
				}
			} else {
				// Unsealed group message OR no sender keys yet: use senderDid lookup
				let senderKey = convo.senderKeys?.[data.senderDid];
				const legacyKey = convo.groupKeys?.[(data.epoch ?? 0)];
				const decryptKey = senderKey || legacyKey;
				if (decryptKey) {
					try {
						plaintext = decryptGroupMessage(data.ciphertext, data.nonce, decryptKey);
					} catch {
						plaintext = 'message could not be decrypted';
					}
				} else {
					// No key for this sender — try bootstrapping
					await bootstrapSenderKeys(data.groupId);
					const refreshed = get(conversationsStore).find(c => c.groupId === data.groupId);
					const refreshedSenderKey = isSealed
						? null // Already tried all keys above
						: refreshed?.senderKeys?.[data.senderDid];
					const refreshedLegacy = refreshed?.groupKeys?.[(data.epoch ?? 0)];
					const refreshedKey = refreshedSenderKey || refreshedLegacy;
					if (refreshedKey) {
						try {
							plaintext = decryptGroupMessage(data.ciphertext, data.nonce, refreshedKey);
						} catch {
							plaintext = 'message could not be decrypted';
						}
					} else if (isSealed && refreshed?.senderKeys) {
						// Retry with all keys after bootstrap
						const retry = tryDecryptWithAllSenderKeys(
							data.ciphertext, data.nonce,
							refreshed.senderKeys, refreshed.groupKeys, data.epoch
						);
						plaintext = retry?.plaintext ?? 'message could not be decrypted';
					} else {
						plaintext = 'message could not be decrypted';
					}
				}
			}

			// If sealed group message failed to decrypt, queue for retry on key_rotation
			// (sender may not have distributed their key yet)
			if (plaintext === 'message could not be decrypted' && data.senderDid === 'sealed') {
				const existing = pendingGroupMessages.get(data.groupId) ?? [];
				const alreadyQueued = existing.some(p => p.dedupId === dedupId);
				if (!alreadyQueued) {
					existing.push({ data, dedupId, retries: 0, addedAt: Date.now() });
					pendingGroupMessages.set(data.groupId, existing);
					console.log(`[chat] Queued sealed message ${dedupId.slice(0, 16)} for retry on key_rotation (${existing.length} pending)`);
					// Schedule a fallback retry in case key_rotation already fired or never comes
					setTimeout(async () => {
						await bootstrapSenderKeys(data.groupId);
						await retryPendingGroupMessages(data.groupId);
					}, 5000);
				}
				// Keep dedup IDs SET so polls don't re-process this message
				// (the retry function handles dedup ID management itself)
				return; // Don't show "could not be decrypted" — will retry later
			}
		} else if (!convo.keys) {
			plaintext = 'message could not be decrypted';
		} else {
			const keys = deserializeKeys(convo.keys);
			console.log(`[chat] Decrypting: recvCounter=${keys.recvCounter} msgEpoch=${data.epoch} dhRatchet=${data.dhPublicKey ? 'yes' : 'legacy'}`);
			const result = await decryptMessage(keys, {
				groupId: data.groupId,
				senderDid: data.senderDid,
				recipientDid: data.recipientDid ?? state.identity.did,
				epoch: data.epoch,
				nonce: data.nonce,
				ciphertext: data.ciphertext,
				dhPublicKey: data.dhPublicKey,
				previousCounter: data.previousCounter,
			});
			plaintext = result.plaintext;
			updatedKeys = result.updatedKeys;
		}

		// Check for control messages (sealed sender token exchange)
		if (!convo.isGroup && plaintext.startsWith('{')) {
			try {
				const ctrl = JSON.parse(plaintext);
				if (ctrl.t === 'delivery_token' && ctrl.token) {
					console.log(`[sealed] Received peer delivery token from ${data.senderDid.slice(-8)}`);
					setDeliveryTokens(data.groupId, undefined, ctrl.token);

					// Always reciprocate with our latest token (peer may have rotated theirs)
					if (myGlobalDeliveryToken) {
						const refreshed = get(conversationsStore).find(c => c.groupId === data.groupId);
						if (!refreshed?.myDeliveryToken || refreshed.myDeliveryToken !== myGlobalDeliveryToken) {
							await sendTokenExchange(data.groupId, myGlobalDeliveryToken);
						}
					}

					// Mark processed but don't add to message list
					processedServerIds.add(dedupId);
					processedServerIds.add(`server-${data.epoch}-${data.senderDid}-${(data.dhPublicKey || data.ciphertext || '').slice(0, 12)}`);
					if (data.id) processedServerIds.add(`srv-${data.id}`);
					return;
				}
			} catch {}
		}

		// Parse payload (could be media in both group and DM messages)
		const parsed = parsePayload(plaintext);

		// For sealed group messages, prefer senderDid from decrypted payload
		const resolvedSenderDid = (parsed.senderDid && parsed.senderDid !== '') ? parsed.senderDid : data.senderDid;

		// Skip our own sealed group messages (server fans out to all members including sender)
		if (resolvedSenderDid === state.identity!.did) {
			processedServerIds.add(dedupId);
			return;
		}

		// Resolve sender name — use real senderDid (not 'sealed')
		let senderName: string | undefined;
		if (convo.isGroup) {
			const profileDid = resolvedSenderDid !== 'sealed' ? resolvedSenderDid : data.senderDid;
			if (profileDid !== 'sealed') {
				try {
					const profile = await getProfile(profileDid);
					senderName = profile.displayName;
				} catch {}
			}
		}

		const msg: DecryptedMessage = {
			id: dedupId,
			senderDid: resolvedSenderDid,
			senderName,
			text: parsed.text ?? plaintext,
			timestamp: data.createdAt || new Date().toISOString(),
			isMine: false,
			...('mediaId' in parsed ? {
				mediaId: (parsed as any).mediaId,
				mediaKey: (parsed as any).mediaKey,
				mediaNonce: (parsed as any).mediaNonce,
				mimeType: (parsed as any).mimeType,
				viewOnce: (parsed as any).viewOnce,
				viewed: (parsed as any).viewed,
			} : {}),
		};

		addMessage(data.groupId, msg, updatedKeys);
		// Mark both ID formats as processed (WS and poll use different IDs for same message)
		processedServerIds.add(dedupId);
		processedServerIds.add(`server-${data.epoch}-${data.senderDid}-${(data.dhPublicKey || data.ciphertext || '').slice(0, 12)}`);
		if (data.id) processedServerIds.add(`srv-${data.id}`);
		console.log(`[chat] Decrypted OK: "${plaintext.slice(0, 50)}"`);
	} catch (e) {
		console.error('[chat] Failed to decrypt message:', e, 'epoch=' + data.epoch);
	}
}

/**
 * Parse a decrypted group message payload — detect JSON media vs plain text.
 */
function parsePayload(plaintext: string): DecryptedMessage {
	try {
		if (plaintext.startsWith('{')) {
			const parsed = JSON.parse(plaintext);
			if (parsed.t === 'media') {
				return {
					id: '',
					senderDid: '',
					text: parsed.viewOnce ? 'view-once photo' : 'photo',
					timestamp: '',
					isMine: false,
					mediaId: parsed.mediaId,
					mediaKey: parsed.mediaKey,
					mediaNonce: parsed.mediaNonce,
					mimeType: parsed.mimeType,
					viewOnce: parsed.viewOnce,
					viewed: false,
				};
			}
			// Sealed group message — senderDid embedded in payload
			if (parsed.t === 'sealed_group') {
				// Re-parse in case text itself is a media payload
				const innerParsed = parsePayload(parsed.text);
				return {
					...innerParsed,
					senderDid: parsed.senderDid || '',
				};
			}
		}
	} catch {}
	return { id: '', senderDid: '', text: plaintext, timestamp: '', isMine: false };
}

/**
 * Handle an incoming group message (WS real-time).
 * Uses Sender Keys: look up the sender's key by senderDid to decrypt.
 */
async function handleIncomingGroupMessage(data: {
	groupId: string;
	senderDid: string;
	text?: string; // legacy plaintext
	ciphertext?: string;
	nonce?: string;
	epoch?: number;
}): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) return;
	if (data.senderDid === state.identity.did) return;

	// Content-based dedup key — must match across WS and polling paths
	const contentKey = (data.ciphertext || data.text || '').slice(0, 40);
	const dedupId = `grp-${data.groupId}-${data.senderDid}-${contentKey}`;
	if (processedServerIds.has(dedupId)) return;

	// Claim immediately to prevent concurrent processing (WS + poll race)
	processedServerIds.add(dedupId);

	const convos = get(conversationsStore);
	let convo = convos.find(c => c.groupId === data.groupId);

	if (!convo) {
		// Auto-create group conversation and bootstrap sender keys
		try {
			const group = await getGroup(data.groupId);
			getOrCreateConversation(data.groupId, '', group.name, '', null, true);
			convo = get(conversationsStore).find(c => c.groupId === data.groupId);
			if (convo) {
				await bootstrapSenderKeys(data.groupId);
				convo = get(conversationsStore).find(c => c.groupId === data.groupId);
			}
		} catch {
			return;
		}
	}
	if (!convo) return;

	let plaintext: string | undefined;
	let resolvedSenderDid = data.senderDid;

	if (data.ciphertext && data.nonce !== undefined) {
		const isSealed = data.senderDid === 'sealed';

		if (isSealed && convo.senderKeys && Object.keys(convo.senderKeys).length > 0) {
			// Sealed group message: try ALL sender keys (we don't know who sent it)
			const result = tryDecryptWithAllSenderKeys(
				data.ciphertext, data.nonce,
				convo.senderKeys, convo.groupKeys, data.epoch
			);
			if (result) {
				plaintext = result.plaintext;
				resolvedSenderDid = result.senderDid;
			} else {
				// Keys might be stale — bootstrap and retry
				await bootstrapSenderKeys(data.groupId);
				const refreshed = get(conversationsStore).find(c => c.groupId === data.groupId);
				if (refreshed?.senderKeys) {
					const retry = tryDecryptWithAllSenderKeys(
						data.ciphertext, data.nonce,
						refreshed.senderKeys, refreshed.groupKeys, data.epoch
					);
					if (retry) {
						plaintext = retry.plaintext;
						resolvedSenderDid = retry.senderDid;
					}
				}
			}
		}

		if (plaintext === undefined && !isSealed) {
			// Unsealed group message: use senderDid lookup directly
			let senderKey = convo.senderKeys?.[data.senderDid];
			const legacyKey = convo.groupKeys?.[(data.epoch ?? 0)];

			if (!senderKey && !legacyKey) {
				await bootstrapSenderKeys(data.groupId);
				const refreshed = get(conversationsStore).find(c => c.groupId === data.groupId);
				senderKey = refreshed?.senderKeys?.[data.senderDid];
			}

			const decryptKey = senderKey || legacyKey;
			if (decryptKey) {
				try {
					plaintext = decryptGroupMessage(data.ciphertext, data.nonce!, decryptKey);
				} catch {
					plaintext = 'message could not be decrypted';
				}
			}
		}

		// If still no plaintext (sealed with no keys, or all decryption attempts failed)
		if (plaintext === undefined) {
			// Last resort: bootstrap (if not done above for sealed) and try
			if (isSealed) {
				await bootstrapSenderKeys(data.groupId);
				const refreshed = get(conversationsStore).find(c => c.groupId === data.groupId);
				if (refreshed?.senderKeys && Object.keys(refreshed.senderKeys).length > 0) {
					const retry = tryDecryptWithAllSenderKeys(
						data.ciphertext, data.nonce,
						refreshed.senderKeys, refreshed.groupKeys, data.epoch
					);
					if (retry) {
						plaintext = retry.plaintext;
						resolvedSenderDid = retry.senderDid;
					}
				}
			}
			if (plaintext === undefined) {
				// If sealed and can't decrypt, queue for retry on key_rotation
				if (isSealed) {
					const existing = pendingGroupMessages.get(data.groupId) ?? [];
					const alreadyQueued = existing.some(p => p.dedupId === dedupId);
					if (!alreadyQueued) {
						existing.push({ data: { ...data, senderDid: data.senderDid }, dedupId, retries: 0, addedAt: Date.now() });
						pendingGroupMessages.set(data.groupId, existing);
						console.log(`[chat] Queued sealed WS message ${dedupId.slice(0, 16)} for retry on key_rotation (${existing.length} pending)`);
						// Schedule a fallback retry
						setTimeout(async () => {
							await bootstrapSenderKeys(data.groupId);
							await retryPendingGroupMessages(data.groupId);
						}, 5000);
					}
					// Keep dedup IDs SET so future polls don't re-process
					return;
				}
				plaintext = 'message could not be decrypted';
			}
		}
	} else if (data.text) {
		// Legacy plaintext group message
		plaintext = data.text;
	} else {
		return;
	}

	// Parse payload (could be media or sealed_group with embedded senderDid)
	const parsed = parsePayload(plaintext);

	// For sealed group messages, the real senderDid is inside the decrypted payload
	if (parsed.senderDid && parsed.senderDid !== '') {
		resolvedSenderDid = parsed.senderDid;
	}

	// Skip our own sealed group messages (server fans out to all members)
	if (resolvedSenderDid === state.identity!.did) {
		return;
	}

	// Resolve sender display name
	let senderName: string | undefined;
	const profileDid = resolvedSenderDid !== 'sealed' ? resolvedSenderDid : data.senderDid;
	if (profileDid !== 'sealed') {
		try {
			const profile = await getProfile(profileDid);
			senderName = profile.displayName;
		} catch {}
	}

	const msg: DecryptedMessage = {
		...parsed,
		id: dedupId,
		senderDid: resolvedSenderDid,
		senderName,
		timestamp: new Date().toISOString(),
		isMine: false,
	};
	addMessage(data.groupId, msg);
}

/**
 * Handle being kicked from a group.
 */
function handleKicked(data: { groupId: string }): void {
	console.log(`[chat] Kicked from group: ${data.groupId}`);
	markConversationLeft(data.groupId);

	const msg: DecryptedMessage = {
		id: `system-kicked-${Date.now()}`,
		senderDid: 'system',
		text: 'you were removed from this group',
		timestamp: new Date().toISOString(),
		isMine: false,
	};
	addMessage(data.groupId, msg);
}

/**
 * Handle an incoming sealed message (from WebSocket or polling).
 * Unseal the outer layer, extract senderDid, then delegate to handleIncomingMessage.
 */
async function handleIncomingSealedMessage(data: {
	sealedPayload: string;
	ephemeralPublicKey: string;
	nonce: string;
	id?: string;
	createdAt?: string;
}): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) return;

	// Dedup by sealed message ID
	const dedupId = data.id ? `sealed-${data.id}` : `sealed-${data.sealedPayload.slice(0, 30)}`;
	if (processedServerIds.has(dedupId)) return;

	try {
		// Unseal the outer layer
		const inner = unsealMessage(
			data.sealedPayload,
			data.ephemeralPublicKey,
			data.nonce,
			state.identity.boxSecretKey
		);

		console.log(`[sealed] Unsealed message from ${inner.senderDid.slice(-8)} group=${inner.groupId.slice(0, 8)}`);

		// Delegate to existing handler with the inner envelope data
		await handleIncomingMessage({
			groupId: inner.groupId,
			senderDid: inner.senderDid,
			recipientDid: state.identity.did,
			epoch: inner.epoch,
			ciphertext: inner.ciphertext,
			nonce: inner.nonce,
			dhPublicKey: inner.dhPublicKey,
			previousCounter: inner.previousCounter,
			createdAt: data.createdAt || inner.timestamp,
			id: data.id,
		});

		processedServerIds.add(dedupId);
	} catch (e) {
		console.error('[sealed] Failed to unseal message:', e);
	}
}

/**
 * Send a delivery token exchange control message (encrypted via Double Ratchet).
 * This is invisible to the server (looks like normal ciphertext) and invisible
 * to the UI (detected and suppressed in handleIncomingMessage).
 */
async function sendTokenExchange(groupId: string, token: string): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) return;

	const convos = get(conversationsStore);
	const convo = convos.find(c => c.groupId === groupId);
	if (!convo || !convo.keys || convo.isGroup) return;

	const controlPayload = JSON.stringify({ t: 'delivery_token', token });

	const keys = deserializeKeys(convo.keys);
	const { encrypted, updatedKeys } = await encryptMessage(keys, state.identity.did, controlPayload);

	// Update keys in store (control message advances the ratchet)
	updateConversationKeys(groupId, updatedKeys);

	// Store our token in the conversation
	setDeliveryTokens(groupId, token, undefined);

	// Send via REST (unsealed — this is before sealed sender is active)
	// Server relays to recipient via WS after REST store — no client wsSend needed
	try {
		await apiSendMessage({
			groupId: encrypted.groupId,
			senderDid: encrypted.senderDid,
			recipientDid: encrypted.recipientDid,
			epoch: encrypted.epoch,
			ciphertext: encrypted.ciphertext,
			nonce: encrypted.nonce,
			dhPublicKey: encrypted.dhPublicKey,
			previousCounter: encrypted.previousCounter,
		});
	} catch (e) {
		console.error('[sealed] Failed to send token exchange via REST:', e);
	}

	processedServerIds.add(`server-${encrypted.epoch}-${state.identity.did}`);
	console.log(`[sealed] Sent delivery token to ${convo.peerDid.slice(-8)}`);
}

/**
 * Poll for missed messages.
 */
function startPolling(): void {
	if (pollTimer) return;

	// Use setTimeout (not setInterval) so the next poll only fires AFTER the current
	// one finishes. setInterval causes concurrent polls that race past dedup checks.
	async function pollLoop() {
		await doPoll();
		pollTimer = setTimeout(pollLoop, 10000);
	}
	pollLoop();
}

/**
 * Trigger an immediate poll for missed messages (e.g. after accepting an invitation).
 */
export async function forcePoll(): Promise<void> {
	await doPoll();
}

async function doPoll(): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) return;

	try {
		const result = await fetchMessages(state.identity.did, lastPollTime ?? undefined);

		// Handle new format { messages, sealed } or legacy flat array
		const messages = Array.isArray(result) ? result : result.messages;
		const sealed = Array.isArray(result) ? [] : (result.sealed ?? []);

		// Only log genuinely new (unprocessed) messages to avoid console spam
		const newMessages = messages.filter((msg: any) => {
			const id = msg.id ? `srv-${msg.id}` : `server-${msg.epoch}-${msg.senderDid}-${(msg.dhPublicKey || msg.ciphertext || '').slice(0, 12)}`;
			return !processedServerIds.has(id);
		});
		const newSealed = sealed.filter((s: any) => {
			const id = s.id ? `srv-${s.id}` : `sealed-${s.deliveryToken?.slice(0, 12)}`;
			return !processedServerIds.has(id);
		});
		if (newMessages.length > 0 || newSealed.length > 0) {
			console.log(`[chat] Poll found ${newMessages.length} new message(s), ${newSealed.length} new sealed`);
		}

		for (const msg of messages) {
			await handleIncomingMessage(msg);
		}

		for (const s of sealed) {
			await handleIncomingSealedMessage(s);
		}

		if (messages.length > 0) {
			lastPollTime = messages[messages.length - 1].createdAt;
		}
		if (sealed.length > 0) {
			const lastSealed = sealed[sealed.length - 1].createdAt;
			if (!lastPollTime || lastSealed > lastPollTime) {
				lastPollTime = lastSealed;
			}
		}
	} catch (e) {
		console.error('[chat] Poll error:', e);
	}
}

// --- Sender Keys Management (Signal-style) ---

/**
 * Bootstrap sender keys: fetch all wrapped keys from server, unwrap them,
 * store in conversation.  Each key is a sender's key wrapped for us.
 * Also bootstraps legacy group keys for backward compat.
 */
export async function bootstrapSenderKeys(groupId: string): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) return;

	try {
		const wrappedKeys = await getMyGroupKeys(groupId, state.identity.did);
		if (wrappedKeys.length === 0) return;

		const senderKeysMap: Record<string, string> = {};
		const legacyKeysMap: Record<number, string> = {};
		let maxEpoch = 0;

		for (const wk of wrappedKeys) {
			try {
				const senderProfile = await getProfile(wk.senderDid);
				if (!senderProfile.boxPublicKey) continue;

				const unwrapped = unwrapSenderKey(
					wk.wrappedKey,
					wk.wrappedKeyNonce,
					decodeBase64(senderProfile.boxPublicKey),
					state.identity.boxSecretKey
				);

				// Store by senderDid (Sender Keys model)
				senderKeysMap[wk.senderDid] = unwrapped.senderKey;
				// Also store by epoch for legacy compat
				legacyKeysMap[wk.epoch] = unwrapped.senderKey;
				if (wk.epoch > maxEpoch) maxEpoch = wk.epoch;

				if (unwrapped.deliveryToken) {
					setGroupDeliveryToken(groupId, unwrapped.deliveryToken);
				}
			} catch (e) {
				console.error(`[chat] Failed to unwrap sender key from ${wk.senderDid.slice(-8)}:`, e);
			}
		}

		if (Object.keys(senderKeysMap).length > 0) {
			updateSenderKeys(groupId, senderKeysMap);
		}
		if (Object.keys(legacyKeysMap).length > 0) {
			updateGroupConversationKeys(groupId, legacyKeysMap, maxEpoch);
		}

		// Exchange profile keys with group members (fire-and-forget)
	} catch (e) {
		console.error('[chat] Failed to bootstrap sender keys:', e);
	}
}

/** @deprecated alias for bootstrapSenderKeys */
export const bootstrapGroupKeys = bootstrapSenderKeys;

/**
 * Generate and distribute MY sender key for a group.
 * Every member calls this — no admin dependency.
 */
export async function distributeMySenderKey(groupId: string): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) return;

	const convo = get(conversationsStore).find(c => c.groupId === groupId);
	let mySenderKey = convo?.mySenderKey;
	const epoch = convo?.mySenderKeyEpoch ?? 0;

	// Generate a new sender key if we don't have one
	if (!mySenderKey) {
		mySenderKey = generateSenderKey();
	}

	// Get current group members
	const group = await getGroup(groupId);
	const membersWithKeys = group.members
		.filter((m: any) => m.boxPublicKey && m.did !== state.identity!.did) as Array<{ did: string; boxPublicKey: string }>;

	if (membersWithKeys.length === 0) {
		// No other members with keys yet — just store locally
		updateSenderKeys(groupId, { [state.identity.did]: mySenderKey }, mySenderKey, epoch);
		return;
	}

	// Resolve delivery token for sealed sender.
	// Strategy: if we already have a canonical token (from bootstrap or prior distribution),
	// use it. Otherwise generate a candidate and try to register — server uses INSERT-OR-IGNORE
	// (first-writer-wins) to prevent race conditions where multiple members independently
	// generate different tokens.
	const existingToken = convo?.groupDeliveryToken;
	let groupToken: string | undefined = existingToken;

	if (!existingToken) {
		// No local token — generate a candidate and try to register it
		const candidate = generateDeliveryToken();
		const candidateHash = await hashDeliveryToken(candidate);
		try {
			const result = await registerGroupDeliveryToken(groupId, candidateHash);
			if (!result.exists) {
				// We're the first to register — our token is canonical
				groupToken = candidate;
			}
			// If exists: another member registered first — we'll get their token via bootstrap.
			// Don't use our candidate (leave groupToken undefined).
		} catch {
			// Registration failed — proceed without sealed sender
		}
	}

	// Wrap my sender key for each other member (include delivery token only if canonical)
	const wrappedKeys = wrapSenderKeyForMembers(mySenderKey, state.identity.boxSecretKey, membersWithKeys, groupToken);

	// Store on server
	await storeGroupKeys(groupId, state.identity.did, wrappedKeys, epoch);

	// Store locally
	updateSenderKeys(groupId, { [state.identity.did]: mySenderKey }, mySenderKey, epoch);
	if (groupToken) {
		setGroupDeliveryToken(groupId, groupToken);
	}

	// Notify others to fetch the new key
	wsSend({
		type: 'key_rotation',
		groupId,
		epoch,
		memberDids: membersWithKeys.map(m => m.did),
	});

	console.log(`[sender-keys] Distributed my sender key for ${groupId.slice(0, 8)} to ${membersWithKeys.length} members (sealed: ${!!groupToken})`);
}

/** @deprecated compat shim */
export async function distributeGroupKey(
	groupId: string,
	members: Array<{ did: string; boxPublicKey: string }>,
	epoch: number = 0
): Promise<void> {
	return distributeMySenderKey(groupId);
}

/** @deprecated compat shim */
export async function redistributeGroupKey(
	groupId: string,
	members: Array<{ did: string; boxPublicKey: string }>,
): Promise<void> {
	return distributeMySenderKey(groupId);
}

/**
 * Rotate my sender key (after member kick/leave).
 * Generates a NEW key so the kicked member can't read future messages.
 */
export async function rotateGroupKey(
	groupId: string,
	remainingMembers: Array<{ did: string; boxPublicKey: string }>
): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) return;

	const convo = get(conversationsStore).find(c => c.groupId === groupId);
	const newEpoch = (convo?.mySenderKeyEpoch ?? 0) + 1;

	const newKey = generateSenderKey();

	// Rotate the group delivery token too
	const groupToken = generateDeliveryToken();
	const tokenHash = await hashDeliveryToken(groupToken);

	const others = remainingMembers.filter(m => m.did !== state.identity!.did);
	const wrappedKeys = wrapSenderKeyForMembers(newKey, state.identity.boxSecretKey, others, groupToken);

	await storeGroupKeys(groupId, state.identity.did, wrappedKeys, newEpoch);

	// Force-overwrite the delivery token (rotation after member kick/leave)
	try {
		await registerGroupDeliveryToken(groupId, tokenHash, true);
	} catch {}

	// Store locally
	updateSenderKeys(groupId, { [state.identity.did]: newKey }, newKey, newEpoch);
	setGroupDeliveryToken(groupId, groupToken);

	// Notify others to fetch new key
	wsSend({
		type: 'key_rotation',
		groupId,
		epoch: newEpoch,
		memberDids: others.map(m => m.did),
	});
}

/**
 * Handle a member_joined WS notification.
 * Sender Keys: just re-wrap MY existing sender key for the new member.
 * No admin dependency — every online member does this independently.
 */
async function handleMemberJoined(data: { groupId: string; memberDid: string }): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) return;

	try {
		const convo = get(conversationsStore).find(c => c.groupId === data.groupId);
		if (!convo?.mySenderKey) return; // I don't have a sender key yet, nothing to share

		// Re-distribute my sender key (will wrap for all members including the new one)
		await distributeMySenderKey(data.groupId);
		console.log(`[sender-keys] Re-wrapped my key for ${data.groupId.slice(0, 8)} after ${data.memberDid.slice(-8)} joined`);
	} catch (e) {
		console.error('[sender-keys] Failed to rewrap key on member join:', e);
	}
}

/**
 * Exchange profile keys with all members of a group.
 * Wraps own profile key for each member, stores on server.
 * Called after joining a group or when a new member joins.
 */
/**
 * Handle key_rotation WS event — fetch new sender keys from server,
 * then retry any pending sealed group messages that couldn't be decrypted.
 */
async function handleKeyRotation(data: { groupId: string; epoch: number }): Promise<void> {
	await bootstrapSenderKeys(data.groupId);
	await retryPendingGroupMessages(data.groupId);

	// Schedule a delayed retry in case keys weren't on the server yet when bootstrap ran
	const pending = pendingGroupMessages.get(data.groupId);
	if (pending && pending.length > 0) {
		setTimeout(async () => {
			await bootstrapSenderKeys(data.groupId);
			await retryPendingGroupMessages(data.groupId);
		}, 3000);
	}
}

/**
 * Retry decrypting pending sealed group messages after new sender keys arrived.
 */
async function retryPendingGroupMessages(groupId: string): Promise<void> {
	const pending = pendingGroupMessages.get(groupId);
	if (!pending || pending.length === 0) return;

	const now = Date.now();
	// Filter out expired messages
	const valid = pending.filter(p => now - p.addedAt < PENDING_TTL);
	if (valid.length === 0) {
		pendingGroupMessages.delete(groupId);
		return;
	}

	console.log(`[chat] Retrying ${valid.length} pending sealed message(s) for ${groupId.slice(0, 8)}`);

	const stillPending: PendingGroupMessage[] = [];

	for (const pm of valid) {
		pm.retries++;

		// Try decrypting with fresh sender keys
		const convo = get(conversationsStore).find(c => c.groupId === groupId);
		if (!convo?.senderKeys || Object.keys(convo.senderKeys).length === 0) {
			if (pm.retries < MAX_PENDING_RETRIES) stillPending.push(pm);
			continue;
		}

		const result = tryDecryptWithAllSenderKeys(
			pm.data.ciphertext!, pm.data.nonce!,
			convo.senderKeys, convo.groupKeys, pm.data.epoch
		);

		if (result) {
			console.log(`[chat] Retry succeeded for pending message ${pm.dedupId.slice(0, 16)}`);
			// Parse the decrypted payload
			const parsed = parsePayload(result.plaintext);
			const resolvedSenderDid = (parsed.senderDid && parsed.senderDid !== '') ? parsed.senderDid : result.senderDid;

			// Skip own messages
			const state = get(identityStore);
			if (resolvedSenderDid === state.identity?.did) continue;

			// Resolve sender name
			let senderName: string | undefined;
			if (resolvedSenderDid !== 'sealed') {
				try {
					const profile = await getProfile(resolvedSenderDid);
					senderName = profile.displayName;
				} catch {}
			}

			const msg: DecryptedMessage = {
				...parsed,
				id: pm.dedupId || `retry-${Date.now()}`,
				senderDid: resolvedSenderDid,
				senderName,
				text: parsed.text ?? result.plaintext,
				timestamp: pm.data.createdAt || new Date().toISOString(),
				isMine: false,
			};
			addMessage(groupId, msg);

			// Mark as processed
			processedServerIds.add(pm.dedupId);
			const contentKey = (pm.data.ciphertext || '').slice(0, 40);
			processedServerIds.add(`grp-${pm.data.groupId}-${pm.data.senderDid}-${contentKey}`);
			if (pm.data.id) processedServerIds.add(`srv-${pm.data.id}`);
		} else if (pm.retries < MAX_PENDING_RETRIES) {
			stillPending.push(pm);
		} else {
			console.warn(`[chat] Giving up on pending message ${pm.dedupId.slice(0, 16)} after ${pm.retries} retries`);
			// Show as unreadable after max retries
			const msg: DecryptedMessage = {
				id: pm.dedupId || `failed-${Date.now()}`,
				senderDid: 'sealed',
				text: 'message could not be decrypted',
				timestamp: pm.data.createdAt || new Date().toISOString(),
				isMine: false,
			};
			addMessage(groupId, msg);
			processedServerIds.add(pm.dedupId);
		}
	}

	if (stillPending.length > 0) {
		pendingGroupMessages.set(groupId, stillPending);
	} else {
		pendingGroupMessages.delete(groupId);
	}
}

/**
 * Handle media_viewed WS event — mark media as viewed locally.
 */
function handleMediaViewedEvent(data: { groupId: string; messageId: string; mediaId: string }): void {
	// The sender sees that the recipient viewed their media
	// We could track this but for now just log it
	console.log(`[chat] Media viewed: ${data.mediaId} in group ${data.groupId}`);
}

/**
 * Notify that we viewed a media message — wipe key locally, tell server + sender.
 */
export async function handleMediaViewed(
	groupId: string,
	messageId: string,
	mediaId: string,
	senderDid: string
): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) return;

	// Wipe key locally
	markMediaViewed(groupId, messageId);

	// Tell server to delete the blob
	try {
		await notifyMediaViewed(mediaId, state.identity.did);
	} catch {}

	// Notify sender via WS
	wsSend({
		type: 'media_viewed',
		groupId,
		messageId,
		mediaId,
		recipientDid: senderDid,
	});
}

/**
 * Clean up the chat service.
 */
export function destroyChat(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	if (unsubMessage) {
		unsubMessage();
		unsubMessage = null;
	}
	initialized = false;
	lastPollTime = null;
	myGlobalDeliveryToken = null;
	processedServerIds.clear();
	disconnect();
}
