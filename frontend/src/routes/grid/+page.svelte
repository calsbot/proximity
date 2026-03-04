<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { locationStore, hasLocation, requestLocation } from '$lib/stores/location';
	import { identityStore } from '$lib/stores/identity';
	import { distanceMeters, center, neighbors } from '$lib/geo/geohash';
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

	// Check if we already have location from the store
	let hasLoc = $derived($locationStore.geohash !== null);

	// Filtered + sorted profiles based on active filter
	let profiles = $derived.by(() => {
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

		// Fetch groups and profiles in parallel
		try {
			await Promise.all([
				fetchGroups(did),
				fetchProfiles(queryCells)
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
						fetchProfiles(currentLoc.queryCells);
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
					})
					.filter((p) => p.distance! < 5000);
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
		if (meters < 3000) return '~2km';
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
			<p class="prompt-detail">your area is mixed with fake areas. no one can pinpoint you, including&nbsp;us.</p>
		</div>
	{:else if loading}
		<p class="status">scanning...</p>
	{:else if locationError}
		<div class="empty">
			<p>couldn't access your location</p>
			<p class="prompt-detail">make sure location is enabled in your device settings. on iOS, go to Settings &gt; Privacy &gt; Location Services &gt; Chrome</p>
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
						<img src={url} alt={profile.displayName} class="tile-img" />
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
		height: calc(100dvh - 45px - 16px - var(--safe-top, 0px));
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
		padding: 8px 14px;
		font-size: 13px;
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
	.pill:hover {
		color: var(--text);
		background: transparent;
	}
	.pill.active {
		background: var(--text);
		color: var(--bg);
	}
	.groups-btn {
		margin-left: auto;
		padding: 8px 14px;
		font-size: 13px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		white-space: nowrap;
		min-height: auto;
	}
	.groups-btn:hover {
		color: var(--text);
		border-color: #444;
	}
	.groups-btn.active {
		background: var(--text);
		color: var(--bg);
		border-color: var(--text);
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
		font-size: 13px;
		border: none;
		border-radius: 0;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		text-align: left;
		min-height: 44px;
		display: flex;
		align-items: center;
		text-decoration: none;
	}
	.group-option:not(:last-child) {
		border-bottom: 1px solid var(--border);
	}
	.group-option:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.group-option.create {
		color: var(--text-muted);
	}

	/* Status / empty states */
	.status {
		color: var(--text-muted);
		text-align: center;
		padding: 48px 0;
		font-size: 13px;
	}
	.empty {
		text-align: center;
		padding: 48px 0;
	}
	.empty p {
		color: var(--text-muted);
		margin-bottom: 16px;
		font-size: 13px;
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
		font-size: 14px;
		text-align: center;
		line-height: 1.5;
	}
	.prompt-detail {
		color: var(--text-muted);
		font-size: 11px;
		text-align: center;
		line-height: 1.5;
	}
	.privacy-hint {
		color: var(--text-muted);
		font-size: 13px;
		text-align: center;
		opacity: 0.5;
		margin-top: 16px;
	}

	/* Photo grid */
	.photo-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 4px;
	}
	.tile {
		position: relative;
		aspect-ratio: 3 / 4;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0;
		cursor: pointer;
		background: var(--bg);
		transition: opacity 0.15s;
		min-height: auto;
	}
	.tile:hover {
		opacity: 0.85;
	}
	.tile.muted {
		opacity: 0.65;
	}
	.tile.muted:hover {
		opacity: 0.55;
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
		background: #111;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.tile-initial {
		font-size: 28px;
		color: var(--text-muted);
		opacity: 0.3;
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
	.tile-presence.online { background: var(--accent); }
	.tile-presence.idle { background: #ffcc00; }
	.tile-presence.away { background: rgba(255, 255, 255, 0.3); }
	.tile-badge {
		position: absolute;
		top: 4px;
		right: 4px;
		background: var(--accent);
		color: #000;
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
		background: rgba(0, 0, 0, 0.65);
		color: var(--accent);
		font-size: 10px;
		padding: 2px 5px;
		border-radius: 3px;
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
		border-radius: 0 0 var(--radius) var(--radius);
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.tile-name {
		color: #fff;
		font-size: 12px;
		font-weight: 500;
		line-height: 1.3;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-shadow: 0 1px 2px rgba(0,0,0,0.8);
	}
	.tile-dist {
		color: rgba(255, 255, 255, 0.6);
		font-size: 11px;
		text-shadow: 0 1px 2px rgba(0,0,0,0.8);
	}
	@media (min-width: 500px) {
		.photo-grid {
			grid-template-columns: repeat(4, 1fr);
		}
	}
</style>
