/**
 * Client-side media encryption/decryption.
 * Photos are encrypted with a random symmetric key before upload.
 * The key is stored locally (and can be shared with specific recipients).
 */
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from './util';

export interface EncryptedMedia {
	encryptedBlob: Uint8Array;
	nonce: string; // base64
	key: string; // base64 - the symmetric key (kept by uploader)
}

/**
 * Encrypt a file (photo) client-side before uploading.
 * Returns the encrypted blob + the symmetric key.
 */
export function encryptMedia(data: Uint8Array): EncryptedMedia {
	const key = nacl.randomBytes(nacl.secretbox.keyLength); // 32 bytes
	const nonce = nacl.randomBytes(nacl.secretbox.nonceLength); // 24 bytes
	const encrypted = nacl.secretbox(data, nonce, key);

	return {
		encryptedBlob: encrypted,
		nonce: encodeBase64(nonce),
		key: encodeBase64(key),
	};
}

/**
 * Decrypt an encrypted media blob using the symmetric key.
 */
export function decryptMedia(encryptedBlob: Uint8Array, nonceB64: string, keyB64: string): Uint8Array {
	const nonce = decodeBase64(nonceB64);
	const key = decodeBase64(keyB64);
	const decrypted = nacl.secretbox.open(encryptedBlob, nonce, key);

	if (!decrypted) {
		throw new Error('Media decryption failed');
	}

	return decrypted;
}

/**
 * Wrap a media key for a specific recipient using nacl.box.
 * This allows you to share the photo key with someone without exposing it.
 */
export function wrapKeyForRecipient(
	mediaKey: string, // base64
	myBoxSecretKey: Uint8Array,
	theirBoxPublicKey: Uint8Array
): { wrappedKey: string; nonce: string } {
	const key = decodeBase64(mediaKey);
	const nonce = nacl.randomBytes(nacl.box.nonceLength);
	const encrypted = nacl.box(key, nonce, theirBoxPublicKey, myBoxSecretKey);

	return {
		wrappedKey: encodeBase64(encrypted),
		nonce: encodeBase64(nonce),
	};
}

/**
 * Unwrap a media key that was encrypted for us.
 */
export function unwrapKey(
	wrappedKey: string, // base64
	nonce: string, // base64
	theirBoxPublicKey: Uint8Array,
	myBoxSecretKey: Uint8Array
): string {
	const encrypted = decodeBase64(wrappedKey);
	const nonceBytes = decodeBase64(nonce);
	const decrypted = nacl.box.open(encrypted, nonceBytes, theirBoxPublicKey, myBoxSecretKey);

	if (!decrypted) {
		throw new Error('Failed to unwrap media key');
	}

	return encodeBase64(decrypted);
}

/**
 * Read a File object as Uint8Array.
 */
export async function fileToUint8Array(file: File): Promise<Uint8Array> {
	const buffer = await file.arrayBuffer();
	return new Uint8Array(buffer);
}

/**
 * Create an object URL from decrypted bytes + mime type.
 */
export function bytesToObjectUrl(data: Uint8Array, mimeType: string): string {
	const blob = new Blob([data], { type: mimeType });
	return URL.createObjectURL(blob);
}
