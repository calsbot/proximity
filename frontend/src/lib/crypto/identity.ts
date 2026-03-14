/**
 * Identity layer: Ed25519 signing + X25519 encryption keypairs, DID derivation, IndexedDB + localStorage persistence.
 * Uses tweetnacl (pure JS, no WASM/bundler issues).
 *
 * Each identity has TWO keypairs:
 * - Ed25519 (sign/verify) — used for DID, authentication, signatures
 * - X25519 (box/unbox) — used for E2EE messaging (Diffie-Hellman key exchange)
 *
 * Identity is stored as plain JSON (no passphrase encryption).
 * IndexedDB is primary storage, localStorage is fallback (Safari clears IndexedDB on crashes).
 */
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from './util';

export interface Identity {
	did: string;
	publicKey: Uint8Array;       // Ed25519 signing public key
	secretKey: Uint8Array;       // Ed25519 signing secret key (64 bytes: seed+pub)
	boxPublicKey: Uint8Array;    // X25519 encryption public key
	boxSecretKey: Uint8Array;    // X25519 encryption secret key
}

/** Serialized identity for JSON storage (base64-encoded keys). */
export interface StoredIdentity {
	did: string;
	publicKey: string; // base64
	secretKey: string; // base64
	boxPublicKey: string; // base64
	boxSecretKey: string; // base64
}

/**
 * Generate a new identity with Ed25519 (signing) + X25519 (encryption) keypairs.
 */
export function generateIdentity(): Identity {
	const signKp = nacl.sign.keyPair();
	const boxKp = nacl.box.keyPair();
	const did = publicKeyToDid(signKp.publicKey);
	return {
		did,
		publicKey: signKp.publicKey,
		secretKey: signKp.secretKey,
		boxPublicKey: boxKp.publicKey,
		boxSecretKey: boxKp.secretKey
	};
}

/**
 * Encode an Ed25519 public key as a did:key identifier.
 * Format: did:key:z6Mk... (multicodec ed25519-pub 0xed01 + multibase base58btc 'z')
 */
export function publicKeyToDid(publicKey: Uint8Array): string {
	const multicodec = new Uint8Array([0xed, 0x01, ...publicKey]);
	const encoded = base58btcEncode(multicodec);
	return `did:key:z${encoded}`;
}

/**
 * Extract the raw public key from a did:key string.
 */
export function didToPublicKey(did: string): Uint8Array {
	if (!did.startsWith('did:key:z')) throw new Error('Invalid did:key format');
	const decoded = base58btcDecode(did.slice(8));
	if (decoded[0] !== 0xed || decoded[1] !== 0x01) {
		throw new Error('Not an ed25519 did:key');
	}
	return decoded.slice(2);
}

/**
 * Sign arbitrary data with the identity's secret key.
 */
export function sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
	return nacl.sign.detached(message, secretKey);
}

/**
 * Verify a signature against a public key.
 */
export function verify(
	publicKey: Uint8Array,
	message: Uint8Array,
	signature: Uint8Array
): boolean {
	return nacl.sign.detached.verify(message, signature, publicKey);
}

/** Serialize an Identity to plain JSON (base64 keys). */
export function serializeIdentity(identity: Identity): StoredIdentity {
	return {
		did: identity.did,
		publicKey: encodeBase64(identity.publicKey),
		secretKey: encodeBase64(identity.secretKey),
		boxPublicKey: encodeBase64(identity.boxPublicKey),
		boxSecretKey: encodeBase64(identity.boxSecretKey),
	};
}

/** Deserialize a StoredIdentity back to an Identity. */
export function deserializeIdentity(stored: StoredIdentity): Identity {
	return {
		did: stored.did,
		publicKey: decodeBase64(stored.publicKey),
		secretKey: decodeBase64(stored.secretKey),
		boxPublicKey: decodeBase64(stored.boxPublicKey),
		boxSecretKey: decodeBase64(stored.boxSecretKey),
	};
}

const LOCALSTORAGE_KEY = 'proximity-identity';

/**
 * Store identity in IndexedDB (primary) and localStorage (fallback).
 */
