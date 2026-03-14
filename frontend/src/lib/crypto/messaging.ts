/**
 * Double Ratchet E2EE messaging (Signal Protocol pattern).
 *
 * Provides both forward secrecy AND post-compromise security:
 * - Symmetric ratchet: HMAC chain key advancement (forward secrecy per message)
 * - DH ratchet: new ephemeral X25519 keypairs on each conversation turn
 *   (post-compromise security — if keys leak, next turn self-heals)
 *
 * Flow:
 * 1. Initial key exchange: X25519 DH with long-term box keys → root key
 * 2. Sender generates ephemeral X25519 keypair, includes public key in message header
 * 3. Receiver does DH with sender's ephemeral + own current ratchet key → new root key
 * 4. Root key is used to derive sending/receiving chain keys
 * 5. Chain keys ratchet forward with HMAC for each message in the same turn
 *
 * Upgrade path: replace with MLS for group E2EE when WASM bindings mature.
 */
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from './util';

/** Full ratchet state for a conversation */
export interface ConversationKeys {
	groupId: string;
	// Root key — used to derive new chain keys on DH ratchet steps
	rootKey: Uint8Array;
	// Sending chain
	sendChainKey: Uint8Array;
	sendCounter: number;
	// Receiving chain
	recvChainKey: Uint8Array;
	recvCounter: number;
	// Our current DH ratchet keypair
	dhKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
	// Peer's current DH ratchet public key
	peerDhPublicKey: Uint8Array;
	// Peer identity info
	peerDid: string;
	peerBoxPublicKey: string; // base64, long-term key for reference
	// Track if we've performed the initial DH ratchet
	initialized: boolean;
	// Previous receiving chain keys for out-of-order messages
	// Key: "base64(peerDhPub):counter" → messageKey (base64)
	skippedKeys: Record<string, string>;

	// LEGACY COMPAT: old shared secret field (used to detect old-format keys)
	sharedSecret?: Uint8Array;
}

export interface EncryptedMessage {
	groupId: string;
	senderDid: string;
	recipientDid: string;
	epoch: number;
	nonce: string; // base64
	ciphertext: string; // base64
	// Double Ratchet header
	dhPublicKey?: string; // base64 — sender's current ephemeral DH public key
	previousCounter?: number; // number of messages in previous sending chain
}

/**
 * HMAC-SHA256 using Web Crypto.
 */
async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const cryptoKey = await crypto.subtle.importKey(
		'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', cryptoKey, data);
	return new Uint8Array(sig);
}

/**
 * SHA-256 hash.
 */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
	const hash = await crypto.subtle.digest('SHA-256', data);
	return new Uint8Array(hash);
}

/**
 * HKDF-like key derivation: derive two 32-byte keys from a root key + DH output.
 * Returns [newRootKey, chainKey].
 */
async function kdfRootKey(
	rootKey: Uint8Array,
	dhOutput: Uint8Array
): Promise<[Uint8Array, Uint8Array]> {
	const enc = new TextEncoder();
	// Combine root key and DH output
	const ikm = new Uint8Array([...rootKey, ...dhOutput]);
	const prk = await hmacSha256(ikm, enc.encode('double-ratchet-root'));
	const newRootKey = await hmacSha256(prk, enc.encode('root'));
	const chainKey = await hmacSha256(prk, enc.encode('chain'));
	return [newRootKey, chainKey];
}

