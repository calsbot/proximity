<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { loadIdentityFromStorage } from '$lib/crypto/identity';
	import type { Identity } from '$lib/crypto/identity';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { encodeBase64 } from '$lib/crypto/util';
	import { identityStore, initIdentitySync, broadcastIdentityChange, cacheIdentityInSession, restoreIdentityFromSession, requestIdentityFromTabs } from '$lib/stores/identity';
	import { conversationsStore } from '$lib/stores/conversations';
	import { register } from '$lib/api';

	let totalUnread = $derived($conversationsStore.reduce((sum, c) => sum + c.unreadCount, 0));

	let { children } = $props();

	let checked = $state(false);
	let activeNav = $derived.by(() => {
		const p = page.url.pathname;
		if (p.startsWith('/grid')) return 'grid';
		if (p.startsWith('/chat')) return 'chat';
		if (p.startsWith('/profile')) return 'profile';
		return '';
	});

	// Hide bottom nav on setup/invite pages and inside chat conversations
	let showNav = $derived.by(() => {
		const p = page.url.pathname;
		if (p.startsWith('/setup')) return false;
		if (p.startsWith('/invite')) return false;
		if (p.match(/^\/chat\/[^/]+/)) return false;
		return true;
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

<div class="app" class:has-nav={showNav}>
	<main>
		{#if !checked}
			<div class="loading-screen">
				<p class="status">loading...</p>
			</div>
		{:else}
			{@render children()}
		{/if}
	</main>
	{#if showNav}
		<nav class="bottom-nav">
			<a href="/grid" class="nav-item" class:active={activeNav === 'grid'}>
				<span class="nav-label">nearby</span>
			</a>
			<a href="/chat" class="nav-item" class:active={activeNav === 'chat'}>
				<span class="nav-label">messages</span>
				{#if totalUnread > 0}
					<span class="nav-badge">{totalUnread}</span>
				{/if}
			</a>
			<a href="/profile/edit" class="nav-item" class:active={activeNav === 'profile'}>
				<span class="nav-label">profile</span>
			</a>
		</nav>
	{/if}
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
		padding-top: max(12px, var(--safe-top));
		padding-left: max(16px, var(--safe-left));
		padding-right: max(16px, var(--safe-right));
	}
	.app.has-nav {
		padding-bottom: calc(var(--nav-height) + var(--safe-bottom) + 8px);
	}
	main {
		flex: 1;
		padding: 0 0 16px;
	}

	/* Bottom navigation */
	.bottom-nav {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		height: calc(var(--nav-height) + var(--safe-bottom));
		padding-bottom: var(--safe-bottom);
		background: var(--bg);
		border-top: 1px solid var(--border);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}
	.nav-item {
		display: flex;
		align-items: center;
		justify-content: center;
		height: var(--nav-height);
		padding: 0 24px;
		text-decoration: none;
		color: var(--text-muted);
		transition: color 0.1s;
		position: relative;
	}
	@media (hover: hover) {
		.nav-item:hover {
			color: var(--text);
			text-decoration: none;
		}
	}
	.nav-item.active {
		color: var(--white);
	}
	.nav-item.active::before {
		content: '';
		position: absolute;
		top: 0;
		left: 50%;
		transform: translateX(-50%);
		width: 24px;
		height: 2px;
		background: var(--white);
	}
	.nav-label {
		font-size: 14px;
		font-weight: 400;
		letter-spacing: 0.01em;
	}
	.nav-badge {
		background: var(--white);
		color: var(--bg);
		font-size: 10px;
		font-weight: 600;
		padding: 2px 4px;
		margin-left: 6px;
		line-height: 1;
	}

	.loading-screen {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 60vh;
	}
	.status {
		color: var(--text-muted);
		font-size: 14px;
	}
</style>
