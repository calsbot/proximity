<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { center as geohashCenter, decode as geohashDecode } from '$lib/geo/geohash';
	import { goto } from '$app/navigation';
	import { startConversation } from '$lib/services/chat';
	import { BASE } from '$lib/api';
	import { getDecryptedAvatarUrl } from '$lib/services/avatar';
	import L from 'leaflet';
	import 'leaflet/dist/leaflet.css';
	import 'leaflet.markercluster';
	import 'leaflet.markercluster/dist/MarkerCluster.css';

	interface MapProfile {
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
		distance?: number;
		lastSeen: string;
		sharedGroups: Array<{ id: string; name: string }>;
	}

	interface GroupInfo {
		id: string;
		name: string;
	}

	interface Props {
		profiles: MapProfile[];
		userLat: number;
		userLon: number;
		activeFilter: string;
		groups: GroupInfo[];
	}

	let { profiles, userLat, userLon, activeFilter, groups }: Props = $props();

	let mapContainer: HTMLDivElement | undefined = $state();
	let map: L.Map | undefined;
	let clusterGroup: L.MarkerClusterGroup | undefined;
	let uncertaintyLayer: L.LayerGroup | undefined;
	let profileMarkers: Array<{
		marker: L.Marker;
		circle: L.Circle;
		lat: number;
		lon: number;
	}> = [];
	let userMarker: L.CircleMarker | undefined;

	const DEFAULT_ZOOM = 16;

	type Presence = 'active' | 'idle' | 'cold';

	function getPresence(lastSeen: string): Presence {
		if (!lastSeen) return 'cold';
		const ms = new Date(lastSeen).getTime();
		if (isNaN(ms)) return 'cold';
		const ago = Date.now() - ms;
		if (ago < 5 * 60_000) return 'active';
		if (ago < 24 * 60 * 60_000) return 'idle';
		return 'cold';
	}

	function presenceColor(p: Presence): string {
		if (p === 'active') return '#5c8a56';
		if (p === 'idle') return '#c49a3a';
		return '#888';
	}

	function presenceOpacity(p: Presence): number {
		if (p === 'active') return 1.0;
		if (p === 'idle') return 0.8;
		return 0.4;
	}

	// Decrypted avatar URLs for map popups
	let decryptedAvatars: Record<string, string> = {};

	function avatarUrl(profile: MapProfile): string | null {
		if (!profile.avatarMediaId) return null;
		if (profile.avatarKey && profile.avatarNonce) {
			return decryptedAvatars[profile.avatarMediaId] ?? null;
		}
		// Legacy unencrypted
		return `${BASE}/media/${profile.avatarMediaId}/blob`;
	}

	function getInitials(name: string): string {
		return name.charAt(0).toUpperCase();
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

	function buildPopupContent(profile: MapProfile): string {
		const presence = getPresence(profile.lastSeen);
		const presColor = presenceColor(presence);
		const avatar = avatarUrl(profile);

		const avatarHtml = avatar
			? `<img src="${avatar}" class="popup-avatar" alt="${profile.displayName}" />`
			: `<div class="popup-avatar popup-avatar-placeholder"><span>${getInitials(profile.displayName)}</span></div>`;

		const ageStr = profile.age ? `, ${profile.age}` : '';
		const distStr = profile.distance ? `<span class="popup-dist">${formatDistance(profile.distance)}</span>` : '';
		const presenceLabel = presence === 'active' ? 'online now' : presence === 'idle' ? 'seen today' : 'inactive';

		let groupBadges = '';
		if (profile.sharedGroups.length > 0) {
			groupBadges = '<div class="popup-groups">' +
				profile.sharedGroups.map(g => `<span class="popup-group-badge">${g.name}</span>`).join('') +
				'</div>';
		}

		const bioHtml = profile.bio ? `<p class="popup-bio">${profile.bio}</p>` : '';

		return `
			<div class="map-popup">
				<div class="popup-header">
					${avatarHtml}
					<div class="popup-info">
						<div class="popup-name">${profile.displayName}${ageStr}</div>
						<div class="popup-presence" style="color:${presColor}">${presenceLabel}</div>
						${distStr}
					</div>
				</div>
				${bioHtml}
				${groupBadges}
				<button class="popup-msg-btn" data-did="${profile.did}">message</button>
			</div>
		`;
	}

	async function handleMessage(profile: MapProfile) {
		if (!profile.boxPublicKey) return;
		try {
			const groupId = await startConversation(profile.did, profile.displayName, profile.boxPublicKey);
			goto(`/chat/${groupId}`);
		} catch (e) {
			console.error('Failed to start conversation:', e);
		}
	}

	/**
	 * Get the uncertainty radius in meters for a geohash cell.
	 */
	function geohashUncertaintyRadius(geohash: string): number {
		const bounds = geohashDecode(geohash);
		const latSpan = bounds.lat.max - bounds.lat.min;
		const lonSpan = bounds.lon.max - bounds.lon.min;
		const latMeters = latSpan * 111_320;
		const midLat = (bounds.lat.min + bounds.lat.max) / 2;
		const lonMeters = lonSpan * 111_320 * Math.cos(midLat * Math.PI / 180);
		return (latMeters + lonMeters) / 4;
	}

	/**
	 * Deterministic hash of a DID string → two floats in [0, 1).
	 * Stable across renders so dots don't jump.
	 */
	function didToJitter(did: string): [number, number] {
		let h1 = 0x9e3779b9;
		let h2 = 0x517cc1b7;
		for (let i = 0; i < did.length; i++) {
			const c = did.charCodeAt(i);
			h1 = Math.imul(h1 ^ c, 0x85ebca6b);
			h1 = (h1 << 13) | (h1 >>> 19);
			h2 = Math.imul(h2 ^ c, 0xc2b2ae35);
			h2 = (h2 << 17) | (h2 >>> 15);
		}
		return [(h1 >>> 0) / 0x100000000, (h2 >>> 0) / 0x100000000];
	}

	/**
	 * Pick tooltip direction to avoid collisions.
	 * Default is 'top'. If another marker is within 60px above,
	 * pick right/left/bottom — whichever side has the fewest nearby markers.
	 */
	function pickTooltipDirection(
		selfPx: L.Point,
		allPx: L.Point[],
		selfIdx: number
	): { direction: 'top' | 'right' | 'bottom' | 'left'; offset: [number, number] } {
		let aboveCollision = false;
		for (let j = 0; j < allPx.length; j++) {
			if (j === selfIdx) continue;
			const dx = allPx[j].x - selfPx.x;
			const dy = allPx[j].y - selfPx.y;
			if (dy < 0 && Math.sqrt(dx * dx + dy * dy) < 60) {
				aboveCollision = true;
				break;
			}
		}

		if (!aboveCollision) {
			return { direction: 'top', offset: [0, -20] };
		}

		const counts = { right: 0, left: 0, bottom: 0 };
		for (let j = 0; j < allPx.length; j++) {
			if (j === selfIdx) continue;
			const dx = allPx[j].x - selfPx.x;
			const dy = allPx[j].y - selfPx.y;
			if (Math.sqrt(dx * dx + dy * dy) > 100) continue;
			if (dx > 0) counts.right++;
			if (dx < 0) counts.left++;
			if (dy > 0) counts.bottom++;
		}

		const options: Array<{ dir: 'right' | 'left' | 'bottom'; count: number; offset: [number, number] }> = [
			{ dir: 'right', count: counts.right, offset: [20, 0] },
			{ dir: 'left', count: counts.left, offset: [-20, 0] },
			{ dir: 'bottom', count: counts.bottom, offset: [0, 20] },
		];
		options.sort((a, b) => a.count - b.count);
		return { direction: options[0].dir, offset: options[0].offset };
	}

	/**
	 * Build a divIcon that looks like a presence-colored circle dot.
	 */
	function makeDotIcon(color: string, opacity: number): L.DivIcon {
		return L.divIcon({
			className: 'map-dot-wrapper',
			html: `<div class="map-dot" style="background:${color}; opacity:${opacity}; border-color:${color}; box-shadow: 0 0 20px 8px ${color};"></div>`,
			iconSize: [12, 12],
			iconAnchor: [6, 6],
		});
	}

	/**
	 * Update tooltip visibility and direction on existing markers.
	 * Show at zoom >= 16, hide at zoom < 16.
	 * Re-runs collision avoidance since pixel positions change with zoom.
	 */
	function updateTooltips() {
		if (!map) return;

		const zoom = map.getZoom();
		const show = zoom >= 16;

		// Build pixel positions for all markers including "you" for collision avoidance
		// Only include profile markers that are currently visible (not inside a cluster)
		const allEntries: Array<{ marker: L.Marker | L.CircleMarker; px: L.Point; isUser: boolean }> = [];

		if (userMarker) {
			allEntries.push({
				marker: userMarker,
				px: map.latLngToLayerPoint(userMarker.getLatLng()),
				isUser: true,
			});
		}

		for (const m of profileMarkers) {
			// Only include markers visible on map (not clustered)
			if (map.hasLayer(m.marker)) {
				allEntries.push({
					marker: m.marker,
					px: map.latLngToLayerPoint([m.lat, m.lon]),
					isUser: false,
				});
			}
		}

		const allPx = allEntries.map(e => e.px);

		// Run collision avoidance on all visible markers (including "you"),
		// but only zoom-toggle visibility on profile markers (not "you")
		for (let i = 0; i < allEntries.length; i++) {
			const { marker, isUser } = allEntries[i];
			const tooltip = marker.getTooltip();
			if (!tooltip) continue;

			let { direction, offset } = pickTooltipDirection(allPx[i], allPx, i);

			// "you" marker uses smaller offset when on top
			if (isUser && direction === 'top') {
				offset = [0, -12];
			}

			tooltip.options.direction = direction;
			tooltip.options.offset = L.point(offset[0], offset[1]);

			if (isUser) {
				// "you" tooltip always visible — just reposition
				userMarker!.closeTooltip();
				userMarker!.openTooltip();
			} else if (show) {
				marker.closeTooltip();
				marker.openTooltip();
			} else {
				marker.closeTooltip();
			}
		}
	}

	function rebuildMarkers() {
		if (!map || !clusterGroup || !uncertaintyLayer) return;

		clusterGroup.clearLayers();
		uncertaintyLayer.clearLayers();
		profileMarkers = [];

		let visible: MapProfile[];
		if (activeFilter === 'all') {
			visible = profiles;
		} else {
			visible = profiles.filter(p => p.sharedGroups.some(g => g.id === activeFilter));
		}

		for (const profile of visible) {
			if (!profile.geohashCell) continue;

			const bounds = geohashDecode(profile.geohashCell);
			const [jx, jy] = didToJitter(profile.did);
			const margin = 0.15;
			const lat = bounds.lat.min + (margin + jy * (1 - 2 * margin)) * (bounds.lat.max - bounds.lat.min);
			const lon = bounds.lon.min + (margin + jx * (1 - 2 * margin)) * (bounds.lon.max - bounds.lon.min);

			const presence = getPresence(profile.lastSeen);
			const color = presenceColor(presence);
			const opacity = presenceOpacity(presence);

			// Uncertainty circle (separate layer, not clustered)
			const uncertaintyM = geohashUncertaintyRadius(profile.geohashCell);
			const circle = L.circle([lat, lon], {
				radius: uncertaintyM,
				fillColor: color,
				fillOpacity: 0.06,
				stroke: false,
				interactive: false,
			}).addTo(uncertaintyLayer);

			// Profile dot marker (using divIcon so it works with MarkerClusterGroup)
			const dot = L.marker([lat, lon], {
				icon: makeDotIcon(color, opacity),
			});

			// Always bind permanent tooltip — visibility controlled by updateTooltips()
			dot.bindTooltip(profile.displayName, {
				permanent: true,
				direction: 'top',
				offset: [0, -20],
				className: 'map-label',
			});

			// Popup with full profile card (works at any zoom)
			dot.bindPopup(buildPopupContent(profile), {
				className: 'map-popup-container',
				maxWidth: 260,
				minWidth: 200,
				closeButton: false,
			});

			dot.on('popupopen', () => {
				setTimeout(() => {
					const btn = document.querySelector('.popup-msg-btn[data-did="' + profile.did + '"]');
					if (btn) {
						btn.addEventListener('click', () => handleMessage(profile));
					}
				}, 10);
			});

			clusterGroup.addLayer(dot);
			profileMarkers.push({ marker: dot, circle, lat, lon });
		}

		// Apply collision avoidance + zoom-based visibility
		updateTooltips();
	}

	function recenter() {
		if (map) {
			map.flyTo([userLat, userLon], DEFAULT_ZOOM, { duration: 0.6 });
		}
	}

	let mounted = false;

	onMount(() => {
		if (!mapContainer) return;

		map = L.map(mapContainer, {
			center: [userLat, userLon],
			zoom: DEFAULT_ZOOM,
			zoomControl: false,
			attributionControl: true,
		});

		L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
			attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
			subdomains: 'abcd',
			maxZoom: 20,
		}).addTo(map);

		L.control.zoom({ position: 'topright' }).addTo(map);

		L.control.scale({
			position: 'bottomleft',
			metric: true,
			imperial: false,
			maxWidth: 120,
		}).addTo(map);

		// Uncertainty circles layer (below everything, not clustered)
		uncertaintyLayer = L.layerGroup().addTo(map);

		// Cluster group for profile markers
		clusterGroup = L.markerClusterGroup({
			zoomToBoundsOnClick: true,
			showCoverageOnHover: false,
			disableClusteringAtZoom: 16,
			maxClusterRadius: 60,
			spiderfyOnMaxZoom: true,
			iconCreateFunction: (cluster: L.MarkerCluster) => {
				const count = cluster.getChildCount();
				const size = count < 10 ? 36 : count < 50 ? 44 : 52;
				return L.divIcon({
					className: 'custom-cluster',
					html: `<div class="cluster-icon" style="width:${size}px; height:${size}px;">
						<div class="cluster-ring cluster-ring-1"></div>
						<div class="cluster-ring cluster-ring-2"></div>
						<div class="cluster-ring cluster-ring-3"></div>
						<span class="cluster-count">${count}</span>
					</div>`,
					iconSize: L.point(size, size),
					iconAnchor: L.point(size / 2, size / 2),
				});
			},
		}).addTo(map);

		// Re-run tooltip logic when clusters animate
		clusterGroup.on('animationend', () => { if (mounted) updateTooltips(); });

		// User marker — sits at default z-index so clusters render on top when zoomed out.
		// When zoomed past clustering threshold (>= 14), clusters dissolve and this is visible.
		userMarker = L.circleMarker([userLat, userLon], {
			radius: 7,
			fillColor: 'transparent',
			fillOpacity: 0,
			stroke: true,
			color: '#ffffff',
			weight: 2,
			opacity: 1,
		}).bindTooltip('you', {
			permanent: true,
			direction: 'top',
			offset: [0, -12],
			className: 'map-label map-label-you',
		}).addTo(map);

		L.circleMarker([userLat, userLon], {
			radius: 2,
			fillColor: '#ffffff',
			fillOpacity: 1,
			stroke: false,
		}).addTo(map);

		map.on('zoomend', () => { if (mounted) updateTooltips(); });

		mounted = true;
		rebuildMarkers();
	});

	// Decrypt avatars for profiles with encrypted photos
	$effect(() => {
		for (const p of profiles) {
			if (p.avatarMediaId && p.avatarKey && p.avatarNonce && !(p.avatarMediaId in decryptedAvatars)) {
				const mediaId = p.avatarMediaId;
				decryptedAvatars[mediaId] = ''; // mark as loading
				getDecryptedAvatarUrl(mediaId, p.avatarKey, p.avatarNonce).then(url => {
					if (url) {
						decryptedAvatars[mediaId] = url;
						// Rebuild markers now that we have the decrypted URL
						if (mounted) rebuildMarkers();
					}
				});
			}
		}
	});

	// React to profile / filter changes
	$effect(() => {
		// Read reactive deps to establish tracking
		const p = profiles;
		const f = activeFilter;
		const g = groups;

		if (mounted) {
			rebuildMarkers();
		}
	});

	onDestroy(() => {
		if (map) {
			map.remove();
			map = undefined;
		}
	});
