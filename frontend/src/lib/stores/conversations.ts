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
	peerLeft?: boolean; // true if peer left the DM (user was "abandoned")
	knownMemberDids?: string[]; // cached member DIDs for generating join/leave system messages
	knownMemberNames?: Record<string, string>; // did → displayName cache
	// Serialized conversation keys (Double Ratchet state)
	keys: SerializedConversationKeys | null;
	// Sender Keys (Signal-style): senderDid → base64 key
	senderKeys?: Record<string, string>;
	// My own sender key for this group (base64)
	mySenderKey?: string;
	mySenderKeyEpoch?: number;
	// LEGACY: epoch-based group keys (pre-Sender Keys migration)
	groupKeys?: Record<number, string>;
	groupKeyEpoch?: number;
	// Sealed sender state (DMs)
	myDeliveryToken?: string; // base64 — our token shared with this peer
	peerDeliveryToken?: string; // base64 — peer's token they shared with us
	sealedSenderEnabled?: boolean; // true once both tokens exchanged
	// Sealed sender state (Groups) — single shared token for all members
	groupDeliveryToken?: string; // base64 — shared token for this group
	// Muted — suppresses notifications and unread badge
	muted?: boolean;
	// DM invitation accepted — true once the DM has been accepted (or auto-accepted)
	// Used for first-contact detection: only false when no invitation has been sent/accepted yet
	dmAccepted?: boolean;
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

// --- IndexedDB persistence (namespaced per user DID) ---

let currentDbDid: string | null = null;

async function getDb() {
	if (!currentDbDid) throw new Error('Conversation store not initialized — call loadConversations(did) first');
	const { openDB } = await import('idb');
	// Namespace DB by user DID so each identity has its own conversation store
	const dbName = `proximity-conversations-${currentDbDid.slice(-12)}`;
	return openDB(dbName, 1, {
		upgrade(db) {
			if (!db.objectStoreNames.contains('conversations')) {
				db.createObjectStore('conversations', { keyPath: 'groupId' });
			}
		}
	});
}

