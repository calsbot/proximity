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
 */
export async function requestLocation(precision: number = 6): Promise<void> {
	if (!navigator.geolocation) {
		locationStore.update((s) => ({ ...s, permission: 'denied' }));
		return;
	}

	return new Promise((resolve) => {
		navigator.geolocation.getCurrentPosition(
			(pos) => {
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
				resolve();
			},
			(err) => {
				// PERMISSION_DENIED=1, POSITION_UNAVAILABLE=2, TIMEOUT=3
				if (err.code === 1) {
					locationStore.update((s) => ({ ...s, permission: 'denied' }));
				} else {
					// position unavailable or timeout — retry once without high accuracy
					navigator.geolocation.getCurrentPosition(
						(pos) => {
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
							resolve();
						},
						() => {
							locationStore.update((s) => ({ ...s, permission: 'denied' }));
							resolve();
						},
						{ enableHighAccuracy: false, timeout: 15000 }
					);
					return;
				}
				resolve();
			},
			{ enableHighAccuracy: true, timeout: 10000 }
		);
	});
}