export async function saveIdentityToStorage(identity: Identity): Promise<void> {
	const serialized = serializeIdentity(identity);

	// Save to localStorage as fallback
	try {
		localStorage.setItem(LOCALSTORAGE_KEY, JSON.stringify(serialized));
	} catch {}

	// Save to IndexedDB
	const { openDB } = await import('idb');
	const db = await openDB('proximity', 2, {
		upgrade(db) {
			if (!db.objectStoreNames.contains('identity')) {
				db.createObjectStore('identity');
			}
		}
	});
	await db.put('identity', serialized, 'current');
}

/**
 * Load identity from IndexedDB first, then localStorage fallback.
 * Returns null if no identity found.
 */
export async function loadIdentityFromStorage(): Promise<Identity | null> {
	// Try IndexedDB first
	try {
		const { openDB } = await import('idb');
		const db = await openDB('proximity', 2, {
			upgrade(db) {
				if (!db.objectStoreNames.contains('identity')) {
					db.createObjectStore('identity');
				}
			}
		});
		const stored: StoredIdentity | undefined = await db.get('identity', 'current');
		if (stored && stored.did && stored.secretKey) {
			return deserializeIdentity(stored);
		}
	} catch {}

	// Fallback to localStorage
	try {
		const raw = localStorage.getItem(LOCALSTORAGE_KEY);
		if (raw) {
			const stored: StoredIdentity = JSON.parse(raw);
			if (stored.did && stored.secretKey) {
				return deserializeIdentity(stored);
			}
		}
	} catch {}

	return null;
}

/**
 * Download the identity as a backup JSON file.
 * Auto-downloads silently without blocking.
 */
export function downloadIdentityBackup(identity: Identity): void {
	const serialized = serializeIdentity(identity);
	const blob = new Blob(
		[JSON.stringify(serialized, null, 2)],
		{ type: 'application/json' }
	);
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `meetmarket-identity-${identity.did.slice(-8)}.json`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

/**
 * Import an identity from a backup JSON file.
 * Validates the structure before returning.
 */
export async function importIdentityBackup(file: File): Promise<Identity> {
	const text = await file.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error('invalid file — not valid JSON');
	}

	const obj = parsed as Record<string, unknown>;

	// Support new format (plain keys)
	if (typeof obj.did === 'string' && typeof obj.secretKey === 'string' && typeof obj.publicKey === 'string') {
		const stored = obj as unknown as StoredIdentity;
		return deserializeIdentity(stored);
	}

	// Legacy encrypted format — can't decrypt without passphrase
	if (typeof obj.encryptedSecretKey === 'string') {
		throw new Error('this is a passphrase-encrypted backup from an older version — it cannot be imported');
	}

	throw new Error('invalid backup file — missing required fields');
}

/**
 * Clear stored identity from IndexedDB and localStorage.
 */
export async function clearIdentityFromStorage(): Promise<void> {
	try {
		localStorage.removeItem(LOCALSTORAGE_KEY);
	} catch {}

	try {
		const { openDB } = await import('idb');
		const db = await openDB('proximity', 2, {
			upgrade(db) {
				if (!db.objectStoreNames.contains('identity')) {
					db.createObjectStore('identity');
				}
			}
		});
		await db.delete('identity', 'current');
	} catch {}
}

// --- Base58btc encoding (minimal, no external deps) ---

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58btcEncode(bytes: Uint8Array): string {
	const digits = [0];
	for (const byte of bytes) {
		let carry = byte;
		for (let j = 0; j < digits.length; j++) {
			carry += digits[j] << 8;
			digits[j] = carry % 58;
			carry = (carry / 58) | 0;
		}
		while (carry > 0) {
			digits.push(carry % 58);
			carry = (carry / 58) | 0;
		}
	}
	let str = '';
	for (let i = 0; i < bytes.length && bytes[i] === 0; i++) str += '1';
	for (let i = digits.length - 1; i >= 0; i--) str += BASE58_ALPHABET[digits[i]];
	return str;
}

function base58btcDecode(str: string): Uint8Array {
	const bytes = [0];
	for (const char of str) {
		const value = BASE58_ALPHABET.indexOf(char);
		if (value < 0) throw new Error(`Invalid base58 character: ${char}`);
		let carry = value;
		for (let j = 0; j < bytes.length; j++) {
			carry += bytes[j] * 58;
			bytes[j] = carry & 0xff;
			carry >>= 8;
		}
		while (carry > 0) {
			bytes.push(carry & 0xff);
			carry >>= 8;
		}
	}
	for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
	return new Uint8Array(bytes.reverse());
}
