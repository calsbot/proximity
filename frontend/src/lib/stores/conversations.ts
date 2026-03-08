/**
 * Conversation store: manages active conversations, their keys, and decrypted messages.
 * Conversations are stored in IndexedDB so they persist across sessions.
 * Supports Double Ratchet key serialization.
 */
import { writable, get } from 'svelte/store';
import nacl from 'tweetnacl';
import type { ConversationKeys } from '$lib/crypto/messaging';
import { encodeBase64, decodeBase64 } from '$lib/crypto/util';

export interface DecryptedMessage {
	id: string;
	senderDid: string;
	senderName?: string;
	text: string;
	timestamp: string;
	isMine: boolean;
	// Media fields (for view-once media messages)
	mediaId?: string;
	mediaKey?: string;
	mediaNonce?: string;
	mimeType?: string;
	viewOnce?: boolean;
	viewed?: boolean;
}

export interface Conversation {
	groupId: string;
	peerDid: string;
	peerName: string;
	peerBoxPublicKey: string; // base64
	isGroup: boolean;
	messages: DecryptedMessage[];
	lastMessage: string;
	lastMessageAt: string;
	unreadCount: number;
	left?: boolean; // true if user left or was removed from group
	knownMemberDids?: string[]; // cached member DIDs for generating join/leave system messages
	// Serialized conversation keys (Double Ratchet state)
	keys: SerializedConversationKeys | null;
	// Group encryption keys: epoch → base64 symmetric key
	groupKeys?: Record<number, string>;
	groupKeyEpoch?: number;
}

interface SerializedConversationKeys {
	groupId: string;
	rootKey: string; // base64
	sendChainKey: string; // base64
	recvChainKey: string; // base64
	sendCounter: number;
	recvCounter: number;
	// DH ratchet keypair
	dhPublicKey: string; // base64
	dhSecretKey: string; // base64
	// Peer's current DH public key
	peerDhPublicKey: string; // base64
	peerDid: string;
	peerBoxPublicKey: string; // base64
	initialized: boolean;
	// Skipped message keys for out-of-order decryption
	skippedKeys: Record<string, string>;

	// LEGACY fields (for backward compat with old conversations)
	sharedSecret?: string; // base64
}

function serializeKeys(keys: ConversationKeys): SerializedConversationKeys {
	return {
		groupId: keys.groupId,
		rootKey: encodeBase64(keys.rootKey),
		sendChainKey: encodeBase64(keys.sendChainKey),
		recvChainKey: encodeBase64(keys.recvChainKey),
		sendCounter: keys.sendCounter,
		recvCounter: keys.recvCounter,
		dhPublicKey: encodeBase64(keys.dhKeyPair.publicKey),
		dhSecretKey: encodeBase64(keys.dhKeyPair.secretKey),
		peerDhPublicKey: encodeBase64(keys.peerDhPublicKey),
		peerDid: keys.peerDid,
		peerBoxPublicKey: keys.peerBoxPublicKey,
		initialized: keys.initialized ?? false,
		skippedKeys: keys.skippedKeys ?? {},
	};
}

export function deserializeKeys(s: SerializedConversationKeys): ConversationKeys {
	// Handle legacy format (pre-Double Ratchet)
	if (!s.rootKey && (s as any).sharedSecret) {
		return deserializeLegacyKeys(s);
	}

	return {
		groupId: s.groupId,
		rootKey: decodeBase64(s.rootKey),
		sendChainKey: decodeBase64(s.sendChainKey),
		recvChainKey: decodeBase64(s.recvChainKey),
		sendCounter: s.sendCounter,
		recvCounter: s.recvCounter,
		dhKeyPair: {
			publicKey: decodeBase64(s.dhPublicKey),
			secretKey: decodeBase64(s.dhSecretKey),
		},
		peerDhPublicKey: decodeBase64(s.peerDhPublicKey),
		peerDid: s.peerDid,
		peerBoxPublicKey: s.peerBoxPublicKey,
		initialized: s.initialized ?? false,
		skippedKeys: s.skippedKeys ?? {},
	};
}

