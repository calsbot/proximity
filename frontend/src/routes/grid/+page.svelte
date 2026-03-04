<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { locationStore, hasLocation, requestLocation } from '$lib/stores/location';
	import { identityStore } from '$lib/stores/identity';
	import { distanceMeters, center, neighbors, encode, generateDecoyCells } from '$lib/geo/geohash';
	import { discoverProfiles, updateProfile, listGroups, BASE } from '$lib/api';
	import { startConversation, initChat } from '$lib/services/chat';
	import { conversationsStore } from '$lib/stores/conversations';
	import { getDecryptedAvatarUrl } from '$lib/services/avatar';
	import ProximityMap from '$lib/components/ProximityMap.svelte';

	let viewMode = $state<'grid' | 'map'>('grid');

	interface NearbyProfile {
		did: string;
		displayName: string;
		bio: string;
		age: number | null;
		boxPublicKey: string | null;
		avatarMediaId: string | null;
		avatarKey: string | null;
		avatarNonce: string | null;
		instagram: string | null;
		profileLink: string | null;
		geohashCell: string;
		lastSeen: string;
		distance?: number;
		sharedGroups: Array<{ id: string; name: string }>;
	}

	interface GroupInfo {
		id: string;
		name: string;
		memberDids: Set<string>;
	}

	let allProfiles = $state<NearbyProfile[]>([]);
	let myGroups = $state<GroupInfo[]>([]);
	let loading = $state(false);
	let locationError = $state(false);
	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	let activeFilter = $state<string>('all');

	let myDid = $derived($identityStore.identity?.did);
	let loaded = $state(false);

	// Infinite scroll state
	const BATCH_SIZE = 18; // 6 rows of 3
	let visibleCount = $state(BATCH_SIZE);
	let gridContainer: HTMLElement | undefined = $state();
	let loadingMore = $state(false);

	// Check if we already have location from the store
	let hasLoc = $derived($locationStore.geohash !== null);

	// Filtered + sorted profiles based on active filter
	let sortedProfiles = $derived.by(() => {
		if (activeFilter === 'all') {
			// Group members first sorted by distance, then non-group sorted by distance
			const groupMembers = allProfiles.filter(p => p.sharedGroups.length > 0);
			const nonGroup = allProfiles.filter(p => p.sharedGroups.length === 0);
			groupMembers.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
			nonGroup.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
			return [...groupMembers, ...nonGroup];
		}
		// Filter to specific group
		return allProfiles
			.filter(p => p.sharedGroups.some(g => g.id === activeFilter))
			.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
	});

	// Only show visibleCount profiles (for infinite scroll)
	let profiles = $derived(sortedProfiles.slice(0, visibleCount));
	let hasMore = $derived(visibleCount < sortedProfiles.length);

	// Reset visible count when filter changes
	$effect(() => {
		activeFilter;
		visibleCount = BATCH_SIZE;
	});

	$effect(() => {
		const did = myDid;
		if (!did || loaded) return;
		loaded = true;

		// Fire-and-forget chat init
		initChat().catch(() => {});

		// Check if location is already available (e.g. from a previous visit)
		const loc = get(locationStore);
		if (loc.geohash && loc.queryCells.length > 0) {
			startScanning(did, loc.queryCells);
		}
		// Otherwise, user needs to tap "enable location"
	});

	async function enableLocation() {
		loading = true;
		locationError = false;

		try {
			await requestLocation();
		} catch {
			locationError = true;
			loading = false;
			return;
		}

		const loc = get(locationStore);

		if (loc.permission === 'denied' || !loc.queryCells.length) {
			locationError = true;
			loading = false;
			return;
		}

		if (myDid) {
			startScanning(myDid, loc.queryCells);
		}
	}

	/**
	 * Build expanding-radius query cells: precision 7 (~150m), 6 (~1.2km), 5 (~5km), 4 (~40km).
	 * Each ring uses decoy cells for privacy.
	 */
	// All 32 base32 geohash characters — one per precision-1 cell, covers the entire planet
	const ALL_P1 = '0123456789bcdefghjkmnpqrstuvwxyz'.split('');

	function buildExpandingCells(lat: number, lon: number): string[] {
		const cellSet = new Set<string>();
		// Precision 7 — immediate neighborhood (~150m cells)
		const p7 = encode(lat, lon, 7);
		for (const c of generateDecoyCells(p7, 11)) cellSet.add(c);
		// Precision 6 — wider area (~1.2km cells)
		const p6 = encode(lat, lon, 6);
		for (const c of [p6, ...neighbors(p6)]) cellSet.add(c);
		// Precision 5 — city-level (~5km cells)
		const p5 = encode(lat, lon, 5);
		for (const c of [p5, ...neighbors(p5)]) cellSet.add(c);
		// All precision-1 cells — covers the entire planet
		for (const c of ALL_P1) cellSet.add(c);
		return Array.from(cellSet);
	}

	async function startScanning(did: string, queryCells: string[]) {
		loading = true;
		const loc = get(locationStore);

		// Publish our geohash cell + neighbors
		if (loc.geohash) {
			const myCells = [loc.geohash, ...neighbors(loc.geohash)];
			try {
				await updateProfile(did, { geohashCells: myCells });
			} catch {}
		}

		// Build expanding-radius cells if we have coordinates
		let expandedCells = queryCells;
		if (loc.lat && loc.lon) {
			expandedCells = buildExpandingCells(loc.lat, loc.lon);
		}

		// Fetch groups and profiles in parallel
		try {
			await Promise.all([
				fetchGroups(did),
				fetchProfiles(expandedCells)
			]);
		} catch {
			loading = false;
		}

		// Auto-refresh every 15 seconds
		if (!refreshTimer) {
			refreshTimer = setInterval(() => {
				const currentLoc = get(locationStore);
				if (currentLoc.queryCells.length > 0) {
					const d = get(identityStore).identity?.did;
					if (d) {
						fetchGroups(d);
						let cells = currentLoc.queryCells;
						if (currentLoc.lat && currentLoc.lon) {
							cells = buildExpandingCells(currentLoc.lat, currentLoc.lon);
						}
						fetchProfiles(cells);
					}
				}
			}, 15000);
		}
	}

	onDestroy(() => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
	});

	async function fetchGroups(did: string) {
		try {
			const groups = await listGroups(did);
			myGroups = groups.map(g => ({
				id: g.id,
				name: g.name,
				memberDids: new Set(g.members.map(m => m.did))
			}));
		} catch {
			myGroups = [];
		}
	}

	async function fetchProfiles(cells: string[]) {
		try {
			const data = await discoverProfiles(cells, myDid ?? undefined);
			const loc = get(locationStore);

			let enriched: NearbyProfile[];

			if (loc.lat && loc.lon) {
				enriched = data
					.filter((p) => p.did !== myDid)
					.map((p) => {
						const c = center(p.geohashCell);
						const dist = distanceMeters(loc.lat!, loc.lon!, c.lat, c.lon);
						const sharedGroups = myGroups
							.filter(g => g.memberDids.has(p.did))
							.map(g => ({ id: g.id, name: g.name }));
						return { ...p, distance: dist, sharedGroups };
					});
			} else {
				enriched = data
					.filter((p) => p.did !== myDid)
					.map((p) => {
						const sharedGroups = myGroups
							.filter(g => g.memberDids.has(p.did))
							.map(g => ({ id: g.id, name: g.name }));
						return { ...p, sharedGroups };
					});
			}

			allProfiles = enriched;
		} catch {
			allProfiles = [];
		} finally {
			loading = false;
		}
	}

	async function openChat(profile: NearbyProfile) {
		if (!profile.boxPublicKey) {
			return;
		}
		try {
			const groupId = await startConversation(profile.did, profile.displayName, profile.boxPublicKey);
			goto(`/chat/${groupId}`);
		} catch (e) {
			console.error('Failed to start conversation:', e);
		}
	}

	// retryLocation is now just enableLocation

	function unreadFrom(did: string): number {
		const convo = $conversationsStore.find(c => c.peerDid === did);
		return convo?.unreadCount ?? 0;
	}

	function formatDistance(meters?: number): string {
		if (!meters) return '';
		if (meters < 250) return '< 250m';
		if (meters < 500) return '< 500m';
		if (meters < 1000) return '< 1km';
		if (meters < 2000) return '~1km';
		if (meters < 5000) return '~' + Math.round(meters / 1000) + 'km';
		if (meters < 50000) return '~' + Math.round(meters / 1000) + 'km';
		return '~' + Math.round(meters / 1000) + 'km';
	}

	type Presence = 'online' | 'idle' | 'away';

	function getPresence(lastSeen: string): Presence {
		if (!lastSeen) return 'away';
		const ms = new Date(lastSeen).getTime();
		if (isNaN(ms)) return 'away';
		const ago = Date.now() - ms;
		if (ago < 5 * 60 * 1000) return 'online';
		if (ago < 60 * 60 * 1000) return 'idle';
		return 'away';
	}

	function getInitials(name: string): string {
		return name.charAt(0).toUpperCase();
	}

	// Decrypted avatar URLs cache (reactive)
	let avatarUrls = $state<Record<string, string | null>>({});

	$effect(() => {
		// Trigger decryption for all profiles with encrypted avatars
		for (const p of allProfiles) {
			if (p.avatarMediaId && p.avatarKey && p.avatarNonce && !(p.avatarMediaId in avatarUrls)) {
				// Mark as loading to avoid re-triggering
				avatarUrls[p.avatarMediaId] = null;
				getDecryptedAvatarUrl(p.avatarMediaId, p.avatarKey, p.avatarNonce).then(url => {
					if (url) {
						avatarUrls = { ...avatarUrls, [p.avatarMediaId!]: url };
					}
				});
			}
		}
	});

	function avatarUrl(profile: NearbyProfile): string | null {
		if (!profile.avatarMediaId) return null;
		if (profile.avatarKey && profile.avatarNonce) {
			// Encrypted avatar — use decrypted URL from cache
			return avatarUrls[profile.avatarMediaId] ?? null;
		}
		// Legacy unencrypted avatar
		return `${BASE}/media/${profile.avatarMediaId}/blob`;
	}

	let showGroups = $state(false);
	let isMapActive = $derived(viewMode === 'map' && hasLoc && !loading && !locationError);

	function setFilter(filterId: string) {
		activeFilter = filterId;
	}

	// Infinite scroll: IntersectionObserver on a sentinel element
	let sentinel: HTMLElement | undefined = $state();

	$effect(() => {
		if (!sentinel) return;
		const observer = new IntersectionObserver((entries) => {
			if (entries[0]?.isIntersecting && hasMore && !loadingMore) {
				loadingMore = true;
				// Small delay so the UI can paint
				setTimeout(() => {
					visibleCount += BATCH_SIZE;
					loadingMore = false;
				}, 100);
			}
		}, { rootMargin: '200px' });
		observer.observe(sentinel);
		return () => observer.disconnect();
	});
