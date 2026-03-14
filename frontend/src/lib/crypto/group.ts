/**
 * Sender Keys group encryption (Signal-style).
 *
 * Each member generates their own sender key and distributes it to other
 * members via pairwise nacl.box encryption.  When sending a message the
 * sender encrypts once with nacl.secretbox using their own key; every
 * recipient who has received the sender's key can decrypt.
 *
 * Key distribution is fully decentralized — no admin bottleneck.
 * New members generate + distribute their own key on join.  Existing
 * members wrap their key for the new joiner in the background.
 */
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from './util';

/** Generate a random 32-byte sender key (base64). */
export function generateSenderKey(): string {
	const key = nacl.randomBytes(nacl.secretbox.keyLength);
	return encodeBase64(key);
}

/** @deprecated alias kept for call-sites that haven't migrated yet */
export const generateGroupKey = generateSenderKey;

/**
 * Wrap a sender key (+ optional delivery token) for a list of recipients
 * using their X25519 boxPublicKeys.
 *
 * The payload is UTF-8 encoded (not base64) because it may contain a ':'
 * separator between the sender key and delivery token.
 */
export function wrapSenderKeyForMembers(
	senderKeyB64: string,
	myBoxSecretKey: Uint8Array,
	members: Array<{ did: string; boxPublicKey: string }>,
	deliveryToken?: string
): Array<{ memberDid: string; wrappedKey: string; wrappedKeyNonce: string }> {
	const payload = deliveryToken ? `${senderKeyB64}:${deliveryToken}` : senderKeyB64;
	const payloadBytes = decodeUTF8(payload);

	const results: Array<{ memberDid: string; wrappedKey: string; wrappedKeyNonce: string }> = [];

	for (const m of members) {
		if (!m.boxPublicKey) continue;
		try {
			const recipientPub = decodeBase64(m.boxPublicKey);
			const nonce = nacl.randomBytes(nacl.box.nonceLength);
			const encrypted = nacl.box(payloadBytes, nonce, recipientPub, myBoxSecretKey);
			results.push({
				memberDid: m.did,
				wrappedKey: encodeBase64(encrypted),
				wrappedKeyNonce: encodeBase64(nonce),
			});
		} catch (err) {
			console.warn(`[sender-keys] Failed to wrap key for ${m.did.slice(0, 16)}:`, err);
		}
	}

	return results;
}

/** @deprecated alias kept for call-sites that haven't migrated yet */
export const wrapGroupKeyForMembers = wrapSenderKeyForMembers;

/**
 * Unwrap a sender key (+ optional delivery token) that was encrypted for us.
 *
 * Decrypts with nacl.box.open and UTF-8 decodes the payload.
 */
export function unwrapSenderKey(
	wrappedKey: string,
	nonce: string,
	senderBoxPublicKey: Uint8Array,
	myBoxSecretKey: Uint8Array
): { senderKey: string; deliveryToken?: string } {
	const encrypted = decodeBase64(wrappedKey);
	const nonceBytes = decodeBase64(nonce);
	const decrypted = nacl.box.open(encrypted, nonceBytes, senderBoxPublicKey, myBoxSecretKey);

	if (!decrypted) {
		throw new Error('Failed to unwrap sender key');
	}

	const payload = encodeUTF8(decrypted);
	const parts = payload.split(':');
	if (parts.length >= 2) {
		return { senderKey: parts[0], deliveryToken: parts.slice(1).join(':') };
	}
	return { senderKey: payload };
}

/** @deprecated compat shim — returns { groupKey, deliveryToken } */
export function unwrapGroupKey(
	wrappedKey: string,
	nonce: string,
	senderBoxPublicKey: Uint8Array,
	myBoxSecretKey: Uint8Array
): { groupKey: string; deliveryToken?: string } {
	const r = unwrapSenderKey(wrappedKey, nonce, senderBoxPublicKey, myBoxSecretKey);
	return { groupKey: r.senderKey, deliveryToken: r.deliveryToken };
}

/** Encrypt a group message with a sender key (nacl.secretbox). */
export function encryptGroupMessage(
	plaintext: string,
	senderKeyB64: string
): { ciphertext: string; nonce: string } {
	const key = decodeBase64(senderKeyB64);
	const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
	const messageBytes = decodeUTF8(plaintext);
	const encrypted = nacl.secretbox(messageBytes, nonce, key);

	return {
		ciphertext: encodeBase64(encrypted),
		nonce: encodeBase64(nonce),
	};
}

/** Decrypt a group message with the sender's key. */
export function decryptGroupMessage(
	ciphertextB64: string,
	nonceB64: string,
	senderKeyB64: string
): string {
	const key = decodeBase64(senderKeyB64);
	const nonce = decodeBase64(nonceB64);
	const ciphertext = decodeBase64(ciphertextB64);
	const decrypted = nacl.secretbox.open(ciphertext, nonce, key);

	if (!decrypted) {
		throw new Error('Group message decryption failed');
	}

	return encodeUTF8(decrypted);
}
