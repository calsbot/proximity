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

/** Wrap the group key for each member using their boxPublicKey. */
export function wrapGroupKeyForMembers(
	groupKeyB64: string,
	myBoxSecretKey: Uint8Array,
	members: Array<{ did: string; boxPublicKey: string }>
): Array<{ memberDid: string; wrappedKey: string; wrappedKeyNonce: string }> {
	return members
		.filter(m => m.boxPublicKey)
		.map(m => {
			const { wrappedKey, nonce } = wrapKeyForRecipient(
				groupKeyB64,
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

/** Unwrap a group key that was encrypted for us. */
export function unwrapGroupKey(
	wrappedKey: string,
	nonce: string,
	senderBoxPublicKey: Uint8Array,
	myBoxSecretKey: Uint8Array
): string {
	return unwrapKey(wrappedKey, nonce, senderBoxPublicKey, myBoxSecretKey);
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
