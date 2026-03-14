/**
 * Perceptual hashing for CSAM detection.
 * DCT-based average hash: resize to 32x32 grayscale, compute average, generate hash.
 * Runs on plaintext image BEFORE encryption.
 */

/**
 * Compute a perceptual hash of an image.
 * Uses canvas to resize and grayscale, then average-based hashing.
 * Returns hex string.
 */
export async function computePerceptualHash(imageData: Uint8Array, mimeType: string = 'image/jpeg'): Promise<string> {
	const SIZE = 8; // 8x8 for average hash (64-bit hash)

	// Create image from data
	const blob = new Blob([imageData], { type: mimeType });
	const url = URL.createObjectURL(blob);

	try {
		const img = await loadImage(url);

		// Create canvas and resize to SIZExSIZE
		const canvas = document.createElement('canvas');
		canvas.width = SIZE;
		canvas.height = SIZE;
		const ctx = canvas.getContext('2d')!;

		// Draw resized image
		ctx.drawImage(img, 0, 0, SIZE, SIZE);
		const pixels = ctx.getImageData(0, 0, SIZE, SIZE).data;

		// Convert to grayscale values
		const gray: number[] = [];
		for (let i = 0; i < pixels.length; i += 4) {
			// Luminance formula
			gray.push(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]);
		}

		// Compute average
		const avg = gray.reduce((a, b) => a + b, 0) / gray.length;

		// Generate hash: 1 if above average, 0 if below
		let hash = '';
		for (const val of gray) {
			hash += val >= avg ? '1' : '0';
		}

		// Convert binary string to hex
		let hex = '';
		for (let i = 0; i < hash.length; i += 4) {
			hex += parseInt(hash.slice(i, i + 4), 2).toString(16);
		}

		return hex;
	} finally {
		URL.revokeObjectURL(url);
	}
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = reject;
		img.src = src;
	});
}
