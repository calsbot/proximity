<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { loadIdentityFromStorage } from '$lib/crypto/identity';
	import type { Identity } from '$lib/crypto/identity';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { encodeBase64 } from '$lib/crypto/util';
	import { identityStore, initIdentitySync, broadcastIdentityChange, cacheIdentityInSession, restoreIdentityFromSession, requestIdentityFromTabs } from '$lib/stores/identity';
	import { register } from '$lib/api';

	let { children } = $props();

	let checked = $state(false);
	let activeNav = $derived.by(() => {
		const p = page.url.pathname;
		if (p.startsWith('/grid')) return 'grid';
		if (p.startsWith('/chat')) return 'chat';
		if (p.startsWith('/profile')) return 'profile';
		return '';
	});

	onMount(async () => {
		initIdentitySync();

		// Try to restore from sessionStorage first (fast path for reloads)
		const cached = restoreIdentityFromSession();
		if (cached) {
			await ensureRegistered(cached);
			identityStore.set({ identity: cached, loading: false, error: null });
			checked = true;
			return;
		}

		try {
			// Load directly from IndexedDB/localStorage — no passphrase needed
			const identity = await loadIdentityFromStorage();
			if (identity) {
				await ensureRegistered(identity);
				cacheIdentityInSession(identity);
				identityStore.set({ identity, loading: false, error: null });
			} else {
				// Try to get identity from another tab
				requestIdentityFromTabs();
				await new Promise<void>((resolve) => {
					const unsub = identityStore.subscribe((state) => {
						if (state.identity) {
							unsub();
							resolve();
						}
					});
					setTimeout(() => { unsub(); resolve(); }, 300);
				});

				// Check if another tab provided it
				const fromTab = restoreIdentityFromSession();
				if (fromTab) {
					await ensureRegistered(fromTab);
					identityStore.set({ identity: fromTab, loading: false, error: null });
				} else {
					identityStore.set({ identity: null, loading: false, error: null });
					// No identity — redirect to setup unless already there
					const path = page.url.pathname;
					if (!path.startsWith('/setup') && !path.startsWith('/invite')) {
						checked = true;
						goto('/setup');
						return;
					}
				}
			}
		} catch {
			identityStore.set({ identity: null, loading: false, error: 'failed to load identity' });
		}
		checked = true;
	});

	/**
	 * Ensure the identity is registered on the server (re-registers if DB was wiped).
	 */
	async function ensureRegistered(identity: Identity): Promise<void> {
		try {
			await register(
				identity.did,
				'user',
				encodeBase64(identity.publicKey),
				encodeBase64(identity.boxPublicKey)
			);
		} catch {
			// Non-fatal — server might already know us
		}
	}
</script>

<div class="app">
	<header>
		<nav class="nav-links">
			<a href="/grid" class:active={activeNav === 'grid'}>nearby</a>
			<a href="/chat" class:active={activeNav === 'chat'}>messages</a>
			<a href="/profile/edit" class:active={activeNav === 'profile'}>profile</a>
		</nav>
	</header>
	<main>
		{#if !checked}
			<div class="loading-card">
				<p class="status">loading...</p>
			</div>
		{:else}
			{@render children()}
		{/if}
	</main>
</div>

<style>
	.app {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
		min-height: 100dvh;
		max-width: 600px;
		margin: 0 auto;
		padding: 0 16px;
		padding-top: var(--safe-top);
		padding-bottom: var(--safe-bottom);
		padding-left: max(16px, var(--safe-left));
		padding-right: max(16px, var(--safe-right));
	}
	main {
		flex: 1;
		padding: 16px 0 40px;
	}
	header {
		position: sticky;
		top: 0;
		background: var(--bg);
		z-index: 10;
	}
	.nav-links {
		display: flex;
		gap: 0;
		align-items: center;
		border-bottom: 1px solid var(--border);
	}
	.nav-links a {
		position: relative;
		color: var(--text-muted);
		font-size: 13px;
		min-height: 44px;
		display: flex;
		align-items: center;
		padding: 0 16px;
		text-decoration: none;
		transition: color 0.15s;
	}
	.nav-links a:first-child {
		padding-left: 0;
	}
	.nav-links a:hover {
		color: var(--text);
		text-decoration: none;
	}
	.nav-links a.active {
		color: var(--text);
	}
	.nav-links a.active::after {
		content: '';
		position: absolute;
		bottom: -1px;
		left: 0;
		right: 0;
		height: 1px;
		background: var(--text);
	}
	.loading-card {
		max-width: 420px;
	}
	.status {
		color: var(--text-muted);
		text-align: center;
		padding: 40px 0;
	}
</style>
