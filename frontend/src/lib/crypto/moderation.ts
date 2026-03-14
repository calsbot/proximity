/**
 * Moderation crypto: create DID-signed flag annotations.
 * Uses Ed25519 detached signatures to prove flag authorship.
 */
import nacl from 'tweetnacl';
import { encodeBase64, decodeUTF8 } from './util';

export interface FlagPayload {
	flaggerDid: string;
	flaggedDid: string;
	category: 'fake_profile' | 'harassment' | 'underage' | 'spam';
	timestamp: number;
}

/**
 * Create a signed flag annotation.
 * Returns base64-encoded signed blob and detached signature.
 */
export function createSignedFlag(
	payload: FlagPayload,
	signingSecretKey: Uint8Array
): { signedBlob: string; signature: string } {
	const json = JSON.stringify(payload);
	const message = decodeUTF8(json);
	const signedBlobB64 = encodeBase64(message);
	const signature = nacl.sign.detached(message, signingSecretKey);
	return {
		signedBlob: signedBlobB64,
		signature: encodeBase64(signature),
	};
}
