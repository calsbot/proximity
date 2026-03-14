<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { locationStore, hasLocation, requestLocation } from '$lib/stores/location';
	import { identityStore } from '$lib/stores/identity';
	import { distanceMeters, center, neighbors, encode, generateDecoyCells } from '$lib/geo/geohash';
	import { discoverProfiles, updateProfile, listGroups, getDMInvitations, listPendingInvites, BASE } from '$lib/api';
	import { getConversationId, initChat } from '$lib/services/chat';
	import { conversationsStore } from '$lib/stores/conversations';
	import { requestCountStore } from '$lib/stores/requestCount';
	import { getDecryptedAvatarUrl } from '$lib/services/avatar';
	import { formatDistance } from '$lib/utils/distance';
	import { decryptProfileFields } from '$lib/crypto/profile';
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
		tags: string[];
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
	// Filter state
	let tagInput = $state('');
	let committedTags = $state<Set<string>>(new Set());
	let selectedGroups = $state<Set<string>>(new Set());
	let showFilter = $state(false);
	// Server pagination
	let serverTotal = $state(0);
	let serverOffset = $state(0);
	const SERVER_PAGE_SIZE = 50;
	let fetchingMore = $state(false);
	let currentCells = $state<string[]>([]);

	// Pending request sender DIDs (for grid badge)
	let requestSenderDids = $state<Set<string>>(new Set());

	let myDid = $derived($identityStore.identity?.did);
	let loaded = $state(false);

	// Infinite scroll state
	const BATCH_SIZE = 18; // 6 rows of 3
	let visibleCount = $state(BATCH_SIZE);
	let gridContainer: HTMLElement | undefined = $state();
	let loadingMore = $state(false);

	// Check if we already have location from the store
	let hasLoc = $derived($locationStore.geohash !== null);

	// Collect all tags with frequency counts for suggestions
	let tagCounts = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const p of allProfiles) {
			if (p.tags) {
				for (const t of p.tags) {
					const lower = t.toLowerCase();
					counts.set(lower, (counts.get(lower) ?? 0) + 1);
				}
			}
		}
		return counts;
	});

	// Tag suggestions: filtered by current input, sorted by frequency, excluding already committed
	let tagSuggestions = $derived.by(() => {
		const q = tagInput.trim().toLowerCase();
		let entries = Array.from(tagCounts.entries())
			.filter(([tag]) => !committedTags.has(tag));
		if (q) {
			entries = entries.filter(([tag]) => tag.includes(q));
		}
		return entries
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8)
			.map(([tag, count]) => ({ tag, count }));
	});

	function commitTag(tag: string) {
		const t = tag.trim().toLowerCase();
		if (!t) return;
		const next = new Set(committedTags);
		next.add(t);
		committedTags = next;
		tagInput = '';
	}

	function removeTag(tag: string) {
		const next = new Set(committedTags);
		next.delete(tag);
		committedTags = next;
	}

	function handleTagKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			commitTag(tagInput);
		}
		if (e.key === 'Backspace' && tagInput === '' && committedTags.size > 0) {
			// Remove the last committed tag on backspace when input is empty
			const tags = Array.from(committedTags);
			removeTag(tags[tags.length - 1]);
		}
	}

	// Filtered + sorted profiles based on active filters
	let sortedProfiles = $derived.by(() => {
		let list = allProfiles;
		// Tag filter — match ALL committed tags
		if (committedTags.size > 0) {
			list = list.filter(p => {
				if (!p.tags) return false;
				const pTags = p.tags.map(t => t.toLowerCase());
				return Array.from(committedTags).every(ct => pTags.some(pt => pt.includes(ct)));
			});
		}
		// Group filter (OR: in any selected group)
		if (selectedGroups.size > 0) {
			list = list.filter(p => p.sharedGroups.some(g => selectedGroups.has(g.id)));
		}
		return [...list].sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
	});

	let activeFilterCount = $derived(
		committedTags.size + selectedGroups.size
	);

	// Only show visibleCount profiles (for infinite scroll)
	let profiles = $derived(sortedProfiles.slice(0, visibleCount));
	let hasMore = $derived(visibleCount < sortedProfiles.length || serverOffset < serverTotal);

	// Reset visible count when filter changes
	$effect(() => {
		committedTags;
		selectedGroups;
		visibleCount = BATCH_SIZE;
	});

	$effect(() => {
		const did = myDid;
		if (!did || loaded) return;
		loaded = true;

		// Fire-and-forget chat init
		initChat().catch(() => {});

		// Fetch pending requests for grid badges
		fetchRequests(did);

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
						fetchRequests(d);
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

	async function fetchRequests(did: string) {
		try {
			const [dmInvs, groupInvs] = await Promise.all([
				getDMInvitations(did),
				listPendingInvites(did),
			]);
			const senders = new Set<string>();
			for (const inv of dmInvs) senders.add(inv.senderDid);
			for (const inv of groupInvs) senders.add(inv.inviterDid);
			requestSenderDids = senders;
			requestCountStore.set(dmInvs.length + groupInvs.length);
		} catch {}
	}

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

	function enrichProfiles(data: any[]): NearbyProfile[] {
		const loc = get(locationStore);
		const decryptedData = data.filter(p => p.did !== myDid).map(p => {
			let decryptedBio = p.bio;
			let decryptedAge = p.age;
			let decryptedTags: string[] = p.tags ?? [];

			if (p.encryptedFields && p.encryptedFieldsNonce && p.profileKey) {
				try {
					const fields = decryptProfileFields(p.encryptedFields, p.encryptedFieldsNonce, p.profileKey);
					decryptedBio = fields.bio ?? '';
					decryptedAge = fields.age;
					decryptedTags = fields.tags ?? [];
				} catch {}
			}

			return { ...p, bio: decryptedBio, age: decryptedAge, tags: decryptedTags };
		});

		if (loc.lat && loc.lon) {
			return decryptedData.map((p) => {
				const c = center(p.geohashCell);
				const dist = distanceMeters(loc.lat!, loc.lon!, c.lat, c.lon);
				const sharedGroups = myGroups
					.filter(g => g.memberDids.has(p.did))
					.map(g => ({ id: g.id, name: g.name }));
				return { ...p, distance: dist, sharedGroups };
			});
		} else {
			return decryptedData.map((p) => {
				const sharedGroups = myGroups
					.filter(g => g.memberDids.has(p.did))
					.map(g => ({ id: g.id, name: g.name }));
				return { ...p, sharedGroups };
			});
		}
	}

	async function fetchProfiles(cells: string[]) {
		try {
			currentCells = cells;
			const resp = await discoverProfiles(cells, myDid ?? undefined, SERVER_PAGE_SIZE, 0);
			serverTotal = resp.total;
			serverOffset = resp.profiles.length;
			allProfiles = enrichProfiles(resp.profiles);
		} catch {
			allProfiles = [];
		} finally {
			loading = false;
		}
	}

	async function fetchMoreProfiles() {
		if (fetchingMore || serverOffset >= serverTotal || !currentCells.length) return;
		fetchingMore = true;
		try {
			const existingDids = new Set(allProfiles.map(p => p.did));
			const resp = await discoverProfiles(currentCells, myDid ?? undefined, SERVER_PAGE_SIZE, serverOffset);
			serverOffset += resp.profiles.length;
			const newProfiles = enrichProfiles(resp.profiles).filter(p => !existingDids.has(p.did));
			allProfiles = [...allProfiles, ...newProfiles];
		} catch {} finally {
			fetchingMore = false;
		}
	}

	async function openChat(profile: NearbyProfile) {
		if (!profile.boxPublicKey) {
			return;
		}
		try {
			const groupId = await getConversationId(profile.did, profile.boxPublicKey);
			const params = new URLSearchParams({
				peerDid: profile.did,
				peerName: profile.displayName,
				peerKey: profile.boxPublicKey,
				from: 'grid'
			});
			goto(`/chat/${groupId}?${params}`);
		} catch (e) {
			console.error('Failed to open chat:', e);
		}
	}

	// retryLocation is now just enableLocation

	function unreadFrom(did: string): number {
		const convo = $conversationsStore.find(c => c.peerDid === did);
		return convo?.unreadCount ?? 0;
	}

	function hasRequest(did: string): boolean {
		return requestSenderDids.has(did);
	}

	type Presence = 'online' | 'idle' | 'away';

	function getPresence(lastSeen: string): Presence {
		if (!lastSeen) return 'away';
		const ms = new Date(lastSeen).getTime();
		if (isNaN(ms)) return 'away';
		const ago = Date.now() - ms;
		if (ago < 30 * 60 * 1000) return 'online';
		if (ago < 3 * 60 * 60 * 1000) return 'idle';
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

	let isMapActive = $derived(viewMode === 'map' && hasLoc && !loading && !locationError);

	// Map viewport change — fetch profiles for the visible area
	async function handleMapViewportChange(bounds: { north: number; south: number; east: number; west: number }) {
		if (fetchingMore) return;
		// Encode corners to geohash cells at precision 5 (~5km) to cover the viewport
		const centerLat = (bounds.north + bounds.south) / 2;
		const centerLon = (bounds.east + bounds.west) / 2;
		const viewCells = new Set<string>();
		// Sample grid of points across the viewport
		for (const lat of [bounds.north, centerLat, bounds.south]) {
			for (const lon of [bounds.west, centerLon, bounds.east]) {
				const h5 = encode(lat, lon, 5);
				viewCells.add(h5);
				for (const n of neighbors(h5)) viewCells.add(n);
			}
		}
		// Merge with current cells and fetch if we have new cells
		const newCells = Array.from(viewCells).filter(c => !currentCells.includes(c));
		if (newCells.length === 0) return;
		// Add new cells to current set
		currentCells = [...currentCells, ...newCells];
		// Fetch with full cell set from offset 0 (server will return new matches)
		fetchingMore = true;
		try {
			const existingDids = new Set(allProfiles.map(p => p.did));
			const resp = await discoverProfiles(currentCells, myDid ?? undefined, SERVER_PAGE_SIZE, 0);
			serverTotal = resp.total;
			const newProfiles = enrichProfiles(resp.profiles).filter(p => !existingDids.has(p.did));
			if (newProfiles.length > 0) {
				allProfiles = [...allProfiles, ...newProfiles];
			}
		} catch {} finally {
			fetchingMore = false;
		}
	}

	// Infinite scroll: IntersectionObserver on a sentinel element
	let sentinel: HTMLElement | undefined = $state();

	$effect(() => {
		if (!sentinel) return;
		const observer = new IntersectionObserver((entries) => {
			if (entries[0]?.isIntersecting && hasMore && !loadingMore) {
				loadingMore = true;
				setTimeout(() => {
					visibleCount += BATCH_SIZE;
					// If we've shown all locally loaded profiles but server has more, fetch next page
					if (visibleCount >= allProfiles.length && serverOffset < serverTotal) {
						fetchMoreProfiles();
					}
					loadingMore = false;
				}, 100);
			}
		}, { rootMargin: '200px' });
		observer.observe(sentinel);
		return () => observer.disconnect();
	});
</script>

<div class="grid-page" class:map-mode={isMapActive}>
	<div class="page-container grid-container">
		<div class="grid-top">
			<!-- Tab bar: grid/map toggle + filter -->
			<div class="tab-bar grid-tabs">
				<button class="tab" class:active={viewMode === 'grid'} onclick={() => { viewMode = 'grid'; showFilter = false; }}>grid</button>
				<button class="tab" class:active={viewMode === 'map'} onclick={() => { viewMode = 'map'; showFilter = false; }}>map</button>
				<button class="tab" class:active={showFilter} onclick={() => showFilter = !showFilter}>
					filter{#if activeFilterCount > 0}&nbsp;({activeFilterCount}){/if}
				</button>
			</div>

			{#if showFilter}
				<div class="filter-dropdown">
					{#if committedTags.size > 0}
						<div class="tags-row">
							{#each Array.from(committedTags) as tag}
								<button class="tag-pill active" onclick={() => removeTag(tag)}>{tag} ×</button>
							{/each}
						</div>
					{/if}
					<input
						type="text"
						class="filter-search"
						placeholder={committedTags.size > 0 ? 'add another tag...' : 'search tags...'}
						bind:value={tagInput}
						onkeydown={handleTagKeydown}
					/>
					{#if tagSuggestions.length > 0}
						<div class="tags-row">
							{#each tagSuggestions as { tag }}
								<button
									class="tag-pill"
									class:active={committedTags.has(tag)}
									onclick={() => committedTags.has(tag) ? removeTag(tag) : commitTag(tag)}
								>{tag}</button>
							{/each}
						</div>
					{/if}
					{#if myGroups.length > 0}
						<div class="groups-section">
							<span class="groups-label">groups</span>
							{#each myGroups as group}
								<button
									class="group-row"
									class:selected={selectedGroups.has(group.id)}
									onclick={() => {
										const next = new Set(selectedGroups);
										if (next.has(group.id)) next.delete(group.id);
										else next.add(group.id);
										selectedGroups = next;
									}}
								>{group.name}</button>
							{/each}
						</div>
					{:else}
						<div class="groups-section">
							<a href="/chat" class="group-row create">+ create group</a>
						</div>
					{/if}
					{#if activeFilterCount > 0}
						<button class="filter-clear" onclick={() => { committedTags = new Set(); tagInput = ''; selectedGroups = new Set(); }}>clear filters</button>
					{/if}
				</div>
			{/if}
		</div>

		{#if !hasLoc && !loading && !locationError}
			<div class="location-prompt">
				<p class="prompt-title">share your location to see who's&nbsp;nearby</p>
				<button onclick={enableLocation}>enable location</button>
				<p class="prompt-detail">nearby areas are added to prevent exact positioning</p>
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
						profiles={sortedProfiles}
						userLat={loc.lat}
						userLon={loc.lon}
						activeFilter={'all'}
						groups={myGroups.map(g => ({ id: g.id, name: g.name }))}
						onViewportChange={handleMapViewportChange}
					/>
				{/if}
			</div>
		{:else if profiles.length === 0}
			<p class="status">no one nearby right now.</p>
		{:else}
			<div class="photo-grid">
				{#each profiles as profile}
					{@const unread = unreadFrom(profile.did)}
					{@const hasReq = hasRequest(profile.did)}
					{@const presence = getPresence(profile.lastSeen)}
					{@const url = avatarUrl(profile)}
					{@const dist = formatDistance(profile.distance)}
					<button class="cell" onclick={() => openChat(profile)}>
						<div class="cell-img {presence}">
							{#if url}
								<img src={url} alt={profile.displayName} loading="lazy" />
							{:else}
								<svg viewBox="0 0 3 4" xmlns="http://www.w3.org/2000/svg" class="cell-spacer"></svg>
								<div class="cell-placeholder">
									<span class="cell-initial">{getInitials(profile.displayName)}</span>
								</div>
							{/if}
							{#if unread > 0}
								<span class="cell-badge">{unread}</span>
							{:else if hasReq}
								<span class="cell-badge request-badge">!</span>
							{/if}
						</div>
						<div class="cell-label">
							<span class="cell-name">{profile.displayName}</span>
							{#if dist}<span class="cell-dist">{dist}</span>{/if}
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
		{/if}
	</div>

</div>

<style>
	.grid-page {
		max-width: 600px;
	}
	.grid-page.map-mode {
		display: flex;
		flex-direction: column;
		height: calc(100dvh - max(12px, var(--safe-top)) - var(--nav-height) - var(--safe-bottom));
		margin-bottom: -24px; /* eat main padding-bottom (16px) + app nav gap (8px) */
		overflow: hidden;
	}
	.grid-page.map-mode .grid-container {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.grid-page.map-mode .grid-top {
		flex-shrink: 0;
		padding-top: 0;
		margin-top: 0;
	}
	.grid-container {
		overflow: visible !important;
		border: none;
		border-radius: 0;
	}
	.grid-top {
		position: sticky;
		top: 0;
		z-index: 20;
		background: var(--bg);
		padding-top: max(12px, var(--safe-top));
		margin-top: calc(-1 * max(12px, var(--safe-top)));
	}
	.grid-tabs {
		border: 1px solid var(--border);
	}
	.grid-tabs .tab {
		min-height: calc(48px - 1px);
	}
	.map-wrapper {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	/* Filter dropdown */
	.filter-dropdown {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 16px;
		border: 1px solid var(--border);
		border-top: none;
		z-index: 2;
	}
	.filter-search {
		width: 100%;
		padding: 10px 12px;
		font-size: 13px;
		border: 1px solid var(--border);
		border-radius: 0;
		background: transparent;
		color: var(--text);
		outline: none;
		box-sizing: border-box;
	}
	.filter-search::placeholder {
		color: var(--text-tertiary);
	}
	.tags-row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.tag-pill {
		padding: 4px 10px;
		font-size: 12px;
		border: 1px solid var(--border);
		border-radius: 0;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.tag-pill.active {
		color: var(--text);
		border-color: var(--text-muted);
		background: var(--bg-hover);
	}
	@media (hover: hover) {
		.tag-pill:hover {
			color: var(--text);
			border-color: var(--text-muted);
		}
	}
	.groups-section {
		border-top: 1px solid var(--border);
		padding-top: 12px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.groups-label {
		color: var(--text-tertiary);
		font-size: 11px;
		margin-bottom: 4px;
	}
	.group-row {
		padding: 8px 0;
		font-size: 13px;
		border: none;
		border-bottom: 1px solid var(--bg-hover);
		border-radius: 0;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		text-align: left;
		text-decoration: none;
		display: block;
	}
	.group-row.selected {
		color: var(--text);
	}
	@media (hover: hover) {
		.group-row:hover {
			color: var(--text);
		}
	}
	.group-row.create {
		color: var(--text-muted);
	}
	.filter-clear {
		align-self: flex-end;
		padding: 0;
		font-size: 12px;
		border: none;
		border-radius: 0;
		background: transparent;
		color: var(--text-tertiary);
		cursor: pointer;
	}
	@media (hover: hover) {
		.filter-clear:hover {
			color: var(--text);
		}
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

	/* Photo grid — Are.na style */
	.photo-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 10px;
		padding-top: 10px;
	}
	.cell {
		display: flex;
		flex-direction: column;
		border: none;
		border-radius: 0;
		padding: 0;
		cursor: pointer;
		background: transparent;
		text-align: left;
		min-height: auto;
		min-width: 0;
	}
	@media (hover: hover) {
		.cell:hover {
			opacity: 0.85;
		}
	}
	.cell-img {
		position: relative;
		overflow: hidden;
		background: var(--bg-surface);
	}
	.cell-img img {
		width: 100%;
		height: auto;
		aspect-ratio: 3 / 4;
		object-fit: cover;
		display: block;
	}
	.cell-spacer {
		width: 100%;
		display: block;
	}
	.cell-img.online { border-bottom: 1px solid var(--online); }
	.cell-placeholder {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.cell-initial {
		font-size: 28px;
		color: var(--text-tertiary);
		font-weight: 300;
	}
	.cell-label {
		padding: 6px 0 0;
		display: flex;
		align-items: baseline;
		gap: 4px;
		min-width: 0;
	}
	.cell-name {
		font-size: 12px;
		font-family: var(--font-mono);
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.cell-dist {
		font-size: 11px;
		color: var(--text-tertiary);
		white-space: nowrap;
		flex-shrink: 0;
	}
	.cell-badge {
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
		padding: 0 5px;
	}
	.request-badge {
		background: var(--text-muted);
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