function hexEncode(bytes: Uint8Array): string {
	return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive initial conversation keys using X25519 Diffie-Hellman.
 * This sets up the Double Ratchet with the first DH ratchet step.
 */
export async function deriveConversationKeys(
	myBoxSecretKey: Uint8Array,
	myBoxPublicKey: Uint8Array,
	myDid: string,
	theirBoxPublicKey: Uint8Array,
	theirDid: string
): Promise<ConversationKeys> {
	// X25519 Diffie-Hellman shared secret with long-term keys
	const sharedSecret = nacl.box.before(theirBoxPublicKey, myBoxSecretKey);

	// Deterministic ordering
	const iAmInitiator = myDid < theirDid;

	// Deterministic group ID
	const combined = iAmInitiator
		? new Uint8Array([...myBoxPublicKey, ...theirBoxPublicKey])
		: new Uint8Array([...theirBoxPublicKey, ...myBoxPublicKey]);
	const groupId = hexEncode(await sha256(combined)).slice(0, 32);

	// Generate our first ephemeral DH ratchet keypair
	const dhKeyPair = nacl.box.keyPair();

	// Derive initial root key and chain keys from the shared secret
	const enc = new TextEncoder();
	const rootKey = await hmacSha256(sharedSecret, enc.encode('double-ratchet-init'));

	// Initiator starts with a sending chain, responder waits for first message
	const initChainKey = await hmacSha256(rootKey, enc.encode(iAmInitiator ? 'init-send' : 'init-recv'));
	const respChainKey = await hmacSha256(rootKey, enc.encode(iAmInitiator ? 'init-recv' : 'init-send'));

	return {
		groupId,
		rootKey,
		sendChainKey: initChainKey,
		sendCounter: 0,
		recvChainKey: respChainKey,
		recvCounter: 0,
		dhKeyPair,
		peerDhPublicKey: theirBoxPublicKey, // Start with long-term key, will be updated on first ratchet
		peerDid: theirDid,
		peerBoxPublicKey: encodeBase64(theirBoxPublicKey),
		initialized: false,
		skippedKeys: {},
	};
}

/**
 * Ratchet a symmetric chain key forward to get message key + next chain key.
 */
async function symmetricRatchet(chainKey: Uint8Array): Promise<{ messageKey: Uint8Array; nextChainKey: Uint8Array }> {
	const enc = new TextEncoder();
	const messageKey = await hmacSha256(chainKey, enc.encode('msg'));
	const nextChainKey = await hmacSha256(chainKey, enc.encode('chain'));
	return { messageKey, nextChainKey };
}

/**
 * Perform a DH ratchet step (when we receive a new DH public key from peer).
 */
async function dhRatchetStep(
	keys: ConversationKeys,
	newPeerDhPublicKey: Uint8Array
): Promise<ConversationKeys> {
	// DH with our current key and their new key → update recv chain
	const dh1 = nacl.box.before(newPeerDhPublicKey, keys.dhKeyPair.secretKey);
	const [rootKey1, recvChainKey] = await kdfRootKey(keys.rootKey, dh1);

	// Generate new ephemeral keypair for our next sending
	const newDhKeyPair = nacl.box.keyPair();

	// DH with our new key and their new key → update send chain
	const dh2 = nacl.box.before(newPeerDhPublicKey, newDhKeyPair.secretKey);
	const [rootKey2, sendChainKey] = await kdfRootKey(rootKey1, dh2);

	return {
		...keys,
		rootKey: rootKey2,
		sendChainKey,
		sendCounter: 0,
		recvChainKey,
		recvCounter: 0,
		dhKeyPair: newDhKeyPair,
		peerDhPublicKey: newPeerDhPublicKey,
		initialized: true,
	};
}

/**
 * Encrypt a plaintext message using the Double Ratchet.
 */
export async function encryptMessage(
	keys: ConversationKeys,
	senderDid: string,
	plaintext: string
): Promise<{ encrypted: EncryptedMessage; updatedKeys: ConversationKeys }> {
	const { messageKey, nextChainKey } = await symmetricRatchet(keys.sendChainKey);
	const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
	const ciphertext = nacl.secretbox(decodeUTF8(plaintext), nonce, messageKey);

	const previousCounter = keys.sendCounter;

	return {
		encrypted: {
			groupId: keys.groupId,
			senderDid,
			recipientDid: keys.peerDid,
			epoch: keys.sendCounter,
			nonce: encodeBase64(nonce),
			ciphertext: encodeBase64(ciphertext),
			// Double Ratchet header — include our current DH public key
			dhPublicKey: encodeBase64(keys.dhKeyPair.publicKey),
			previousCounter,
		},
		updatedKeys: {
			...keys,
			sendChainKey: nextChainKey,
			sendCounter: keys.sendCounter + 1,
		},
	};
}

/**
 * Decrypt a received message using the Double Ratchet.
 * Handles DH ratchet steps when the sender's DH key changes,
 * and symmetric ratchet steps for epoch gaps.
 */
export async function decryptMessage(
	keys: ConversationKeys,
	message: EncryptedMessage
): Promise<{ plaintext: string; updatedKeys: ConversationKeys }> {
	let currentKeys = { ...keys, skippedKeys: { ...keys.skippedKeys } };

	// Check if this is a legacy message (no dhPublicKey header)
	if (!message.dhPublicKey) {
		return decryptLegacyMessage(currentKeys, message);
	}

	const messageDhPublicKey = decodeBase64(message.dhPublicKey);

	// Check skipped message keys first (out-of-order message)
	const skippedId = `${message.dhPublicKey}:${message.epoch}`;
	if (currentKeys.skippedKeys[skippedId]) {
		const messageKey = decodeBase64(currentKeys.skippedKeys[skippedId]);
		const nonce = decodeBase64(message.nonce);
		const ciphertext = decodeBase64(message.ciphertext);
		const decrypted = nacl.secretbox.open(ciphertext, nonce, messageKey);
		if (!decrypted) throw new Error('Decryption failed (skipped key)');

		const newSkipped = { ...currentKeys.skippedKeys };
		delete newSkipped[skippedId];

		return {
			plaintext: encodeUTF8(decrypted),
			updatedKeys: { ...currentKeys, skippedKeys: newSkipped },
		};
	}

	// Check if the sender's DH key has changed → need DH ratchet step
	const peerDhKeyB64 = encodeBase64(currentKeys.peerDhPublicKey);
	const messageDhKeyB64 = message.dhPublicKey;

	if (peerDhKeyB64 !== messageDhKeyB64) {
		if (!currentKeys.initialized) {
			// First message received — accept peer's DH key without ratcheting.
			// The initial recv chain key is already correct (derived from shared secret).
			currentKeys = {
				...currentKeys,
				peerDhPublicKey: messageDhPublicKey,
				initialized: true,
			};
		} else {
			// Skip any missed messages on the current receiving chain
			currentKeys = await skipMessageKeys(currentKeys, currentKeys.recvCounter, message.previousCounter ?? 0);
			// Perform DH ratchet step
			currentKeys = await dhRatchetStep(currentKeys, messageDhPublicKey);
		}
	}

	// Skip messages if epoch is ahead
	if (message.epoch > currentKeys.recvCounter) {
		currentKeys = await skipMessageKeys(currentKeys, currentKeys.recvCounter, message.epoch);
	}

	// Symmetric ratchet to get the message key
	const { messageKey, nextChainKey } = await symmetricRatchet(currentKeys.recvChainKey);
	const nonce = decodeBase64(message.nonce);
	const ciphertext = decodeBase64(message.ciphertext);
	const decrypted = nacl.secretbox.open(ciphertext, nonce, messageKey);

	if (!decrypted) {
		throw new Error('Decryption failed');
	}

	return {
		plaintext: encodeUTF8(decrypted),
		updatedKeys: {
			...currentKeys,
			recvChainKey: nextChainKey,
			recvCounter: message.epoch + 1,
		},
	};
}

/**
 * Skip message keys for missed messages (store them for later out-of-order decryption).
 * Limited to 100 skipped keys to prevent DoS.
 */
async function skipMessageKeys(
	keys: ConversationKeys,
	fromCounter: number,
	toCounter: number
): Promise<ConversationKeys> {
	const MAX_SKIP = 100;
	if (toCounter - fromCounter > MAX_SKIP) {
		throw new Error(`Too many skipped messages: ${toCounter - fromCounter} (stale session data)`);
	}

	let chainKey = keys.recvChainKey;
	const skipped = { ...keys.skippedKeys };
	const peerDhKeyB64 = encodeBase64(keys.peerDhPublicKey);

	for (let i = fromCounter; i < toCounter; i++) {
		const { messageKey, nextChainKey } = await symmetricRatchet(chainKey);
		skipped[`${peerDhKeyB64}:${i}`] = encodeBase64(messageKey);
		chainKey = nextChainKey;
	}

	// Prune oldest if too many
	const entries = Object.entries(skipped);
	if (entries.length > MAX_SKIP) {
		const toRemove = entries.length - MAX_SKIP;
		for (let i = 0; i < toRemove; i++) {
			delete skipped[entries[i][0]];
		}
	}

	return {
		...keys,
		recvChainKey: chainKey,
		recvCounter: toCounter,
		skippedKeys: skipped,
	};
}

/**
 * Decrypt a legacy message (from before Double Ratchet upgrade).
 * Falls back to simple symmetric chain ratcheting.
 */
async function decryptLegacyMessage(
	keys: ConversationKeys,
	message: EncryptedMessage
): Promise<{ plaintext: string; updatedKeys: ConversationKeys }> {
	let chainKey = keys.recvChainKey;
	let counter = keys.recvCounter;

	// Fast-forward chain key if we missed earlier messages
	if (message.epoch > counter) {
		console.warn(`[crypto] Legacy: skipping ${message.epoch - counter} missed epoch(s)`);
		while (counter < message.epoch) {
			const { nextChainKey } = await symmetricRatchet(chainKey);
			chainKey = nextChainKey;
			counter++;
		}
	} else if (message.epoch < counter) {
		throw new Error(`Message epoch ${message.epoch} is behind our counter ${counter}`);
	}

	const { messageKey, nextChainKey } = await symmetricRatchet(chainKey);
	const nonce = decodeBase64(message.nonce);
	const ciphertext = decodeBase64(message.ciphertext);
	const decrypted = nacl.secretbox.open(ciphertext, nonce, messageKey);

	if (!decrypted) {
		throw new Error('Legacy decryption failed');
	}

	return {
		plaintext: encodeUTF8(decrypted),
		updatedKeys: {
			...keys,
			recvChainKey: nextChainKey,
			recvCounter: message.epoch + 1,
		},
	};
}