export async function loadConversations(did: string): Promise<void> {
	currentDbDid = did;
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
			// Dedup: skip if a message with this ID already exists
			if (c.messages.some(m => m.id === msg.id)) return c;
			return {
				...c,
				messages: [...c.messages, msg],
				lastMessage: msg.text,
				lastMessageAt: msg.timestamp,
				unreadCount: msg.isMine || c.muted || msg.senderDid === 'system' ? c.unreadCount : c.unreadCount + 1,
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
export function diffGroupMembers(groupId: string, currentMembers: Array<{ did: string; displayName: string }>): { joined: string[]; left: string[]; getName: (did: string) => string } {
	const convos = get(conversationsStore);
	const convo = convos.find(c => c.groupId === groupId);
	const knownDids = convo?.knownMemberDids ?? [];
	const knownNames = convo?.knownMemberNames ?? {};
	const currentDids = currentMembers.map(m => m.did);

	const joined = currentDids.filter(d => !knownDids.includes(d));
	const left = knownDids.filter(d => !currentDids.includes(d));

	// Build name lookup from both old cached names and current members
	const nameMap: Record<string, string> = { ...knownNames };
	for (const m of currentMembers) {
		nameMap[m.did] = m.displayName;
	}
	const getName = (did: string) => nameMap[did] ?? did.slice(-8);

	// Update the cached member list and names
	conversationsStore.update(cs => {
		const updated = cs.map(c => {
			if (c.groupId !== groupId) return c;
			return { ...c, knownMemberDids: currentDids, knownMemberNames: nameMap };
		});
		persistConversations(updated);
		return updated;
	});

	return { joined, left, getName };
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
 * Mark a DM conversation as accepted (invitation accepted or auto-accepted).
 */
export function markDmAccepted(groupId: string): void {
	conversationsStore.update(convos => {
		const updated = convos.map(c => {
			if (c.groupId !== groupId) return c;
			return { ...c, dmAccepted: true };
		});
		persistConversations(updated);
		return updated;
	});
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
 * Mark a DM conversation as peer-left (the other person left).
 */
export function markConversationPeerLeft(groupId: string): void {
	conversationsStore.update(convos => {
		const updated = convos.map(c => {
			if (c.groupId !== groupId) return c;
			return { ...c, peerLeft: true };
		});
		persistConversations(updated);
		return updated;
	});
}

/**
 * Unmark peer-left on a DM conversation (e.g. after reconnection accepted).
 */
export function unmarkConversationPeerLeft(groupId: string): void {
	conversationsStore.update(convos => {
		const updated = convos.map(c => {
			if (c.groupId !== groupId) return c;
			return { ...c, peerLeft: false };
		});
		persistConversations(updated);
		return updated;
	});
}

/**
 * Update group encryption keys for a conversation.
 * @deprecated Use updateSenderKeys for new Sender Keys model.
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
 * Update sender keys for a group conversation (Signal-style Sender Keys model).
 * Merges new sender keys with existing ones.
 */
export function updateSenderKeys(groupId: string, newKeys: Record<string, string>, mySenderKey?: string, myEpoch?: number): void {
	conversationsStore.update(convos => {
		const updated = convos.map(c => {
			if (c.groupId !== groupId) return c;
			return {
				...c,
				senderKeys: { ...(c.senderKeys ?? {}), ...newKeys },
				...(mySenderKey !== undefined ? { mySenderKey } : {}),
				...(myEpoch !== undefined ? { mySenderKeyEpoch: myEpoch } : {}),
			};
		});
		persistConversations(updated);
		return updated;
	});
}

/**
 * Set the group delivery token for a group conversation.
 */
export function setGroupDeliveryToken(groupId: string, token: string): void {
	conversationsStore.update(convos => {
		const updated = convos.map(c => {
			if (c.groupId !== groupId) return c;
			return { ...c, groupDeliveryToken: token };
		});
		persistConversations(updated);
		return updated;
	});
}

/**
 * Update sealed sender delivery tokens for a DM conversation.
 */
export function setDeliveryTokens(groupId: string, myToken?: string, peerToken?: string): void {
	conversationsStore.update(convos => {
		const updated = convos.map(c => {
			if (c.groupId !== groupId) return c;
			const newMyToken = myToken ?? c.myDeliveryToken;
			const newPeerToken = peerToken ?? c.peerDeliveryToken;
			return {
				...c,
				myDeliveryToken: newMyToken,
				peerDeliveryToken: newPeerToken,
				sealedSenderEnabled: !!(newMyToken && newPeerToken),
			};
		});
		persistConversations(updated);
		return updated;
	});
}

/**
 * Reset sealed sender state for a conversation (e.g. when sealed send fails).
 * Clears the stale peer token so the next message goes through the unsealed path,
 * which re-triggers token exchange.
 */
export function resetSealedSender(groupId: string): void {
	conversationsStore.update(convos => {
		const updated = convos.map(c => {
			if (c.groupId !== groupId) return c;
			return {
				...c,
				peerDeliveryToken: undefined,
				sealedSenderEnabled: false,
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
 * Mute a conversation — suppresses unread count and notifications.
 */
export function muteConversation(groupId: string): void {
	conversationsStore.update(convos => {
		const updated = convos.map(c => {
			if (c.groupId !== groupId) return c;
			return { ...c, muted: true, unreadCount: 0 };
		});
		persistConversations(updated);
		return updated;
	});
}

/**
 * Unmute a conversation.
 */
export function unmuteConversation(groupId: string): void {
	conversationsStore.update(convos => {
		const updated = convos.map(c => {
			if (c.groupId !== groupId) return c;
			return { ...c, muted: false };
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
		if (currentDbDid) {
			const db = await getDb();
			const tx = db.transaction('conversations', 'readwrite');
			await tx.store.clear();
			await tx.done;
		}
	} catch {
		// non-fatal
	}
	currentDbDid = null;
}
