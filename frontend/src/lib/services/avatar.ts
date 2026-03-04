/**
 * Avatar decryption service with in-memory cache.
 * Fetches encrypted avatar blobs, decrypts them, and returns object URLs.
 */
import { getMediaBlob } from '$lib/api';
import { decryptMedia, bytesToObjectUrl } from '$lib/crypto/media';

const cache = new Map<string, string>(); // mediaId → objectURL
const pending = new Map<string, Promise<string | null>>(); // mediaId → in-flight promise

/**
 * Get a decrypted avatar object URL for a profile.
 * Returns null if no avatar, or if decryption fails.
 * Results are cached by mediaId — repeated calls return the same object URL.
 */
export function getDecryptedAvatarUrl(
	mediaId: string | null,
	avatarKey: string | null,
	avatarNonce: string | null
): Promise<string | null> {
	if (!mediaId || !avatarKey || !avatarNonce) return Promise.resolve(null);

	// Return cached URL if available
	const cached = cache.get(mediaId);
	if (cached) return Promise.resolve(cached);

	// Deduplicate in-flight requests for the same mediaId
	const inflight = pending.get(mediaId);
	if (inflight) return inflight;

	const promise = (async () => {
		try {
			const encryptedBuf = await getMediaBlob(mediaId);
			const decrypted = decryptMedia(new Uint8Array(encryptedBuf), avatarNonce, avatarKey);
			const url = bytesToObjectUrl(decrypted, 'image/jpeg');
			cache.set(mediaId, url);
			return url;
		} catch {
			return null;
		} finally {
			pending.delete(mediaId);
		}
	})();

	pending.set(mediaId, promise);
	return promise;
}

/**
 * Clear the avatar cache (e.g., on logout).
 */
export function clearAvatarCache() {
	for (const url of cache.values()) {
		URL.revokeObjectURL(url);
	}
	cache.clear();
	pending.clear();
}
