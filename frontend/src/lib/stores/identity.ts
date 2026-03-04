import { writable, derived } from 'svelte/store';
import type { Identity } from '$lib/crypto/identity';
import { encodeBase64, decodeBase64 } from '$lib/crypto/util';

interface IdentityState {
	identity: Identity | null;
	loading: boolean;
	error: string | null;
}

export const identityStore = writable<IdentityState>({
	identity: null,
	loading: true,
	error: null
});

export const isAuthenticated = derived(identityStore, ($s) => $s.identity !== null);
export const currentDid = derived(identityStore, ($s) => $s.identity?.did ?? null);

// --- Session persistence (survives page reloads, clears on tab/browser close) ---

const SESSION_KEY = 'proximity-session-identity';

interface SerializedIdentity {
	did: string;
	publicKey: string;
	secretKey: string;
	boxPublicKey: string;
	boxSecretKey: string;
}

function serializeIdentity(id: Identity): SerializedIdentity {
	return {
		did: id.did,
		publicKey: encodeBase64(id.publicKey),
		secretKey: encodeBase64(id.secretKey),
		boxPublicKey: encodeBase64(id.boxPublicKey),
		boxSecretKey: encodeBase64(id.boxSecretKey),
	};
}

function deserializeIdentity(s: SerializedIdentity): Identity {
	return {
		did: s.did,
		publicKey: decodeBase64(s.publicKey),
		secretKey: decodeBase64(s.secretKey),
		boxPublicKey: decodeBase64(s.boxPublicKey),
		boxSecretKey: decodeBase64(s.boxSecretKey),
	};
}

/**
 * Save decrypted identity to sessionStorage so it survives page reloads.
 * Clears when the browser tab/window closes.
 */
export function cacheIdentityInSession(identity: Identity): void {
	if (typeof sessionStorage === 'undefined') return;
	try {
		sessionStorage.setItem(SESSION_KEY, JSON.stringify(serializeIdentity(identity)));
	} catch {}
}

/**
 * Try to restore identity from sessionStorage (avoids re-entering passphrase on reload).
 */
export function restoreIdentityFromSession(): Identity | null {
	if (typeof sessionStorage === 'undefined') return null;
	try {
		const raw = sessionStorage.getItem(SESSION_KEY);
		if (!raw) return null;
		return deserializeIdentity(JSON.parse(raw));
	} catch {
		return null;
	}
}

/**
 * Clear cached identity from sessionStorage.
 */
export function clearIdentitySession(): void {
	if (typeof sessionStorage === 'undefined') return;
	try {
		sessionStorage.removeItem(SESSION_KEY);
	} catch {}
}

// --- Cross-tab identity sync via BroadcastChannel ---

let channel: BroadcastChannel | null = null;

/**
 * Initialize cross-tab identity sync.
 * When one tab changes identity (unlock, create new, etc.), other tabs reload.
 * When a new tab opens without an identity, it requests one from existing tabs.
 */
export function initIdentitySync(): void {
	if (typeof BroadcastChannel === 'undefined') return; // SSR guard
	if (channel) return; // already initialized

	channel = new BroadcastChannel('proximity-identity');

	channel.onmessage = (event) => {
		const { type } = event.data;
		if (type === 'identity-changed') {
			// Another tab changed identity — force reload to pick up the new state
			window.location.reload();
		} else if (type === 'identity-request') {
			// Another tab is asking for the identity — send it if we have it
			const cached = restoreIdentityFromSession();
			if (cached && channel) {
				channel.postMessage({
					type: 'identity-response',
					identity: serializeIdentity(cached),
				});
			}
		} else if (type === 'identity-response') {
			// Got identity from another tab — use it if we don't have one
			const current = restoreIdentityFromSession();
			if (!current && event.data.identity) {
				const identity = deserializeIdentity(event.data.identity);
				cacheIdentityInSession(identity);
				identityStore.set({ identity, loading: false, error: null });
			}
		}
	};
}

/**
 * Request identity from other open tabs.
 * Used when a new tab opens (e.g. invite link) without a cached session.
 */
export function requestIdentityFromTabs(): void {
	if (channel) {
		channel.postMessage({ type: 'identity-request' });
	}
}

/**
 * Notify other tabs that the identity has changed.
 * Call this after unlock, create new identity, etc.
 */
export function broadcastIdentityChange(): void {
	if (channel) {
		channel.postMessage({ type: 'identity-changed' });
	}
}
