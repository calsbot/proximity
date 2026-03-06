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
	markMediaViewed,
	deserializeKeys,
	loadConversations,
	markConversationLeft,
	unmarkConversationLeft,
	type DecryptedMessage
} from '$lib/stores/conversations';
import {
	deriveConversationKeys,
	encryptMessage,
	decryptMessage,
	type ConversationKeys
} from '$lib/crypto/messaging';
import { decodeBase64 } from '$lib/crypto/util';
import {
	generateGroupKey,
	wrapGroupKeyForMembers,
	unwrapGroupKey,
	encryptGroupMessage,
	decryptGroupMessage,
} from '$lib/crypto/group';
import { encryptMedia, fileToUint8Array } from '$lib/crypto/media';
import {
	sendMessage as apiSendMessage,
	fetchMessages,
	getProfile,
	getGroup,
	storeGroupKeys,
	getMyGroupKeys,
	uploadMedia,
	notifyMediaViewed,
} from '$lib/api';
import { connect, onMessage, wsSend, disconnect } from './websocket';

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastPollTime: string | null = null;
let initialized = false;
let unsubMessage: (() => void) | null = null;
// Track server message IDs we've already processed (dedup for gte polling)
const processedServerIds = new Set<string>();

/**
 * Initialize the chat service: load conversations, connect WS, start polling.
 */
