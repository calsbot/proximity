/**
 * Group encryption: shared symmetric key per group.
 * Key is wrapped (nacl.box) for each member using their X25519 boxPublicKey.
 * Messages encrypted with nacl.secretbox using the shared group key.
 * Key rotates when members join/leave.
 */
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from './util';
import { wrapKeyForRecipient, unwrapKey } from './media';

/** Generate a random 32-byte group symmetric key (base64). */
export function generateGroupKey(): string {
	const key = nacl.randomBytes(nacl.secretbox.keyLength);
	return encodeBase64(key);
}

/** Wrap the group key (+ optional delivery token) for each member using their boxPublicKey. */
export function wrapGroupKeyForMembers(
	groupKeyB64: string,
	myBoxSecretKey: Uint8Array,
	members: Array<{ did: string; boxPublicKey: string }>,
	deliveryToken?: string
): Array<{ memberDid: string; wrappedKey: string; wrappedKeyNonce: string }> {
	// Bundle delivery token with group key if provided
	const payload = deliveryToken ? `${groupKeyB64}:${deliveryToken}` : groupKeyB64;
	return members
		.filter(m => m.boxPublicKey)
		.map(m => {
			const { wrappedKey, nonce } = wrapKeyForRecipient(
				payload,
				myBoxSecretKey,
				decodeBase64(m.boxPublicKey)
			);
			return {
				memberDid: m.did,
				wrappedKey,
				wrappedKeyNonce: nonce,
			};
		});
}

/** Unwrap a group key (+ optional delivery token) that was encrypted for us. */
export function unwrapGroupKey(
	wrappedKey: string,
	nonce: string,
	senderBoxPublicKey: Uint8Array,
	myBoxSecretKey: Uint8Array
): { groupKey: string; deliveryToken?: string } {
	const payload = unwrapKey(wrappedKey, nonce, senderBoxPublicKey, myBoxSecretKey);
	const parts = payload.split(':');
	if (parts.length >= 2) {
		return { groupKey: parts[0], deliveryToken: parts.slice(1).join(':') };
	}
	return { groupKey: payload };
}

/** Encrypt a group message with the shared symmetric key. */
export function encryptGroupMessage(
	plaintext: string,
	groupKeyB64: string
): { ciphertext: string; nonce: string } {
	const key = decodeBase64(groupKeyB64);
	const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
	const messageBytes = decodeUTF8(plaintext);
	const encrypted = nacl.secretbox(messageBytes, nonce, key);

	return {
		ciphertext: encodeBase64(encrypted),
		nonce: encodeBase64(nonce),
	};
}

/** Decrypt a group message with the shared symmetric key. */
export function decryptGroupMessage(
	ciphertextB64: string,
	nonceB64: string,
	groupKeyB64: string
): string {
	const key = decodeBase64(groupKeyB64);
	const nonce = decodeBase64(nonceB64);
	const ciphertext = decodeBase64(ciphertextB64);
	const decrypted = nacl.secretbox.open(ciphertext, nonce, key);

	if (!decrypted) {
		throw new Error('Group message decryption failed');
	}

	return encodeUTF8(decrypted);
}