</script>

<div class="map-outer">
	<div class="map-el" bind:this={mapContainer}></div>
	<button class="recenter-btn" onclick={recenter} title="Recenter">
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
			<circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.5" fill="none"/>
			<line x1="8" y1="0" x2="8" y2="4" stroke="currentColor" stroke-width="1.5"/>
			<line x1="8" y1="12" x2="8" y2="16" stroke="currentColor" stroke-width="1.5"/>
			<line x1="0" y1="8" x2="4" y2="8" stroke="currentColor" stroke-width="1.5"/>
			<line x1="12" y1="8" x2="16" y2="8" stroke="currentColor" stroke-width="1.5"/>
		</svg>
	</button>
</div>

<style>
	.map-outer {
		position: relative;
		width: 100%;
		height: 100%;
	}

	.map-el {
		width: 100%;
		height: 100%;
		background: var(--bg);
	}

	.recenter-btn {
		position: absolute;
		top: 10px;
		left: 10px;
		z-index: 1000;
		width: 36px;
		height: 36px;
		min-height: 36px;
		padding: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(10, 10, 10, 0.9);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text-muted);
		cursor: pointer;
	}
	@media (hover: hover) {
		.recenter-btn:hover {
			color: var(--white);
			border-color: #444;
		}
	}

	/* ========== Leaflet overrides for dark theme ========== */

	:global(.leaflet-container) {
		background: #0a0a0a !important;
		font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
	}

	:global(.leaflet-control-zoom) {
		border: 1px solid #2a2a2a !important;
		border-radius: 2px !important;
		overflow: hidden;
	}
	:global(.leaflet-control-zoom a) {
		background: rgba(10, 10, 10, 0.9) !important;
		color: rgba(255, 255, 255, 0.6) !important;
		border-color: #2a2a2a !important;
		width: 30px !important;
		height: 30px !important;
		line-height: 30px !important;
		font-size: 14px !important;
	}
	:global(.leaflet-control-zoom a:hover) {
		background: #1e1e1e !important;
		color: #fff !important;
	}

	:global(.leaflet-control-attribution) {
		background: rgba(10, 10, 10, 0.7) !important;
		color: rgba(255, 255, 255, 0.3) !important;
		font-size: 8px !important;
		font-family: -apple-system, BlinkMacSystemFont, sans-serif !important;
	}
	:global(.leaflet-control-attribution a) {
		color: rgba(255, 255, 255, 0.4) !important;
	}

	:global(.leaflet-control-scale-line) {
		background: rgba(10, 10, 10, 0.7) !important;
		border-color: rgba(255, 255, 255, 0.2) !important;
		color: rgba(255, 255, 255, 0.4) !important;
		font-family: -apple-system, BlinkMacSystemFont, sans-serif !important;
		font-size: 9px !important;
		padding: 2px 6px !important;
		line-height: 1.4 !important;
	}

	/* ========== Dot markers ========== */

	:global(.map-dot-wrapper) {
		background: transparent !important;
		border: none !important;
	}
	:global(.map-dot) {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		border: 1.5px solid;
	}

	/* ========== Name labels ========== */

	:global(.map-label) {
		background: transparent !important;
		border: none !important;
		box-shadow: none !important;
		color: #aaa !important;
		font-family: -apple-system, BlinkMacSystemFont, sans-serif !important;
		font-size: 10px !important;
		padding: 0 !important;
		white-space: nowrap !important;
	}
	:global(.map-label::before) {
		display: none !important;
	}
	:global(.map-label-you) {
		color: #ffffff !important;
		font-size: 9px !important;
		opacity: 0.8;
	}

	/* ========== Cluster icons ========== */

	@keyframes -global-radar-ping {
		0% {
			transform: scale(1);
			opacity: 0.5;
		}
		100% {
			transform: scale(2.5);
			opacity: 0;
		}
	}

	:global(.custom-cluster) {
		background: transparent !important;
		border: none !important;
	}

	:global(.cluster-icon) {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(10, 10, 10, 0.92);
		border-radius: 50%;
		border: 1px solid rgba(255, 255, 255, 0.3);
	}

	:global(.cluster-ring) {
		position: absolute;
		inset: 0;
		border-radius: 50%;
		border: 1px solid rgba(255, 255, 255, 0.3);
		animation: radar-ping 3s ease-out infinite;
		pointer-events: none;
	}
	:global(.cluster-ring-2) {
		animation-delay: 1s;
	}
	:global(.cluster-ring-3) {
		animation-delay: 2s;
	}

	:global(.cluster-count) {
		position: relative;
		z-index: 1;
		font-family: -apple-system, BlinkMacSystemFont, sans-serif;
		font-size: 12px;
		font-weight: 500;
		color: rgba(255, 255, 255, 0.8);
		letter-spacing: -0.3px;
	}

	/* Override leaflet.markercluster default styles */
	:global(.marker-cluster-small),
	:global(.marker-cluster-medium),
	:global(.marker-cluster-large) {
		background: transparent !important;
	}
	:global(.marker-cluster-small div),
	:global(.marker-cluster-medium div),
	:global(.marker-cluster-large div) {
		background: transparent !important;
	}
	:global(.marker-cluster) {
		background-clip: unset !important;
	}

	/* ========== Popups ========== */

	:global(.map-popup-container .leaflet-popup-content-wrapper) {
		background: rgba(10, 10, 10, 0.96) !important;
		border: 1px solid #2a2a2a !important;
		border-radius: 2px !important;
		color: #e8e8e8 !important;
		box-shadow: none !important;
	}
	:global(.map-popup-container .leaflet-popup-content) {
		margin: 0 !important;
		font-family: -apple-system, BlinkMacSystemFont, sans-serif !important;
		font-size: 13px !important;
	}
	:global(.map-popup-container .leaflet-popup-tip) {
		background: rgba(10, 10, 10, 0.96) !important;
		border: 1px solid #2a2a2a !important;
		box-shadow: none !important;
	}

	:global(.map-popup) {
		padding: 12px;
	}
	:global(.popup-header) {
		display: flex;
		gap: 10px;
		align-items: center;
		margin-bottom: 8px;
	}
	:global(.popup-avatar) {
		width: 44px;
		height: 44px;
		border-radius: 2px;
		object-fit: cover;
		flex-shrink: 0;
	}
	:global(.popup-avatar-placeholder) {
		background: #141414;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #555;
		font-size: 18px;
		font-weight: 300;
	}
	:global(.popup-info) {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	:global(.popup-name) {
		font-size: 14px;
		font-weight: 500;
		color: #e8e8e8;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	:global(.popup-presence) {
		font-size: 9px;
		opacity: 0.8;
	}
	:global(.popup-dist) {
		font-size: 10px;
		color: rgba(255, 255, 255, 0.4);
	}
	:global(.popup-bio) {
		font-size: 11px;
		color: rgba(255, 255, 255, 0.5);
		line-height: 1.4;
		margin: 0 0 8px 0;
		word-break: break-word;
	}
	:global(.popup-groups) {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
		margin-bottom: 8px;
	}
	:global(.popup-group-badge) {
		font-size: 10px;
		color: #e8e8e8;
		border: 1px solid #2a2a2a;
		padding: 1px 6px;
		border-radius: 2px;
	}
	:global(.popup-msg-btn) {
		width: 100%;
		padding: 10px;
		font-size: 13px;
		font-family: -apple-system, BlinkMacSystemFont, sans-serif;
		background: transparent;
		border: 1px solid #2a2a2a;
		border-radius: 2px;
		color: #e8e8e8;
		cursor: pointer;
		min-height: 40px;
		transition: background 0.1s;
	}
	:global(.popup-msg-btn:hover) {
		background: #1e1e1e;
	}
</style>
