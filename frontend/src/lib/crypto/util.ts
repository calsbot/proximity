/** Base64 / UTF-8 helpers — replaces tweetnacl-util (avoids CJS import issues). */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeUTF8(arr: Uint8Array): string {
	return decoder.decode(arr);
}

export function decodeUTF8(str: string): Uint8Array {
	return encoder.encode(str);
}

export function encodeBase64(arr: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
	return btoa(binary);
}

export function decodeBase64(str: string): Uint8Array {
	const binary = atob(str);
	const arr = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
	return arr;
}

/**
 * Generate a random hex string (for invite keys).
 */
export function randomHex(bytes: number = 16): string {
	const arr = crypto.getRandomValues(new Uint8Array(bytes));
	return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256 hash a string, returns hex digest.
 */
export async function sha256Hex(input: string): Promise<string> {
	const data = encoder.encode(input);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
