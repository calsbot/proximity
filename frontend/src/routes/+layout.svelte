<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { loadIdentityFromStorage } from '$lib/crypto/identity';
	import type { Identity } from '$lib/crypto/identity';
	import { goto, afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { updated } from '$app/stores';
	import { encodeBase64 } from '$lib/crypto/util';
	import { identityStore, initIdentitySync, broadcastIdentityChange, cacheIdentityInSession, restoreIdentityFromSession, requestIdentityFromTabs } from '$lib/stores/identity';
	import { conversationsStore } from '$lib/stores/conversations';
	import { requestCountStore } from '$lib/stores/requestCount';
	import { register, getProfile, getFlagStatus, getDMInvitations, listPendingInvites, listMyAdminJoinRequests } from '$lib/api';
	import { initChat } from '$lib/services/chat';
	import { initNotifications } from '$lib/services/notifications';
	import { wsStatus } from '$lib/services/websocket';

	let throttleLevel = $state<'none' | 'throttled' | 'hidden'>('none');
	let showOffline = $state(false);
	let offlineTimer: ReturnType<typeof setTimeout> | null = null;

	// Show "offline" banner only after 5s of sustained disconnection (avoids flashing during reconnects).
	// Only show when the user has an identity — before login, WS is intentionally not connected.
	$effect(() => {
		const hasIdentity = !!$identityStore.identity;
		if (hasIdentity && $wsStatus === 'disconnected') {
			if (!offlineTimer) {
				offlineTimer = setTimeout(() => { showOffline = true; }, 5000);
			}
		} else {
			if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
			showOffline = false;
		}
	});

	let totalUnread = $derived($conversationsStore.reduce((sum, c) => sum + c.unreadCount, 0) + $requestCountStore);

	let { children } = $props();

	let checked = $state(false);
	let activeNav = $derived.by(() => {
		const p = page.url.pathname;
		if (p.startsWith('/grid')) return 'grid';
		if (p.startsWith('/chat')) return 'chat';
		if (p.startsWith('/profile')) return 'profile';
		return '';
	});

	// Hide bottom nav on setup/invite pages only
	let showNav = $derived.by(() => {
		const p = page.url.pathname;
		if (p.startsWith('/setup')) return false;
		if (p.startsWith('/invite')) return false;
		return true;
	});

	// Must be called synchronously during component init (not after await)
	afterNavigate(() => {
		if ($updated) {
			window.location.reload();
		}
	});

	onMount(async () => {
		initIdentitySync();

		try {
			// Always load the canonical identity from IndexedDB (shared across all tabs)
			const identity = await loadIdentityFromStorage();

			// If sessionStorage has a different identity, overwrite it with the canonical one
			const cached = restoreIdentityFromSession();
			if (identity && cached && cached.did !== identity.did) {
				cacheIdentityInSession(identity);
			}
			if (identity) {
				const registered = await ensureRegistered(identity);
				if (!registered) {
					const path = page.url.pathname;
					if (path.startsWith('/invite')) {
						// On invite page, keep identity so user can join directly
						cacheIdentityInSession(identity);
						identityStore.set({ identity, loading: false, error: null });
					} else {
						// Server doesn't have this profile — send to setup to pick a name
						identityStore.set({ identity: null, loading: false, error: null });
						if (!path.startsWith('/setup')) {
							checked = true;
							goto('/setup');
							return;
						}
					}
				} else {
					cacheIdentityInSession(identity);
					identityStore.set({ identity, loading: false, error: null });
				}
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
					const registered = await ensureRegistered(fromTab);
					if (registered) {
						identityStore.set({ identity: fromTab, loading: false, error: null });
					} else {
						identityStore.set({ identity: null, loading: false, error: null });
						const path = page.url.pathname;
						if (!path.startsWith('/setup') && !path.startsWith('/invite')) {
							checked = true;
							goto('/setup');
							return;
						}
					}
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

		// Check if current user is flagged + count invitations
		const id = $identityStore.identity;
		if (id) {
			// Initialize chat (WS + polling) early so notifications work on all pages
			await initChat();

			// Register service worker (no auto-prompt — user enables in settings)
			await initNotifications();

			try {
				const status = await getFlagStatus(id.did);
				throttleLevel = status.level;
			} catch {}
			try {
				const [dmInvs, groupInvs, adminJoinReqs] = await Promise.all([
					getDMInvitations(id.did),
					listPendingInvites(id.did),
					listMyAdminJoinRequests(id.did),
				]);
				requestCountStore.set(dmInvs.length + groupInvs.length + adminJoinReqs.length);
			} catch {}
		}
	});

	/**
	 * Ensure the identity is registered on the server (re-registers if DB was wiped).
	 * If server has no profile for this DID, return false so caller can redirect to setup.
	 */
	async function ensureRegistered(identity: Identity): Promise<boolean> {
		try {
			const profile = await getProfile(identity.did);
			// Profile exists — update keys in case they changed
			try {
				await register(
					identity.did,
					profile.displayName,
					encodeBase64(identity.publicKey),
					encodeBase64(identity.boxPublicKey)
				);
			} catch {}
			return true;
		} catch (e) {
			// Distinguish 404 (profile missing) from network errors (server down)
			const msg = e instanceof Error ? e.message : '';
			if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
				// Profile doesn't exist — need to go through setup
				return false;
			}
			// Network error — assume we're registered, chat will reconnect later
			return true;
		}
	}
</script>

<div class="app" class:has-nav={showNav}>
	{#if showOffline}
		<div class="offline-banner">connecting to server...</div>
	{/if}
	{#if throttleLevel === 'throttled'}
		<div class="throttle-banner">
			your account is restricted. messages limited to 1/min. <a href="/settings">appeal</a>
		</div>
	{:else if throttleLevel === 'hidden'}
		<div class="throttle-banner hidden-banner">
			your profile is hidden from discovery. <a href="/settings">appeal</a>
		</div>
	{/if}
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
			<a href="https://cryptpad.fr/form/#/2/form/view/44z61IFZ7azDQnYRFB5RsGOlP8n29vV2CpfU7PQe2ow/" target="_blank" rel="noopener" class="nav-report">report</a>
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
	.nav-report {
		position: absolute;
		right: 12px;
		font-size: 11px;
		color: var(--text-tertiary);
		text-decoration: none;
		padding: 4px 6px;
	}

	.offline-banner {
		font-size: 12px;
		color: var(--text-muted);
		padding: 6px 12px;
		border: 1px solid var(--border);
		margin-bottom: 8px;
		text-align: center;
	}
	.throttle-banner {
		font-size: 12px;
		color: var(--text-muted);
		padding: 8px 12px;
		border: 1px solid var(--border);
		margin-bottom: 8px;
		line-height: 1.4;
	}
	.throttle-banner a {
		color: var(--text);
		text-decoration: underline;
	}
	.hidden-banner {
		border-color: var(--text-muted);
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