/**
 * Deserialize legacy (pre-Double Ratchet) keys.
 * Creates a compatible ConversationKeys with the old shared secret as root key.
 */
function deserializeLegacyKeys(s: SerializedConversationKeys): ConversationKeys {
	const sharedSecret = decodeBase64((s as any).sharedSecret);
	// Generate a new ephemeral DH keypair for the ratchet transition
	const dhKeyPair = nacl.box.keyPair();

	return {
		groupId: s.groupId,
		rootKey: sharedSecret, // Use old shared secret as root key
		sendChainKey: decodeBase64(s.sendChainKey),
		recvChainKey: decodeBase64(s.recvChainKey),
		sendCounter: s.sendCounter,
		recvCounter: s.recvCounter,
		dhKeyPair,
		peerDhPublicKey: decodeBase64(s.peerBoxPublicKey), // Use long-term key as initial peer DH key
		peerDid: s.peerDid,
		peerBoxPublicKey: s.peerBoxPublicKey,
		initialized: false, // Not yet done a proper DH ratchet
		skippedKeys: {},
		sharedSecret, // Keep for legacy compat
	};
}

// In-memory store
export const conversationsStore = writable<Conversation[]>([]);

// --- IndexedDB persistence ---

async function getDb() {
	const { openDB } = await import('idb');
	return openDB('proximity-conversations', 1, {
		upgrade(db) {
			if (!db.objectStoreNames.contains('conversations')) {
				db.createObjectStore('conversations', { keyPath: 'groupId' });
			}
		}
	});
}

export async function loadConversations(): Promise<void> {
	try {
		const db = await getDb();
		const all = await db.getAll('conversations');
		conversationsStore.set(all);
	} catch {
		// fresh start
	}
}

async function persistConversations(convos: Conversation[]): Promise<void> {
	try {
		const db = await getDb();
		const tx = db.transaction('conversations', 'readwrite');
		// Clear and re-add all
		await tx.store.clear();
		for (const c of convos) {
			await tx.store.put(c);
		}
		await tx.done;
	} catch {
		// non-fatal
	}
}

/**
 * Start or get a conversation with a peer.
 */
export function getOrCreateConversation(
	groupId: string,
	peerDid: string,
	peerName: string,
	peerBoxPublicKey: string,
	keys: ConversationKeys | null,
	isGroup: boolean = false
): Conversation {
	const current = get(conversationsStore);
	const existing = current.find(c => c.groupId === groupId);
	if (existing) return existing;

	const convo: Conversation = {
		groupId,
		peerDid,
		peerName,
		peerBoxPublicKey,
		isGroup,
		messages: [],
		lastMessage: '',
		lastMessageAt: new Date().toISOString(),
		unreadCount: 0,
		keys: keys ? serializeKeys(keys) : null,
	};

	conversationsStore.update(c => {
		const updated = [...c, convo];
		persistConversations(updated);
		return updated;
	});

	return convo;
}

/**
 * Add a decrypted message to a conversation.
 */
export function addMessage(groupId: string, msg: DecryptedMessage, updatedKeys?: ConversationKeys): void {
	conversationsStore.update(convos => {
		const updated = convos.map(c => {
			if (c.groupId !== groupId) return c;
			return {
				...c,
				messages: [...c.messages, msg],
				lastMessage: msg.text,
				lastMessageAt: msg.timestamp,
				unreadCount: msg.isMine ? c.unreadCount : c.unreadCount + 1,
				keys: updatedKeys ? serializeKeys(updatedKeys) : c.keys,
			};
		});
		persistConversations(updated);
		return updated;
	});
}

/**
 * Update conversation keys (after sending/receiving a message).
 */
export function updateConversationKeys(groupId: string, keys: ConversationKeys): void {
	conversationsStore.update(convos => {
		const updated = convos.map(c => {
			if (c.groupId !== groupId) return c;
			return { ...c, keys: serializeKeys(keys) };
		});
		persistConversations(updated);
		return updated;
	});
}