</script>

<div class="grid-page" class:map-mode={isMapActive}>
	<div class="grid-toolbar">
		<div class="view-pills">
			<button class="pill" class:active={viewMode === 'grid'} onclick={() => viewMode = 'grid'}>grid</button>
			<button class="pill" class:active={viewMode === 'map'} onclick={() => viewMode = 'map'}>map</button>
		</div>
		{#if activeFilter !== 'all'}
			{@const g = myGroups.find(g => g.id === activeFilter)}
			<button
				class="groups-btn active"
				onclick={() => { setFilter('all'); showGroups = false; }}
			>{g?.name ?? 'group'} ×</button>
		{:else}
			<button
				class="groups-btn"
				class:open={showGroups}
				onclick={() => showGroups = !showGroups}
			>groups +</button>
		{/if}
	</div>

	{#if showGroups && activeFilter === 'all'}
		<div class="groups-dropdown">
			{#each myGroups as group}
				<button
					class="group-option"
					onclick={() => { setFilter(group.id); showGroups = false; }}
				>{group.name}</button>
			{/each}
			{#if myGroups.length === 0}
				<a href="/chat" class="group-option create" onclick={() => showGroups = false}>+ create group</a>
			{/if}
		</div>
	{/if}

	{#if !hasLoc && !loading && !locationError}
		<div class="location-prompt">
			<p class="prompt-title">share your location to see who's&nbsp;nearby.</p>
			<button onclick={enableLocation}>enable location</button>
			<p class="prompt-detail">Your location is approximate. We add nearby areas to prevent exact positioning.</p>
		</div>
	{:else if loading}
		<p class="status">scanning...</p>
	{:else if locationError}
		<div class="empty">
			<p>couldn't access your location</p>
			<p class="prompt-detail">make sure location is enabled in your device and browser settings.</p>
			<button onclick={enableLocation}>try again</button>
		</div>
	{:else if isMapActive}
		{@const loc = $locationStore}
		<div class="map-wrapper">
			{#if loc.lat && loc.lon}
				<ProximityMap
					profiles={profiles}
					userLat={loc.lat}
					userLon={loc.lon}
					{activeFilter}
					groups={myGroups.map(g => ({ id: g.id, name: g.name }))}
				/>
			{/if}
		</div>
	{:else if profiles.length === 0}
		<p class="status">no one nearby right now.</p>
		<p class="privacy-hint">distances are approximate to protect everyone's&nbsp;privacy.</p>
	{:else}
		<div class="photo-grid">
			{#each profiles as profile}
				{@const unread = unreadFrom(profile.did)}
				{@const presence = getPresence(profile.lastSeen)}
				{@const url = avatarUrl(profile)}
				{@const isGroupMember = profile.sharedGroups.length > 0}
				<button
					class="tile"
					class:muted={!isGroupMember && activeFilter === 'all' && myGroups.length > 0}
					onclick={() => openChat(profile)}
				>
					{#if url}
						<img src={url} alt={profile.displayName} class="tile-img" loading="lazy" />
					{:else}
						<div class="tile-placeholder">
							<span class="tile-initial">{getInitials(profile.displayName)}</span>
						</div>
					{/if}

					<!-- Presence dot -->
					<span class="tile-presence {presence}"></span>

					<!-- Unread badge -->
					{#if unread > 0}
						<span class="tile-badge">{unread}</span>
					{/if}

					<!-- Group badges -->
					{#if isGroupMember}
						<div class="group-badges">
							{#each profile.sharedGroups as group}
								<span class="group-badge">{group.name}</span>
							{/each}
						</div>
					{/if}

					<!-- Bottom overlay with name + distance -->
					<div class="tile-overlay">
						<span class="tile-name">
							{profile.displayName}{#if profile.age}, {profile.age}{/if}
						</span>
						{#if profile.distance}
							<span class="tile-dist">{formatDistance(profile.distance)}</span>
						{/if}
					</div>
				</button>
			{/each}
		</div>

		<!-- Infinite scroll sentinel -->
		{#if hasMore}
			<div class="load-more" bind:this={sentinel}>
				<span class="pulse"></span>
			</div>
		{/if}

		<p class="privacy-hint">distances are approximate to protect everyone's&nbsp;privacy.</p>
	{/if}
</div>

<style>
	.grid-page {
		max-width: 600px;
	}
	.grid-page.map-mode {
		display: flex;
		flex-direction: column;
		height: calc(100dvh - var(--nav-height) - var(--safe-bottom) - 24px);
		overflow: hidden;
	}
	.map-wrapper {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		border-radius: var(--radius);
	}

	/* Toolbar */
	.grid-toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 12px;
	}
	.view-pills {
		display: flex;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.pill {
		padding: 10px 16px;
		font-size: 14px;
		border: none;
		border-radius: 0;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		min-height: auto;
	}
	.pill:not(:last-child) {
		border-right: 1px solid var(--border);
	}
	@media (hover: hover) {
		.pill:hover {
			color: var(--text);
			background: transparent;
		}
	}
	.pill.active {
		background: var(--white);
		color: var(--bg);
	}
	.groups-btn {
		margin-left: auto;
		padding: 10px 16px;
		font-size: 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		white-space: nowrap;
		min-height: auto;
	}
	@media (hover: hover) {
		.groups-btn:hover {
			color: var(--text);
			border-color: #444;
		}
	}
	.groups-btn.active {
		background: var(--white);
		color: var(--bg);
		border-color: var(--white);
	}
	.groups-dropdown {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin-bottom: 12px;
		overflow: hidden;
	}
	.group-option {
		padding: 12px 16px;
		font-size: 14px;
		border: none;
		border-radius: 0;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		text-align: left;
		min-height: 48px;
		display: flex;
		align-items: center;
		text-decoration: none;
	}
	.group-option:not(:last-child) {
		border-bottom: 1px solid var(--border);
	}
	@media (hover: hover) {
		.group-option:hover {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
	.group-option.create {
		color: var(--text-muted);
	}

	/* Status / empty states */
	.status {
		color: var(--text-muted);
		text-align: center;
		padding: 48px 0;
		font-size: 14px;
	}
	.empty {
		text-align: center;
		padding: 48px 0;
	}
	.empty p {
		color: var(--text-muted);
		margin-bottom: 16px;
		font-size: 14px;
	}
	.location-prompt {
		max-width: 340px;
		margin: 0 auto;
		padding: 48px 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
	}
	.prompt-title {
		color: var(--text);
		font-size: 16px;
		text-align: center;
		line-height: 1.5;
	}
	.prompt-detail {
		color: var(--text-muted);
		font-size: 12px;
		text-align: center;
		line-height: 1.5;
	}
	.privacy-hint {
		color: var(--text-tertiary);
		font-size: 12px;
		text-align: center;
		margin-top: 16px;
	}

	/* Photo grid */
	.photo-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 2px;
	}
	.tile {
		position: relative;
		aspect-ratio: 3 / 4;
		overflow: hidden;
		border: none;
		border-radius: 0;
		padding: 0;
		cursor: pointer;
		background: var(--bg-surface);
		transition: opacity 0.1s;
		min-height: auto;
	}
	@media (hover: hover) {
		.tile:hover {
			opacity: 0.85;
		}
	}
	.tile.muted {
		opacity: 0.55;
	}
	@media (hover: hover) {
		.tile.muted:hover {
			opacity: 0.45;
		}
	}
	.tile-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.tile-placeholder {
		width: 100%;
		height: 100%;
		background: var(--bg-surface);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.tile-initial {
		font-size: 28px;
		color: var(--text-tertiary);
		font-weight: 300;
	}
	.tile-presence {
		position: absolute;
		top: 6px;
		left: 6px;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		border: 1.5px solid rgba(0, 0, 0, 0.5);
	}
	.tile-presence.online { background: var(--online); }
	.tile-presence.idle { background: var(--idle); }
	.tile-presence.away { background: var(--offline); }
	.tile-badge {
		position: absolute;
		top: 4px;
		right: 4px;
		background: var(--white);
		color: var(--bg);
		font-size: 10px;
		font-weight: 700;
		min-width: 18px;
		height: 18px;
		line-height: 18px;
		text-align: center;
		border-radius: 9px;
		padding: 0 5px;
	}
	.group-badges {
		position: absolute;
		top: 6px;
		right: 6px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		align-items: flex-end;
	}
	.group-badge {
		background: rgba(0, 0, 0, 0.7);
		color: var(--white);
		font-size: 10px;
		padding: 2px 6px;
		border-radius: 1px;
		white-space: nowrap;
		max-width: 80px;
		overflow: hidden;
		text-overflow: ellipsis;
		line-height: 1.3;
	}
	.tile-overlay {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		padding: 28px 8px 8px;
		background: linear-gradient(transparent, rgba(0,0,0,0.85));
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.tile-name {
		color: #fff;
		font-size: 13px;
		font-weight: 500;
		line-height: 1.3;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-shadow: 0 1px 3px rgba(0,0,0,0.9);
	}
	.tile-dist {
		color: rgba(255, 255, 255, 0.6);
		font-size: 12px;
		text-shadow: 0 1px 3px rgba(0,0,0,0.9);
	}
	.load-more {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px 0;
	}
	.load-more .pulse {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--text-muted);
		animation: pulse 1.5s ease-in-out infinite;
	}
	@keyframes pulse {
		0%, 100% { opacity: 0.3; transform: scale(1); }
		50% { opacity: 1; transform: scale(1.5); }
	}
	@media (min-width: 500px) {
		.photo-grid {
			grid-template-columns: repeat(4, 1fr);
		}
	}
</style>
