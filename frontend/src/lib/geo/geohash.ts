/**
 * Geohash encoding/decoding + decoy cell generation for location privacy.
 *
 * The server never sees the user's real location. The client:
 * 1. Computes their geohash cell
 * 2. Queries the server for profiles in their cell + decoy cells
 * 3. Server can't distinguish real from decoy
 * 4. Client filters locally by actual proximity
 */

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export interface GeohashBounds {
	lat: { min: number; max: number };
	lon: { min: number; max: number };
}

/**
 * Encode latitude/longitude to a geohash string at given precision.
 * Precision 7 = ~150m x 150m cells (good for urban proximity).
 */
export function encode(lat: number, lon: number, precision: number = 7): string {
	let latRange = { min: -90, max: 90 };
	let lonRange = { min: -180, max: 180 };
	let hash = '';
	let isLon = true;
	let bit = 0;
	let ch = 0;

	while (hash.length < precision) {
		if (isLon) {
			const mid = (lonRange.min + lonRange.max) / 2;
			if (lon >= mid) {
				ch |= 1 << (4 - bit);
				lonRange.min = mid;
			} else {
				lonRange.max = mid;
			}
		} else {
			const mid = (latRange.min + latRange.max) / 2;
			if (lat >= mid) {
				ch |= 1 << (4 - bit);
				latRange.min = mid;
			} else {
				latRange.max = mid;
			}
		}
		isLon = !isLon;
		bit++;
		if (bit === 5) {
			hash += BASE32[ch];
			bit = 0;
			ch = 0;
		}
	}
	return hash;
}

/**
 * Decode a geohash to its bounding box.
 */
export function decode(hash: string): GeohashBounds {
	let latRange = { min: -90, max: 90 };
	let lonRange = { min: -180, max: 180 };
	let isLon = true;

	for (const char of hash) {
		const idx = BASE32.indexOf(char);
		if (idx === -1) throw new Error(`Invalid geohash character: ${char}`);
		for (let bit = 4; bit >= 0; bit--) {
			if (isLon) {
				const mid = (lonRange.min + lonRange.max) / 2;
				if (idx & (1 << bit)) {
					lonRange.min = mid;
				} else {
					lonRange.max = mid;
				}
			} else {
				const mid = (latRange.min + latRange.max) / 2;
				if (idx & (1 << bit)) {
					latRange.min = mid;
				} else {
					latRange.max = mid;
				}
			}
			isLon = !isLon;
		}
	}
	return { lat: latRange, lon: lonRange };
}

/**
 * Get the center point of a geohash cell.
 */
export function center(hash: string): { lat: number; lon: number } {
	const bounds = decode(hash);
	return {
		lat: (bounds.lat.min + bounds.lat.max) / 2,
		lon: (bounds.lon.min + bounds.lon.max) / 2
	};
}

/**
 * Get the 8 neighboring geohash cells (N, NE, E, SE, S, SW, W, NW).
 */
export function neighbors(hash: string): string[] {
	const { lat, lon } = center(hash);
	const bounds = decode(hash);
	const latDelta = bounds.lat.max - bounds.lat.min;
	const lonDelta = bounds.lon.max - bounds.lon.min;
	const precision = hash.length;

	const offsets = [
		[latDelta, 0],        // N
		[latDelta, lonDelta], // NE
		[0, lonDelta],        // E
		[-latDelta, lonDelta],// SE
		[-latDelta, 0],       // S
		[-latDelta, -lonDelta],// SW
		[0, -lonDelta],       // W
		[latDelta, -lonDelta] // NW
	];

	return offsets.map(([dLat, dLon]) => encode(lat + dLat, lon + dLon, precision));
}

/**
 * Generate a set of decoy cells to query alongside the real cell.
 * Returns the real cell + `count` decoy cells, shuffled.
 * Decoys are plausible neighbors-of-neighbors (not random global cells).
 */
export function generateDecoyCells(realHash: string, count: number = 11): string[] {
	const precision = realHash.length;
	const candidateSet = new Set<string>();

	// Add direct neighbors
	const directNeighbors = neighbors(realHash);
	for (const n of directNeighbors) {
		candidateSet.add(n);
	}

	// Add neighbors-of-neighbors for a wider pool
	for (const n of directNeighbors) {
		for (const nn of neighbors(n)) {
			candidateSet.add(nn);
		}
	}

	// Remove the real cell from candidates
	candidateSet.delete(realHash);

	// Pick random decoys from candidates
	const candidates = Array.from(candidateSet);
	const decoys: string[] = [];
	const used = new Set<number>();

	while (decoys.length < count && decoys.length < candidates.length) {
		const idx = Math.floor(Math.random() * candidates.length);
		if (!used.has(idx)) {
			used.add(idx);
			decoys.push(candidates[idx]);
		}
	}

	// Combine real + decoys and shuffle
	const allCells = [realHash, ...decoys];
	for (let i = allCells.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[allCells[i], allCells[j]] = [allCells[j], allCells[i]];
	}

	return allCells;
}

/**
 * Haversine distance between two points in meters.
 */
export function distanceMeters(
	lat1: number, lon1: number,
	lat2: number, lon2: number
): number {
	const R = 6371000;
	const dLat = (lat2 - lat1) * (Math.PI / 180);
	const dLon = (lon2 - lon1) * (Math.PI / 180);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
