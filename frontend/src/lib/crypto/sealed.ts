/**
 * Sealed Sender: hides the sender's identity from the server.
 *
 * Two-layer encryption:
 * - Inner layer: existing Double Ratchet ciphertext (senderDid, groupId, epoch, etc.)
 * - Outer layer: nacl.box with an ephemeral X25519 keypair → recipient's long-term box key
 *
 * The server sees only: recipientDid + deliveryToken + opaque blob.
 * It cannot determine who sent the message.
 */
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, decodeUTF8, encodeUTF8 } from './util';
import type { EncryptedMessage } from './messaging';

/** Inner envelope — what the recipient sees after unsealing. */
export interface SealedInnerEnvelope {
	senderDid: string;
	groupId: string;
	epoch: number;
	ciphertext: string; // base64 — Double Ratchet ciphertext
	nonce: string; // base64 — Double Ratchet nonce
	dhPublicKey?: string; // base64 — DH ratchet header
	previousCounter?: number;
	timestamp: string; // ISO — for replay detection
}

/** What gets sent to the server / over WebSocket. */
export interface SealedOuterMessage {
	recipientDid: string;
	deliveryToken: string; // plaintext — server hashes to verify
	sealedPayload: string; // base64 — outer nacl.box ciphertext
	ephemeralPublicKey: string; // base64 — ephemeral X25519 pub for unsealing
	nonce: string; // base64 — outer nonce
}

/**
 * Generate a random delivery token (32 bytes, base64).
 */
export function generateDeliveryToken(): string {
	return encodeBase64(nacl.randomBytes(32));
}

/**
 * Hash a delivery token for server registration.
 * Uses Web Crypto SHA-256, returns hex.
 */
export async function hashDeliveryToken(token: string): Promise<string> {
	const data = new TextEncoder().encode(token);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Seal a message: wraps the Double Ratchet output in an outer nacl.box layer.
 *
 * @param ratchetMsg - The encrypted message from encryptMessage()
 * @param recipientBoxPubKey - Recipient's long-term X25519 public key (base64)
 * @param deliveryToken - Plaintext delivery token for server validation
 * @param senderDid - Sender's DID (included inside the sealed envelope, invisible to server)
 */
export function sealMessage(
	ratchetMsg: EncryptedMessage,
	recipientBoxPubKey: string,
	deliveryToken: string,
	senderDid: string
): SealedOuterMessage {
	// Build inner envelope
	const inner: SealedInnerEnvelope = {
		senderDid,
		groupId: ratchetMsg.groupId,
		epoch: ratchetMsg.epoch,
		ciphertext: ratchetMsg.ciphertext,
		nonce: ratchetMsg.nonce,
		dhPublicKey: ratchetMsg.dhPublicKey,
		previousCounter: ratchetMsg.previousCounter,
		timestamp: new Date().toISOString(),
	};

	const innerBytes = decodeUTF8(JSON.stringify(inner));

	// Generate ephemeral X25519 keypair for outer encryption
	const ephemeral = nacl.box.keyPair();
	const outerNonce = nacl.randomBytes(nacl.box.nonceLength);

	// Outer encryption: nacl.box(inner, nonce, recipientPubKey, ephemeralSecretKey)
	const recipientPub = decodeBase64(recipientBoxPubKey);
	const sealed = nacl.box(innerBytes, outerNonce, recipientPub, ephemeral.secretKey);

	return {
		recipientDid: ratchetMsg.recipientDid,
		deliveryToken,
		sealedPayload: encodeBase64(sealed),
		ephemeralPublicKey: encodeBase64(ephemeral.publicKey),
		nonce: encodeBase64(outerNonce),
	};
}

/**
 * Unseal a sealed message: decrypt the outer layer to reveal the inner envelope.
 *
 * @param sealedPayload - base64 outer ciphertext
 * @param ephemeralPubKey - base64 sender's ephemeral public key
 * @param nonce - base64 outer nonce
 * @param myBoxSecretKey - Recipient's long-term X25519 secret key
 */
export function unsealMessage(
	sealedPayload: string,
	ephemeralPubKey: string,
	nonce: string,
	myBoxSecretKey: Uint8Array
): SealedInnerEnvelope {
	const ciphertext = decodeBase64(sealedPayload);
	const pubKey = decodeBase64(ephemeralPubKey);
	const nonceBytes = decodeBase64(nonce);

	const decrypted = nacl.box.open(ciphertext, nonceBytes, pubKey, myBoxSecretKey);
	if (!decrypted) {
		throw new Error('Failed to unseal message');
	}

	return JSON.parse(encodeUTF8(decrypted)) as SealedInnerEnvelope;
}
