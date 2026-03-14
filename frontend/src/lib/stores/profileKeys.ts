/**
 * Profile key cache: stores decrypted profile keys in IndexedDB.
 * Keys are cached on first encounter so "saw this person yesterday" still works.
 * Own profile key is stored separately in the 'proximity' kv store.
 */
import { generateProfileKey } from '$lib/crypto/profile';

interface CachedProfileKey {
	ownerDid: string;
	profileKey: string; // base64 plaintext key (after unwrapping)
	keyVersion: number;
	cachedAt: string;
}

let dbPromise: Promise<any> | null = null;
let currentProfileDid: string | null = null;

/** Initialize the profile key store for a specific user DID. */
export function initProfileKeyStore(did: string): void {
	if (currentProfileDid !== did) {
		currentProfileDid = did;
		dbPromise = null; // Force re-open with new DID namespace
	}
}

async function getDb() {
	if (!dbPromise) {
		const { openDB } = await import('idb');
		// Namespace DB by user DID so each identity has its own profile key cache
		const suffix = currentProfileDid ? `-${currentProfileDid.slice(-12)}` : '';
		dbPromise = openDB(`proximity-profile-keys${suffix}`, 1, {
			upgrade(db) {
				if (!db.objectStoreNames.contains('keys')) {
					db.createObjectStore('keys', { keyPath: 'ownerDid' });
				}
			}
		});
	}
	return dbPromise;
}

/** Get a cached profile key for a DID. */
export async function getCachedProfileKey(ownerDid: string): Promise<{ key: string; version: number } | null> {
	try {
		const db = await getDb();
		const cached: CachedProfileKey | undefined = await db.get('keys', ownerDid);
		if (cached) {
			return { key: cached.profileKey, version: cached.keyVersion };
		}
	} catch {}
	return null;
}

/** Cache a profile key after unwrapping. */
export async function cacheProfileKey(ownerDid: string, profileKey: string, keyVersion: number): Promise<void> {
	try {
		const db = await getDb();
		await db.put('keys', {
			ownerDid,
			profileKey,
			keyVersion,
			cachedAt: new Date().toISOString(),
		} as CachedProfileKey);
	} catch {}
}

/** Invalidate a cached profile key (e.g. after key rotation). */
export async function invalidateProfileKey(ownerDid: string): Promise<void> {
	try {
		const db = await getDb();
		await db.delete('keys', ownerDid);
	} catch {}
}

// --- Own profile key management (stored in proximity kv store) ---

async function getKvDb() {
	const { openDB } = await import('idb');
	return openDB('proximity', 1, {
		upgrade(db) {
			if (!db.objectStoreNames.contains('kv')) {
				db.createObjectStore('kv');
			}
		}
	});
}

interface OwnProfileKeyData {
	key: string; // base64
	version: number;
}

/** Load or create own profile key. Namespaced by DID to avoid cross-identity leaks. */
export async function getMyProfileKey(): Promise<OwnProfileKeyData> {
	const namespacedKey = currentProfileDid ? `profile-key-${currentProfileDid.slice(-12)}` : null;
	const kvKey = namespacedKey || 'profile-key';
	try {
		const db = await getKvDb();
		const existing: OwnProfileKeyData | undefined = await db.get('kv', kvKey);
		if (existing) return existing;

		// Migration: if using namespaced key but not found, check un-namespaced key
		if (namespacedKey) {
			const fallback: OwnProfileKeyData | undefined = await db.get('kv', 'profile-key');
			if (fallback) {
				await db.put('kv', fallback, namespacedKey);
				return fallback;
			}
		}
	} catch {}

	// Generate new key
	const data: OwnProfileKeyData = { key: generateProfileKey(), version: 0 };
	try {
		const db = await getKvDb();
		await db.put('kv', data, kvKey);
	} catch {}
	return data;
}

/** Rotate own profile key — generates new key, bumps version. */
export async function rotateMyProfileKey(): Promise<OwnProfileKeyData> {
	const current = await getMyProfileKey();
	const data: OwnProfileKeyData = {
		key: generateProfileKey(),
		version: current.version + 1,
	};
	const kvKey = currentProfileDid ? `profile-key-${currentProfileDid.slice(-12)}` : 'profile-key';
	try {
		const db = await getKvDb();
		await db.put('kv', data, kvKey);
	} catch {}
	return data;
}

/** Get all cached profile keys (for re-wrapping after rotation). */
export async function getAllCachedProfileKeys(): Promise<CachedProfileKey[]> {
	try {
		const db = await getDb();
		return await db.getAll('keys');
	} catch {
		return [];
	}
}