export async function initChat(): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) return;

	// Prevent duplicate initialization
	if (initialized) return;
	initialized = true;

	await loadConversations();

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
		if (data.type === 'system_message') {
			const msg: DecryptedMessage = {
				id: `system-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				senderDid: 'system',
				text: data.text,
				timestamp: new Date().toISOString(),
				isMine: false,
			};
			addMessage(data.groupId, msg);
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

	// Send via REST API (persisted on server)
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

	// Also send via WebSocket for real-time delivery
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

	// Upload encrypted blob to server
	const blob = new Blob([encrypted.encryptedBlob]);
	const result = await uploadMedia(state.identity.did, blob, 'application/octet-stream', undefined, viewOnce);

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

	// Send via REST
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

	// Also send via WebSocket for real-time delivery
	wsSend({
		type: 'message',
		groupId: encMsg.groupId,
		senderDid: encMsg.senderDid,
		recipientDid: encMsg.recipientDid,
		epoch: encMsg.epoch,
		ciphertext: encMsg.ciphertext,
		nonce: encMsg.nonce,
		dhPublicKey: encMsg.dhPublicKey,
		previousCounter: encMsg.previousCounter,
	});

	processedServerIds.add(`server-${encMsg.epoch}-${state.identity.did}`);
}

/**
 * Send an encrypted message in a group chat.
 * Uses the shared symmetric group key (nacl.secretbox).
 */
export async function sendGroupMessage(groupId: string, text: string, memberDids: string[]): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) throw new Error('No identity');

	const convos = get(conversationsStore);
	const convo = convos.find(c => c.groupId === groupId);
	if (!convo) throw new Error('Group conversation not found');

	const epoch = convo.groupKeyEpoch ?? 0;
	const groupKey = convo.groupKeys?.[epoch];

	let ciphertext: string;
	let nonce: string;

	if (groupKey) {
		// Encrypt with group key
		const encrypted = encryptGroupMessage(text, groupKey);
		ciphertext = encrypted.ciphertext;
		nonce = encrypted.nonce;
	} else {
		// Fallback: base64 plaintext (legacy unencrypted groups)
		ciphertext = btoa(text);
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

	// Send via REST to each member (server stores per-recipient)
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

	// Also send via WebSocket for real-time delivery
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

/**
 * Send a view-once media message in a group chat.
 * Encrypts media with a random key, uploads the blob, then sends a structured
 * JSON payload (encrypted with group key) containing the mediaId + mediaKey.
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

	let epoch = convo.groupKeyEpoch ?? 0;
	let groupKey = convo.groupKeys?.[epoch];

	// If no group key, try bootstrapping before giving up
	if (!groupKey) {
		await bootstrapGroupKeys(groupId);
		convos = get(conversationsStore);
		convo = convos.find(c => c.groupId === groupId);
		if (!convo) throw new Error('Group conversation not found');
		epoch = convo.groupKeyEpoch ?? 0;
		groupKey = convo.groupKeys?.[epoch];
	}

	// Encrypt the media with a random key
	const fileData = await fileToUint8Array(file);
	const encrypted = encryptMedia(fileData);

	// Upload encrypted blob to server
	const blob = new Blob([encrypted.encryptedBlob]);
	const result = await uploadMedia(state.identity.did, blob, 'application/octet-stream', undefined, viewOnce);

	// Create structured payload
	const payload = JSON.stringify({
		t: 'media',
		mediaId: result.mediaId,
		mediaKey: encrypted.key,
		mediaNonce: encrypted.nonce,
		mimeType: file.type || 'image/jpeg',
		viewOnce,
	});

	let ciphertext: string;
	let nonce: string;

	if (groupKey) {
		const encPayload = encryptGroupMessage(payload, groupKey);
		ciphertext = encPayload.ciphertext;
		nonce = encPayload.nonce;
	} else {
		// Fallback: base64 plaintext (matches sendGroupMessage legacy path)
		ciphertext = btoa(payload);
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

	// Send via REST to each member
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

	// WS for real-time
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

	// Deduplicate: use server-assigned ID when available (polled), fall back to epoch+sender (WS)
	const dedupId = data.id ? `srv-${data.id}` : `server-${data.epoch}-${data.senderDid}`;
	if (processedServerIds.has(dedupId)) return;

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
					await bootstrapGroupKeys(data.groupId);
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

	// Content-based dedup key — matches WS group message handler
	const contentKey = data.ciphertext.slice(0, 40);
	const grpDedupId = `grp-${data.groupId}-${data.senderDid}-${contentKey}`;
	if (processedServerIds.has(grpDedupId)) {
		processedServerIds.add(dedupId);
		return;
	}

	// Fallback dedup: check if we already have this exact message or a WS/poll version of it
	const wsId = `server-${data.epoch}-${data.senderDid}`;
	if (convo.messages.some(m => m.id === dedupId || m.id === wsId || m.id === grpDedupId)) {
		processedServerIds.add(dedupId);
		processedServerIds.add(wsId);
		processedServerIds.add(grpDedupId);
		return;
	}

	try {
		let plaintext: string;
		let updatedKeys: ConversationKeys | undefined;

		if (convo.isGroup) {
			// Group message: try encrypted decryption first, fall back to legacy base64
			const epoch = data.epoch ?? 0;
			const groupKey = convo.groupKeys?.[epoch];
			if (groupKey) {
				try {
					plaintext = decryptGroupMessage(data.ciphertext, data.nonce, groupKey);
				} catch {
					// Fall back to legacy base64
					try { plaintext = atob(data.ciphertext); } catch { plaintext = data.ciphertext; }
				}
			} else {
				// Legacy unencrypted
				try { plaintext = atob(data.ciphertext); } catch { plaintext = data.ciphertext; }
			}
		} else if (!convo.keys) {
			try { plaintext = atob(data.ciphertext); } catch { plaintext = data.ciphertext; }
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

		// Resolve sender name for group messages
		let senderName: string | undefined;
		if (convo.isGroup) {
			try {
				const profile = await getProfile(data.senderDid);
				senderName = profile.displayName;
			} catch {}
		}

		// Parse payload (could be media in both group and DM messages)
		const parsed = parsePayload(plaintext);

		const msg: DecryptedMessage = {
			id: dedupId,
			senderDid: data.senderDid,
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
		processedServerIds.add(`server-${data.epoch}-${data.senderDid}`);
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
		}
	} catch {}
	return { id: '', senderDid: '', text: plaintext, timestamp: '', isMine: false };
}

/**
 * Handle an incoming group message (WS real-time, encrypted with group key).
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

	const convos = get(conversationsStore);
	let convo = convos.find(c => c.groupId === data.groupId);

	if (!convo) {
		// Auto-create group conversation and bootstrap keys
		try {
			const group = await getGroup(data.groupId);
			getOrCreateConversation(data.groupId, '', group.name, '', null, true);
			convo = get(conversationsStore).find(c => c.groupId === data.groupId);
			if (convo) {
				await bootstrapGroupKeys(data.groupId);
				convo = get(conversationsStore).find(c => c.groupId === data.groupId);
			}
		} catch {
			return;
		}
	}
	if (!convo) return;

	let plaintext: string;

	if (data.ciphertext && data.nonce !== undefined) {
		// Encrypted group message
		const epoch = data.epoch ?? 0;
		const groupKey = convo.groupKeys?.[epoch];
		if (!groupKey) {
			// Try bootstrapping keys
			await bootstrapGroupKeys(data.groupId);
			const refreshed = get(conversationsStore).find(c => c.groupId === data.groupId);
			const key = refreshed?.groupKeys?.[epoch];
			if (!key) {
				console.error('[chat] No group key for epoch', epoch);
				return;
			}
			try {
				plaintext = decryptGroupMessage(data.ciphertext, data.nonce!, key);
			} catch (e) {
				console.error('[chat] Group message decryption failed:', e);
				return;
			}
		} else {
			try {
				plaintext = decryptGroupMessage(data.ciphertext, data.nonce!, groupKey);
			} catch (e) {
				console.error('[chat] Group message decryption failed:', e);
				return;
			}
		}
	} else if (data.text) {
		// Legacy plaintext group message
		plaintext = data.text;
	} else {
		return;
	}

	// Parse payload (could be media)
	const parsed = parsePayload(plaintext);

	// Resolve sender display name
	let senderName: string | undefined;
	try {
		const profile = await getProfile(data.senderDid);
		senderName = profile.displayName;
	} catch {}

	const msg: DecryptedMessage = {
		...parsed,
		id: dedupId,
		senderDid: data.senderDid,
		senderName,
		timestamp: new Date().toISOString(),
		isMine: false,
	};
	addMessage(data.groupId, msg);

	// Mark as processed so polling doesn't duplicate
	processedServerIds.add(dedupId);
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
 * Poll for missed messages.
 */
function startPolling(): void {
	if (pollTimer) return;

	// Do an immediate first poll to catch any missed messages
	doPoll();

	pollTimer = setInterval(doPoll, 10000);
}

async function doPoll(): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) return;

	try {
		const messages = await fetchMessages(state.identity.did, lastPollTime ?? undefined);
		if (messages.length > 0) {
			console.log(`[chat] Poll found ${messages.length} message(s)`);
		}
		for (const msg of messages) {
			await handleIncomingMessage(msg);
		}
		if (messages.length > 0) {
			lastPollTime = messages[messages.length - 1].createdAt;
		}
	} catch (e) {
		console.error('[chat] Poll error:', e);
	}
}

// --- Group Key Management ---

/**
 * Bootstrap group keys: fetch wrapped keys from server, unwrap them, store in conversation.
 */
export async function bootstrapGroupKeys(groupId: string): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) return;

	try {
		const wrappedKeys = await getMyGroupKeys(groupId, state.identity.did);
		if (wrappedKeys.length === 0) return;

		const keysMap: Record<number, string> = {};
		let maxEpoch = 0;

		for (const wk of wrappedKeys) {
			try {
				// Get sender's boxPublicKey to unwrap
				const senderProfile = await getProfile(wk.senderDid);
				if (!senderProfile.boxPublicKey) continue;

				const groupKey = unwrapGroupKey(
					wk.wrappedKey,
					wk.wrappedKeyNonce,
					decodeBase64(senderProfile.boxPublicKey),
					state.identity.boxSecretKey
				);
				keysMap[wk.epoch] = groupKey;
				if (wk.epoch > maxEpoch) maxEpoch = wk.epoch;
			} catch (e) {
				console.error(`[chat] Failed to unwrap key epoch=${wk.epoch}:`, e);
			}
		}

		if (Object.keys(keysMap).length > 0) {
			updateGroupConversationKeys(groupId, keysMap, maxEpoch);
		}
	} catch (e) {
		console.error('[chat] Failed to bootstrap group keys:', e);
	}
}

/**
 * Generate and distribute a group key after group creation or when new member joins.
 * Called by the admin/creator.
 */
export async function distributeGroupKey(
	groupId: string,
	members: Array<{ did: string; boxPublicKey: string }>,
	epoch: number = 0
): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) return;

	const groupKey = generateGroupKey();
	const wrappedKeys = wrapGroupKeyForMembers(groupKey, state.identity.boxSecretKey, members);

	await storeGroupKeys(groupId, state.identity.did, wrappedKeys, epoch);

	// Store locally too
	updateGroupConversationKeys(groupId, { [epoch]: groupKey }, epoch);
}

/**
 * Rotate the group key (after member kick/leave).
 * Generates a new key, wraps for remaining members, stores on server.
 */
export async function rotateGroupKey(
	groupId: string,
	remainingMembers: Array<{ did: string; boxPublicKey: string }>
): Promise<void> {
	const state = get(identityStore);
	if (!state.identity) return;

	const convo = get(conversationsStore).find(c => c.groupId === groupId);
	const newEpoch = (convo?.groupKeyEpoch ?? 0) + 1;

	const groupKey = generateGroupKey();
	const wrappedKeys = wrapGroupKeyForMembers(groupKey, state.identity.boxSecretKey, remainingMembers);

	await storeGroupKeys(groupId, state.identity.did, wrappedKeys, newEpoch);

	// Store locally
	updateGroupConversationKeys(groupId, { [newEpoch]: groupKey }, newEpoch);

	// Notify other members to fetch new key
	wsSend({
		type: 'key_rotation',
		groupId,
		epoch: newEpoch,
		memberDids: remainingMembers.map(m => m.did),
	});
}

/**
 * Handle key_rotation WS event — fetch new wrapped key from server.
 */
async function handleKeyRotation(data: { groupId: string; epoch: number }): Promise<void> {
	await bootstrapGroupKeys(data.groupId);
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
	disconnect();
}
