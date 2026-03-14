/**
 * Profile encryption: encrypt bio, age, tags with a per-profile symmetric key.
 * Key is stored on the profile row itself — anyone who can fetch the profile
 * via the API can decrypt. Protects against raw database dumps.
 */
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from './util';

export interface ProfileFields {
	bio: string;
	age: number | null;
	tags: string[];
}

/** Generate a random 32-byte profile encryption key (base64). */
export function generateProfileKey(): string {
	return encodeBase64(nacl.randomBytes(nacl.secretbox.keyLength));
}

/** Encrypt profile fields with the profile key. */
export function encryptProfileFields(
	fields: ProfileFields,
	profileKeyB64: string
): { encryptedFields: string; nonce: string } {
	const key = decodeBase64(profileKeyB64);
	const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
	const plaintext = decodeUTF8(JSON.stringify(fields));
	const ciphertext = nacl.secretbox(plaintext, nonce, key);
	return {
		encryptedFields: encodeBase64(ciphertext),
		nonce: encodeBase64(nonce),
	};
}

/** Decrypt profile fields with the profile key. */
export function decryptProfileFields(
	encryptedFieldsB64: string,
	nonceB64: string,
	profileKeyB64: string
): ProfileFields {
	const key = decodeBase64(profileKeyB64);
	const nonce = decodeBase64(nonceB64);
	const ciphertext = decodeBase64(encryptedFieldsB64);
	const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
	if (!decrypted) throw new Error('Profile decryption failed');
	return JSON.parse(encodeUTF8(decrypted));
}
