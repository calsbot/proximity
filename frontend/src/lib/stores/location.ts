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
	precision: 7 // ~150m cells
});

export const hasLocation = derived(locationStore, ($s) => $s.geohash !== null);

/**
 * Request geolocation and compute geohash + decoy cells.
 */
export async function requestLocation(precision: number = 7): Promise<void> {
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
			() => {
				locationStore.update((s) => ({ ...s, permission: 'denied' }));
				resolve();
			},
			{ enableHighAccuracy: true, timeout: 10000 }
		);
	});
}