/**
 * Update cached member list for a group and return join/leave diffs.
 */
export function diffGroupMembers(groupId: string, currentMembers: Array<{ did: string; displayName: string }>): { joined: string[]; left: string[] } {
	const convos = get(conversationsStore);
	const convo = convos.find(c => c.groupId === groupId);
	const knownDids = convo?.knownMemberDids ?? [];
	const currentDids = currentMembers.map(m => m.did);

	const joined = currentDids.filter(d => !knownDids.includes(d));
	const left = knownDids.filter(d => !currentDids.includes(d));

	// Update the cached member list
	conversationsStore.update(cs => {
		const updated = cs.map(c => {
			if (c.groupId !== groupId) return c;
			return { ...c, knownMemberDids: currentDids };
		});
		persistConversations(updated);
		return updated;
	});

	return { joined, left };
}

/**
 * Reset unread count for a conversation.
 */
export function markRead(groupId: string): void {
	conversationsStore.update(convos => {
		const updated = convos.map(c => {
			if (c.groupId !== groupId) return c;
			return { ...c, unreadCount: 0 };
		});
		persistConversations(updated);
		return updated;
	});
}

/**
 * Get conversation by groupId.
 */
export function getConversation(groupId: string): Conversation | undefined {
	return get(conversationsStore).find(c => c.groupId === groupId);
}

/**
 * Mark a conversation as left (user left or was removed).
 * Keeps chat history but prevents sending new messages.
 */
export function markConversationLeft(groupId: string): void {
	conversationsStore.update(convos => {
		const updated = convos.map(c => {
			if (c.groupId !== groupId) return c;
			return { ...c, left: true };
		});
		persistConversations(updated);
		return updated;
	});
}

/**
 * Unmark a conversation as left (e.g. after join request approved).
 */
export function unmarkConversationLeft(groupId: string): void {
	conversationsStore.update(convos => {
		const updated = convos.map(c => {
			if (c.groupId !== groupId) return c;
			return { ...c, left: false };
		});
		persistConversations(updated);
		return updated;
	});
}

/**
 * Update group encryption keys for a conversation.
 */
export function updateGroupConversationKeys(groupId: string, groupKeysMap: Record<number, string>, epoch: number): void {
	conversationsStore.update(convos => {
		const updated = convos.map(c => {
			if (c.groupId !== groupId) return c;
			return {
				...c,
				groupKeys: { ...(c.groupKeys ?? {}), ...groupKeysMap },
				groupKeyEpoch: epoch,
			};
		});
		persistConversations(updated);
		return updated;
	});
}

/**
 * Mark a media message as viewed — wipe the media key so it can't be viewed again.
 */
export function markMediaViewed(groupId: string, messageId: string): void {
	conversationsStore.update(convos => {
		const updated = convos.map(c => {
			if (c.groupId !== groupId) return c;
			return {
				...c,
				messages: c.messages.map(m => {
					if (m.id !== messageId) return m;
					return { ...m, viewed: true, mediaKey: undefined };
				}),
			};
		});
		persistConversations(updated);
		return updated;
	});
}

/**
 * Remove a single conversation from memory and IndexedDB.
 */
export async function removeConversation(groupId: string): Promise<void> {
	conversationsStore.update(cs => cs.filter(c => c.groupId !== groupId));
	try {
		const db = await getDb();
		await db.delete('conversations', groupId);
	} catch {
		// non-fatal
	}
}

/**
 * Clear all conversations from memory and IndexedDB.
 * Used when creating a new identity to avoid leaking old messages.
 */
export async function clearAllConversations(): Promise<void> {
	conversationsStore.set([]);
	try {
		const db = await getDb();
		const tx = db.transaction('conversations', 'readwrite');
		await tx.store.clear();
		await tx.done;
	} catch {
		// non-fatal
	}
}
