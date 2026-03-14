import { writable, derived } from 'svelte/store';
import { encode, generateDecoyCells } from '$lib/geo/geohash';

interface LocationState {
	lat: number | null;
	lon: number | null;
	geohash: string | null;
	queryCells: string[]; // real + decoys, shuffled
	permission: 'prompt' | 'granted' | 'denied';
	precision: number;
}

export const locationStore = writable<LocationState>({
	lat: null,
	lon: null,
	geohash: null,
	queryCells: [],
	permission: 'prompt',
	precision: 6 // ~1.2km cells
});

export const hasLocation = derived(locationStore, ($s) => $s.geohash !== null);

/**
 * Request geolocation and compute geohash + decoy cells.
 * Includes a safety timeout — Chrome may silently block getCurrentPosition
 * (no callback fired) when permission was previously denied or on insecure origins.
 */
export async function requestLocation(precision: number = 6): Promise<void> {
	if (!navigator.geolocation) {
		locationStore.update((s) => ({ ...s, permission: 'denied' }));
		return;
	}

	// Pre-check permission state (avoids silent block in Chrome)
	if (navigator.permissions) {
		try {
			const status = await navigator.permissions.query({ name: 'geolocation' });
			if (status.state === 'denied') {
				locationStore.update((s) => ({ ...s, permission: 'denied' }));
				return;
			}
		} catch {
			// permissions.query not supported — continue to getCurrentPosition
		}
	}

	return new Promise((resolve) => {
		let resolved = false;
		const done = () => { if (!resolved) { resolved = true; resolve(); } };

		// Safety timeout — if getCurrentPosition never fires a callback
		// (can happen when browser extensions like MetaMask interfere with geolocation)
		const safetyTimer = setTimeout(() => {
			locationStore.update((s) => ({ ...s, permission: 'denied' }));
			done();
		}, 12000);

		navigator.geolocation.getCurrentPosition(
			(pos) => {
				clearTimeout(safetyTimer);
				const { latitude, longitude } = pos.coords;
				const hash = encode(latitude, longitude, precision);
				const cells = generateDecoyCells(hash, 11);

				locationStore.set({
					lat: latitude,
					lon: longitude,
					geohash: hash,
					queryCells: cells,
					permission: 'granted',
					precision
				});
				done();
			},
			(err) => {
				clearTimeout(safetyTimer);
				// PERMISSION_DENIED=1, POSITION_UNAVAILABLE=2, TIMEOUT=3
				if (err.code === 1) {
					locationStore.update((s) => ({ ...s, permission: 'denied' }));
					done();
				} else {
					// position unavailable or timeout — retry once without high accuracy
					const retryTimer = setTimeout(() => {
						locationStore.update((s) => ({ ...s, permission: 'denied' }));
						done();
					}, 17000);

					navigator.geolocation.getCurrentPosition(
						(pos) => {
							clearTimeout(retryTimer);
							const { latitude, longitude } = pos.coords;
							const hash = encode(latitude, longitude, precision);
							const cells = generateDecoyCells(hash, 11);
							locationStore.set({
								lat: latitude,
								lon: longitude,
								geohash: hash,
								queryCells: cells,
								permission: 'granted',
								precision
							});
							done();
						},
						() => {
							clearTimeout(retryTimer);
							locationStore.update((s) => ({ ...s, permission: 'denied' }));
							done();
						},
						{ enableHighAccuracy: false, timeout: 15000 }
					);
				}
			},
			{ enableHighAccuracy: true, timeout: 10000 }
		);
	});
}
