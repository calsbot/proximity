/**
 * Comprehensive E2E test for the proximity app.
 * Tests: registration, profile discovery, messaging, WebSocket relay,
 *        sender keys, sealed sender, DM invitations, groups, moderation.
 * Run with: bun run test-e2e.ts
 */
import nacl from 'tweetnacl';

const BASE = 'http://localhost:3000';

// --- Helpers ---

function encodeBase64(arr: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
	return btoa(binary);
}

function decodeBase64(str: string): Uint8Array {
	const binary = atob(str);
	const arr = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
	return arr;
}

function encodeUTF8(arr: Uint8Array): string {
	return new TextDecoder().decode(arr);
}

function decodeUTF8(str: string): Uint8Array {
	return new TextEncoder().encode(str);
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58btcEncode(bytes: Uint8Array): string {
	const digits = [0];
	for (const byte of bytes) {
		let carry = byte;
		for (let j = 0; j < digits.length; j++) {
			carry += digits[j] << 8;
			digits[j] = carry % 58;
			carry = (carry / 58) | 0;
		}
		while (carry > 0) {
			digits.push(carry % 58);
			carry = (carry / 58) | 0;
		}
	}
	let str = '';
	for (let i = 0; i < bytes.length && bytes[i] === 0; i++) str += '1';
	for (let i = digits.length - 1; i >= 0; i--) str += BASE58_ALPHABET[digits[i]];
	return str;
}

function publicKeyToDid(publicKey: Uint8Array): string {
	const multicodec = new Uint8Array([0xed, 0x01, ...publicKey]);
	return `did:key:z${base58btcEncode(multicodec)}`;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const cryptoKey = await crypto.subtle.importKey(
		'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', cryptoKey, data);
	return new Uint8Array(sig);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
	const hash = await crypto.subtle.digest('SHA-256', data);
	return new Uint8Array(hash);
}

function hexEncode(bytes: Uint8Array): string {
	return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(str: string): Promise<string> {
	const data = new TextEncoder().encode(str);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return hexEncode(new Uint8Array(hash));
}

// --- Sender Keys helpers (mirrors frontend/src/lib/crypto/group.ts) ---

function generateSenderKey(): string {
	const key = nacl.randomBytes(nacl.secretbox.keyLength);
	return encodeBase64(key);
}

function wrapSenderKeyForMembers(
	senderKeyB64: string,
	myBoxSecretKey: Uint8Array,
	members: Array<{ did: string; boxPublicKey: string }>,
	deliveryToken?: string
): Array<{ memberDid: string; wrappedKey: string; wrappedKeyNonce: string }> {
	const payload = deliveryToken ? `${senderKeyB64}:${deliveryToken}` : senderKeyB64;
	const payloadBytes = decodeUTF8(payload);
	const results: Array<{ memberDid: string; wrappedKey: string; wrappedKeyNonce: string }> = [];

	for (const m of members) {
		if (!m.boxPublicKey) continue;
		const recipientPub = decodeBase64(m.boxPublicKey);
		const nonce = nacl.randomBytes(nacl.box.nonceLength);
		const encrypted = nacl.box(payloadBytes, nonce, recipientPub, myBoxSecretKey);
		results.push({
			memberDid: m.did,
			wrappedKey: encodeBase64(encrypted),
			wrappedKeyNonce: encodeBase64(nonce),
		});
	}
	return results;
}

function unwrapSenderKey(
	wrappedKey: string,
	nonce: string,
	senderBoxPublicKey: Uint8Array,
	myBoxSecretKey: Uint8Array
): { senderKey: string; deliveryToken?: string } {
	const encrypted = decodeBase64(wrappedKey);
	const nonceBytes = decodeBase64(nonce);
	const decrypted = nacl.box.open(encrypted, nonceBytes, senderBoxPublicKey, myBoxSecretKey);
	if (!decrypted) throw new Error('Failed to unwrap sender key');
	const payload = encodeUTF8(decrypted);
	const parts = payload.split(':');
	if (parts.length >= 2) {
		return { senderKey: parts[0], deliveryToken: parts.slice(1).join(':') };
	}
	return { senderKey: payload };
}

function encryptGroupMessage(plaintext: string, senderKeyB64: string): { ciphertext: string; nonce: string } {
	const key = decodeBase64(senderKeyB64);
	const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
	const messageBytes = decodeUTF8(plaintext);
	const encrypted = nacl.secretbox(messageBytes, nonce, key);
	return { ciphertext: encodeBase64(encrypted), nonce: encodeBase64(nonce) };
}

function decryptGroupMessage(ciphertextB64: string, nonceB64: string, senderKeyB64: string): string {
	const key = decodeBase64(senderKeyB64);
	const nonce = decodeBase64(nonceB64);
	const ciphertext = decodeBase64(ciphertextB64);
	const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
	if (!decrypted) throw new Error('Group message decryption failed');
	return encodeUTF8(decrypted);
}

// --- Geohash ---

const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function geohashEncode(lat: number, lon: number, precision: number = 7): string {
	let latRange = { min: -90, max: 90 };
	let lonRange = { min: -180, max: 180 };
	let hash = '';
	let isLon = true;
	let bit = 0;
	let ch = 0;

	while (hash.length < precision) {
		if (isLon) {
			const mid = (lonRange.min + lonRange.max) / 2;
			if (lon >= mid) { ch |= 1 << (4 - bit); lonRange.min = mid; } else { lonRange.max = mid; }
		} else {
			const mid = (latRange.min + latRange.max) / 2;
			if (lat >= mid) { ch |= 1 << (4 - bit); latRange.min = mid; } else { latRange.max = mid; }
		}
		isLon = !isLon;
		bit++;
		if (bit === 5) { hash += GEOHASH_BASE32[ch]; bit = 0; ch = 0; }
	}
	return hash;
}

function geohashNeighbors(hash: string): string[] {
	const bounds = geohashDecode(hash);
	const lat = (bounds.lat.min + bounds.lat.max) / 2;
	const lon = (bounds.lon.min + bounds.lon.max) / 2;
	const latDelta = bounds.lat.max - bounds.lat.min;
	const lonDelta = bounds.lon.max - bounds.lon.min;
	const offsets = [
		[latDelta, 0], [latDelta, lonDelta], [0, lonDelta], [-latDelta, lonDelta],
		[-latDelta, 0], [-latDelta, -lonDelta], [0, -lonDelta], [latDelta, -lonDelta]
	];
	return offsets.map(([dLat, dLon]) => geohashEncode(lat + dLat, lon + dLon, hash.length));
}

function geohashDecode(hash: string) {
	let latRange = { min: -90, max: 90 };
	let lonRange = { min: -180, max: 180 };
	let isLon = true;
	for (const char of hash) {
		const idx = GEOHASH_BASE32.indexOf(char);
		for (let bit = 4; bit >= 0; bit--) {
			if (isLon) {
				const mid = (lonRange.min + lonRange.max) / 2;
				if (idx & (1 << bit)) lonRange.min = mid; else lonRange.max = mid;
			} else {
				const mid = (latRange.min + latRange.max) / 2;
				if (idx & (1 << bit)) latRange.min = mid; else latRange.max = mid;
			}
			isLon = !isLon;
		}
	}
	return { lat: latRange, lon: lonRange };
}

// --- API helpers ---

async function api(path: string, opts: RequestInit = {}) {
	const res = await fetch(`${BASE}${path}`, {
		headers: { 'Content-Type': 'application/json', ...opts.headers as Record<string, string> },
		...opts
	});
	const body = await res.json();
	return { status: res.status, body };
}

async function apiForm(path: string, formData: FormData) {
	const res = await fetch(`${BASE}${path}`, { method: 'POST', body: formData });
	const body = await res.json();
	return { status: res.status, body };
}

// --- Test ---

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  ✓ ${msg}`);
		passed++;
	} else {
		console.log(`  ✗ ${msg}`);
		failed++;
	}
}

function section(num: number, title: string) {
	console.log(`\n${num}. ${title}`);
}

interface User {
	sign: nacl.SignKeyPair;
	box: nacl.BoxKeyPair;
	did: string;
	name: string;
}

function createUser(name: string): User {
	const sign = nacl.sign.keyPair();
	const box = nacl.box.keyPair();
	return { sign, box, did: publicKeyToDid(sign.publicKey), name };
}

async function registerUser(user: User): Promise<void> {
	await api('/auth/register', {
		method: 'POST',
		body: JSON.stringify({
			did: user.did,
			displayName: user.name,
			publicKey: encodeBase64(user.sign.publicKey),
			boxPublicKey: encodeBase64(user.box.publicKey),
		})
	});
}

async function main() {
	console.log('\n=== E2E Test Suite ===\n');

	// ==========================================================================
	// 1. Health check
	// ==========================================================================
	section(1, 'Server health check');
	{
		const { status, body } = await api('/');
		assert(status === 200, `Health check returned ${status}`);
		assert(body.status === 'ok', `Server status: ${body.status}`);
	}

	// ==========================================================================
	// 2. Generate identities
	// ==========================================================================
	section(2, 'Generate identities');
	const userA = createUser('Alice');
	const userB = createUser('Bob');
	const userC = createUser('Charlie');

	assert(userA.did.startsWith('did:key:z6Mk'), `Alice DID: ${userA.did.slice(0, 30)}...`);
	assert(userB.did.startsWith('did:key:z6Mk'), `Bob DID: ${userB.did.slice(0, 30)}...`);
	assert(userC.did.startsWith('did:key:z6Mk'), `Charlie DID: ${userC.did.slice(0, 30)}...`);
	assert(userA.did !== userB.did && userB.did !== userC.did, 'DIDs are unique');

	// ==========================================================================
	// 3. Register users
	// ==========================================================================
	section(3, 'Register users');
	{
		const { status: a } = await api('/auth/register', {
			method: 'POST',
			body: JSON.stringify({ did: userA.did, displayName: userA.name, publicKey: encodeBase64(userA.sign.publicKey), boxPublicKey: encodeBase64(userA.box.publicKey) })
		});
		assert(a === 200, 'Alice registered');

		const { status: b } = await api('/auth/register', {
			method: 'POST',
			body: JSON.stringify({ did: userB.did, displayName: userB.name, publicKey: encodeBase64(userB.sign.publicKey), boxPublicKey: encodeBase64(userB.box.publicKey) })
		});
		assert(b === 200, 'Bob registered');

		const { status: c } = await api('/auth/register', {
			method: 'POST',
			body: JSON.stringify({ did: userC.did, displayName: userC.name, publicKey: encodeBase64(userC.sign.publicKey), boxPublicKey: encodeBase64(userC.box.publicKey) })
		});
		assert(c === 200, 'Charlie registered');
	}

	// ==========================================================================
	// 4. Fetch profiles by DID
	// ==========================================================================
	section(4, 'Fetch profiles by DID');
	{
		const { status, body } = await api(`/profiles/${encodeURIComponent(userA.did)}`);
		assert(status === 200, 'Alice profile fetched');
		assert(body.did === userA.did, 'Alice DID matches');
		assert(body.displayName === 'Alice', `Alice name: ${body.displayName}`);
		assert(body.boxPublicKey === encodeBase64(userA.box.publicKey), 'Alice boxPublicKey stored');
	}

	// ==========================================================================
	// 5. Publish geohash cells (both in London)
	// ==========================================================================
	section(5, 'Publish geohash cells');
	const londonLat = 51.5074;
	const londonLon = -0.1278;
	const aliceHash = geohashEncode(londonLat, londonLon, 7);
	const aliceCells = [aliceHash, ...geohashNeighbors(aliceHash)];
	const bobHash = geohashEncode(londonLat + 0.001, londonLon + 0.001, 7);
	const bobCells = [bobHash, ...geohashNeighbors(bobHash)];

	{
		const { status: sa } = await api(`/profiles/${encodeURIComponent(userA.did)}`, { method: 'PUT', body: JSON.stringify({ geohashCells: aliceCells }) });
		assert(sa === 200, `Alice published ${aliceCells.length} geohash cells`);

		const { status: sb } = await api(`/profiles/${encodeURIComponent(userB.did)}`, { method: 'PUT', body: JSON.stringify({ geohashCells: bobCells }) });
		assert(sb === 200, `Bob published ${bobCells.length} geohash cells`);
	}

	// ==========================================================================
	// 6. Discover nearby profiles
	// ==========================================================================
	section(6, 'Discover nearby profiles');
	{
		const queryCells = [...aliceCells, 'aaaaaa', 'bbbbbb'];
		const { status, body } = await api(`/profiles/discover?cells=${queryCells.join(',')}&requesterDid=${encodeURIComponent(userA.did)}`);
		assert(status === 200, `Discovery returned ${body.length} profiles`);
		const bobFound = body.some((p: any) => p.did === userB.did);
		assert(bobFound, `Alice can see Bob`);
	}

	// ==========================================================================
	// 7. Derive DM conversation keys (Double Ratchet)
	// ==========================================================================
	section(7, 'Derive DM conversation keys');
	const enc = new TextEncoder();
	const dec = new TextDecoder();

	const sharedA = nacl.box.before(userB.box.publicKey, userA.box.secretKey);
	const isAInitiator = userA.did < userB.did;
	const chainInit_A = await hmacSha256(sharedA, enc.encode('chain-initiator'));
	const chainResp_A = await hmacSha256(sharedA, enc.encode('chain-responder'));
	const combinedA = isAInitiator
		? new Uint8Array([...userA.box.publicKey, ...userB.box.publicKey])
		: new Uint8Array([...userB.box.publicKey, ...userA.box.publicKey]);
	const groupIdA = hexEncode(await sha256(combinedA)).slice(0, 32);

	const sharedB = nacl.box.before(userA.box.publicKey, userB.box.secretKey);
	const isBInitiator = userB.did < userA.did;
	const chainInit_B = await hmacSha256(sharedB, enc.encode('chain-initiator'));
	const chainResp_B = await hmacSha256(sharedB, enc.encode('chain-responder'));
	const combinedB = isBInitiator
		? new Uint8Array([...userB.box.publicKey, ...userA.box.publicKey])
		: new Uint8Array([...userA.box.publicKey, ...userB.box.publicKey]);
	const groupIdB = hexEncode(await sha256(combinedB)).slice(0, 32);

	assert(encodeBase64(sharedA) === encodeBase64(sharedB), 'DH shared secrets match');
	assert(groupIdA === groupIdB, `Group IDs match: ${groupIdA.slice(0, 16)}...`);

	const aSendChain = isAInitiator ? chainInit_A : chainResp_A;
	const aRecvChain = isAInitiator ? chainResp_A : chainInit_A;
	const bSendChain = isBInitiator ? chainInit_B : chainResp_B;
	const bRecvChain = isBInitiator ? chainResp_B : chainInit_B;

	assert(encodeBase64(aSendChain) === encodeBase64(bRecvChain), 'Alice send == Bob recv chain');

	// ==========================================================================
	// 8. Encrypt & send DM (Alice → Bob)
	// ==========================================================================
	section(8, 'Encrypt & send DM (Alice → Bob)');
	const plaintext = 'hello bob, this is a secret message!';
	{
		const msgKeyA = await hmacSha256(aSendChain, enc.encode('msg'));
		const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
		const ciphertext = nacl.secretbox(enc.encode(plaintext), nonce, msgKeyA);

		const { status } = await api('/messages', {
			method: 'POST',
			body: JSON.stringify({
				groupId: groupIdA,
				senderDid: userA.did,
				recipientDid: userB.did,
				epoch: 0,
				ciphertext: encodeBase64(ciphertext),
				nonce: encodeBase64(nonce),
			})
		});
		assert(status === 200, 'Message stored via REST');
	}

	// ==========================================================================
	// 9. Fetch messages for Bob
	// ==========================================================================
	section(9, 'Fetch messages for Bob');
	{
		const { status, body } = await api(`/messages?did=${encodeURIComponent(userB.did)}`);
		assert(status === 200, `Message fetch returned status 200`);
		assert(body.messages?.length >= 1, `Bob has ${body.messages?.length} messages`);

		if (body.messages?.length > 0) {
			const msg = body.messages[0];
			assert(msg.senderDid === userA.did, 'Sender is Alice');
			assert(msg.recipientDid === userB.did, 'Recipient is Bob');

			// Decrypt
			const msgKeyB = await hmacSha256(bRecvChain, enc.encode('msg'));
			const decryptedBytes = nacl.secretbox.open(
				decodeBase64(msg.ciphertext), decodeBase64(msg.nonce), msgKeyB
			);
			assert(decryptedBytes !== null, 'Decryption succeeded');
			if (decryptedBytes) {
				assert(dec.decode(decryptedBytes) === plaintext, 'Decrypted text matches');
			}
		}
	}

	// ==========================================================================
	// 10. WebSocket relay test
	// ==========================================================================
	section(10, 'WebSocket relay test');
	await new Promise<void>((resolve) => {
		let wsADone = false;
		let wsBDone = false;

		const wsA = new WebSocket('ws://localhost:3000');
		const wsB = new WebSocket('ws://localhost:3000');

		const timeout = setTimeout(() => {
			console.log('  ✗ WebSocket test timed out');
			failed++;
			wsA.close(); wsB.close();
			resolve();
		}, 5000);

		wsB.onopen = () => wsB.send(JSON.stringify({ type: 'register', did: userB.did }));
		wsB.onmessage = (event) => {
			const data = JSON.parse(event.data);
			if (data.type === 'registered') { wsBDone = true; if (wsADone) sendTestMessage(); }
			if (data.type === 'message') {
				assert(data.recipientDid === userB.did, 'WS: recipient is Bob');
				assert(data.ciphertext !== undefined, 'WS: ciphertext present');
				clearTimeout(timeout); wsA.close(); wsB.close(); resolve();
			}
		};
		wsA.onopen = () => wsA.send(JSON.stringify({ type: 'register', did: userA.did }));
		wsA.onmessage = (event) => {
			const data = JSON.parse(event.data);
			if (data.type === 'registered') { wsADone = true; if (wsBDone) sendTestMessage(); }
		};

		function sendTestMessage() {
			wsA.send(JSON.stringify({
				type: 'message',
				groupId: groupIdA,
				senderDid: userA.did,
				recipientDid: userB.did,
				epoch: 1,
				ciphertext: encodeBase64(nacl.randomBytes(32)),
				nonce: encodeBase64(nacl.randomBytes(24)),
			}));
		}
	});

	// ==========================================================================
	// 11. Message polling with `since` param
	// ==========================================================================
	section(11, 'Message polling with since param');
	{
		const { body: all } = await api(`/messages?did=${encodeURIComponent(userB.did)}`);
		assert(all.messages?.length >= 1, `Bob has ${all.messages?.length} stored messages`);

		if (all.messages?.length > 0) {
			const lastTs = all.messages[all.messages.length - 1].createdAt;
			// Send another message
			await api('/messages', {
				method: 'POST',
				body: JSON.stringify({
					groupId: groupIdA, senderDid: userA.did, recipientDid: userB.did,
					epoch: 2, ciphertext: encodeBase64(nacl.randomBytes(32)), nonce: encodeBase64(nacl.randomBytes(24)),
				})
			});
			const sinceValue = typeof lastTs === 'string' ? lastTs : new Date(lastTs * 1000).toISOString();
			const { body: newMsgs } = await api(`/messages?did=${encodeURIComponent(userB.did)}&since=${encodeURIComponent(sinceValue)}`);
			assert(newMsgs.messages?.length >= 1, `Polling returned ${newMsgs.messages?.length} new messages after since`);
		}
	}

	// ==========================================================================
	// 12. Block / unblock test
	// ==========================================================================
	section(12, 'Block / unblock test');
	{
		const { status } = await api('/moderation/block', {
			method: 'POST', body: JSON.stringify({ blockerDid: userA.did, blockedDid: userB.did })
		});
		assert(status === 200, 'Alice blocked Bob');

		const { body: filtered } = await api(`/profiles/discover?cells=${aliceCells.join(',')}&requesterDid=${encodeURIComponent(userA.did)}`);
		assert(!filtered.some((p: any) => p.did === userB.did), 'Bob filtered from discovery after block');

		const { status: us } = await api('/moderation/unblock', {
			method: 'POST', body: JSON.stringify({ blockerDid: userA.did, blockedDid: userB.did })
		});
		assert(us === 200, 'Alice unblocked Bob');

		const { body: unfiltered } = await api(`/profiles/discover?cells=${aliceCells.join(',')}&requesterDid=${encodeURIComponent(userA.did)}`);
		assert(unfiltered.some((p: any) => p.did === userB.did), 'Bob visible again after unblock');
	}

	// ==========================================================================
	// 13. Delivery tokens (sealed sender DMs)
	// ==========================================================================
	section(13, 'Delivery tokens (sealed sender DMs)');
	const bobDeliveryToken = encodeBase64(nacl.randomBytes(32));
	const bobTokenHash = await sha256Hex(bobDeliveryToken);
	{
		// Register delivery token for Bob
		const { status } = await api('/messages/delivery-token', {
			method: 'POST', body: JSON.stringify({ did: userB.did, tokenHash: bobTokenHash })
		});
		assert(status === 200, 'Bob registered delivery token');

		// Seal a message for Bob (Alice → Bob)
		const ephemeralBox = nacl.box.keyPair();
		const sealedNonce = nacl.randomBytes(nacl.box.nonceLength);
		const innerPlaintext = JSON.stringify({ type: 'dm', senderDid: userA.did, text: 'sealed hello!' });
		const sealedPayload = nacl.box(
			enc.encode(innerPlaintext), sealedNonce, userB.box.publicKey, ephemeralBox.secretKey
		);

		const { status: ss, body } = await api('/messages/sealed', {
			method: 'POST',
			body: JSON.stringify({
				recipientDid: userB.did,
				deliveryToken: bobDeliveryToken,
				sealedPayload: encodeBase64(sealedPayload),
				ephemeralPublicKey: encodeBase64(ephemeralBox.publicKey),
				nonce: encodeBase64(sealedNonce),
			})
		});
		assert(ss === 200, 'Sealed message stored');
		assert(body.id !== undefined, `Sealed message has ID: ${body.id}`);

		// Fetch sealed messages for Bob
		const { body: fetched } = await api(`/messages?did=${encodeURIComponent(userB.did)}`);
		assert(fetched.sealed?.length >= 1, `Bob has ${fetched.sealed?.length} sealed messages`);

		if (fetched.sealed?.length > 0) {
			const sealed = fetched.sealed[fetched.sealed.length - 1];
			// Bob unseals: open with ephemeral public + Bob's secret
			const unsealed = nacl.box.open(
				decodeBase64(sealed.sealedPayload),
				decodeBase64(sealed.nonce),
				decodeBase64(sealed.ephemeralPublicKey),
				userB.box.secretKey
			);
			assert(unsealed !== null, 'Bob unsealed the message');
			if (unsealed) {
				const payload = JSON.parse(dec.decode(unsealed));
				assert(payload.senderDid === userA.did, `Sealed sender identity: ${payload.senderDid.slice(0, 20)}...`);
				assert(payload.text === 'sealed hello!', 'Sealed message text matches');
			}
		}

		// Attempt with invalid token
		const { status: badStatus } = await api('/messages/sealed', {
			method: 'POST',
			body: JSON.stringify({
				recipientDid: userB.did,
				deliveryToken: 'invalid-token',
				sealedPayload: encodeBase64(nacl.randomBytes(64)),
				ephemeralPublicKey: encodeBase64(nacl.randomBytes(32)),
				nonce: encodeBase64(nacl.randomBytes(24)),
			})
		});
		assert(badStatus === 403, 'Invalid delivery token rejected');
	}

	// Token rotation test
	{
		const newToken = encodeBase64(nacl.randomBytes(32));
		const newTokenHash = await sha256Hex(newToken);

		const { status } = await api('/messages/delivery-token', {
			method: 'POST', body: JSON.stringify({ did: userB.did, tokenHash: newTokenHash })
		});
		assert(status === 200, 'Bob rotated delivery token');

		// Old token should still work (previousTokenHash)
		const ephemeralBox = nacl.box.keyPair();
		const nonce = nacl.randomBytes(nacl.box.nonceLength);
		const { status: oldTs } = await api('/messages/sealed', {
			method: 'POST',
			body: JSON.stringify({
				recipientDid: userB.did,
				deliveryToken: bobDeliveryToken,
				sealedPayload: encodeBase64(nacl.box(enc.encode('old token test'), nonce, userB.box.publicKey, ephemeralBox.secretKey)),
				ephemeralPublicKey: encodeBase64(ephemeralBox.publicKey),
				nonce: encodeBase64(nonce),
			})
		});
		assert(oldTs === 200, 'Old delivery token still works after rotation');
	}

	// ==========================================================================
	// 14. Group creation & management
	// ==========================================================================
	section(14, 'Group creation & management');
	let testGroupId = '';
	{
		// Alice creates a group with Bob invited
		const { status, body } = await api('/groups', {
			method: 'POST',
			body: JSON.stringify({ name: 'Test Group', creatorDid: userA.did, initialMembers: [userB.did] })
		});
		assert(status === 200, 'Group created');
		assert(body.groupId !== undefined, `Group ID: ${body.groupId}`);
		testGroupId = body.groupId;

		// Bob accepts the pending invite
		const { body: pendingInvites } = await api(`/groups/invites/pending?did=${encodeURIComponent(userB.did)}`);
		const bobInvite = pendingInvites.find((i: any) => i.groupId === testGroupId);
		assert(bobInvite !== undefined, 'Bob has pending invite');
		if (bobInvite) {
			const { status: acceptStatus } = await api(`/groups/invites/${bobInvite.id}/respond`, {
				method: 'POST', body: JSON.stringify({ action: 'accept' })
			});
			assert(acceptStatus === 200, 'Bob accepted group invite');
		}

		// Fetch group details — should now have 2 members
		const { status: gs, body: group } = await api(`/groups/${testGroupId}`);
		assert(gs === 200, 'Group details fetched');
		assert(group.name === 'Test Group', `Group name: ${group.name}`);
		assert(group.members?.length === 2, `Group has ${group.members?.length} members`);

		// List groups for Alice
		const { body: aliceGroups } = await api(`/groups?did=${encodeURIComponent(userA.did)}`);
		assert(aliceGroups.some((g: any) => g.id === testGroupId), 'Alice sees group in list');

		// List groups for Bob
		const { body: bobGroups } = await api(`/groups?did=${encodeURIComponent(userB.did)}`);
		assert(bobGroups.some((g: any) => g.id === testGroupId), 'Bob sees group in list');
	}

	// ==========================================================================
	// 15. Group sender keys (wrap / unwrap / encrypt / decrypt)
	// ==========================================================================
	section(15, 'Group sender keys');
	const aliceSenderKey = generateSenderKey();
	const bobSenderKey = generateSenderKey();
	{
		// Alice wraps her sender key for Bob
		const members = [{ did: userB.did, boxPublicKey: encodeBase64(userB.box.publicKey) }];
		const wrapped = wrapSenderKeyForMembers(aliceSenderKey, userA.box.secretKey, members);
		assert(wrapped.length === 1, 'Alice wrapped key for 1 member');
		assert(wrapped[0].memberDid === userB.did, 'Wrapped for Bob');

		// Bob unwraps
		const { senderKey } = unwrapSenderKey(
			wrapped[0].wrappedKey, wrapped[0].wrappedKeyNonce,
			userA.box.publicKey, userB.box.secretKey
		);
		assert(senderKey === aliceSenderKey, 'Bob unwrapped Alice\'s sender key');

		// Bob wraps his sender key for Alice
		const membersForBob = [{ did: userA.did, boxPublicKey: encodeBase64(userA.box.publicKey) }];
		const wrappedBob = wrapSenderKeyForMembers(bobSenderKey, userB.box.secretKey, membersForBob);
		const { senderKey: unwrappedBobKey } = unwrapSenderKey(
			wrappedBob[0].wrappedKey, wrappedBob[0].wrappedKeyNonce,
			userB.box.publicKey, userA.box.secretKey
		);
		assert(unwrappedBobKey === bobSenderKey, 'Alice unwrapped Bob\'s sender key');

		// Alice encrypts a group message
		const groupMsg = JSON.stringify({ t: 'sealed_group', senderDid: userA.did, text: 'hello group!' });
		const { ciphertext, nonce } = encryptGroupMessage(groupMsg, aliceSenderKey);
		assert(ciphertext.length > 0, 'Group message encrypted');

		// Bob decrypts
		const decrypted = decryptGroupMessage(ciphertext, nonce, aliceSenderKey);
		const parsed = JSON.parse(decrypted);
		assert(parsed.t === 'sealed_group', 'Payload type is sealed_group');
		assert(parsed.senderDid === userA.did, 'Sender identity embedded in payload');
		assert(parsed.text === 'hello group!', 'Group message text matches');
	}

	// Sender key wrapping with delivery token (payload contains ':')
	{
		const token = 'some-delivery-token-value';
		const members = [{ did: userB.did, boxPublicKey: encodeBase64(userB.box.publicKey) }];
		const wrapped = wrapSenderKeyForMembers(aliceSenderKey, userA.box.secretKey, members, token);
		const { senderKey, deliveryToken } = unwrapSenderKey(
			wrapped[0].wrappedKey, wrapped[0].wrappedKeyNonce,
			userA.box.publicKey, userB.box.secretKey
		);
		assert(senderKey === aliceSenderKey, 'Sender key correct after wrap with token');
		assert(deliveryToken === token, 'Delivery token correct after wrap');
	}

	// ==========================================================================
	// 16. Store & retrieve group keys via server
	// ==========================================================================
	section(16, 'Store & retrieve group keys via server');
	{
		const members = [{ did: userB.did, boxPublicKey: encodeBase64(userB.box.publicKey) }];
		const wrapped = wrapSenderKeyForMembers(aliceSenderKey, userA.box.secretKey, members);

		// Store keys
		const { status } = await api(`/groups/${testGroupId}/keys`, {
			method: 'POST',
			body: JSON.stringify({
				senderDid: userA.did,
				keys: wrapped.map(w => ({ memberDid: w.memberDid, wrappedKey: w.wrappedKey, wrappedKeyNonce: w.wrappedKeyNonce })),
				epoch: 0,
			})
		});
		assert(status === 200, 'Group keys stored on server');

		// Retrieve keys for Bob
		const { status: gs, body: keys } = await api(`/groups/${testGroupId}/keys/${encodeURIComponent(userB.did)}`);
		assert(gs === 200, 'Group keys retrieved for Bob');
		assert(keys.length >= 1, `Bob has ${keys.length} key entries`);

		if (keys.length > 0) {
			const entry = keys[0];
			const { senderKey } = unwrapSenderKey(
				entry.wrappedKey, entry.wrappedKeyNonce,
				userA.box.publicKey, userB.box.secretKey
			);
			assert(senderKey === aliceSenderKey, 'Bob unwrapped stored group key');
		}
	}

	// ==========================================================================
	// 17. Group delivery token + sealed group messages
	// ==========================================================================
	section(17, 'Group delivery token + sealed group messages');
	const groupDeliveryToken = encodeBase64(nacl.randomBytes(32));
	const groupTokenHash = await sha256Hex(groupDeliveryToken);
	{
		// Register group delivery token
		const { status } = await api('/messages/group-delivery-token', {
			method: 'POST', body: JSON.stringify({ groupId: testGroupId, tokenHash: groupTokenHash })
		});
		assert(status === 200, 'Group delivery token registered');

		// Send a sealed group message
		const groupMsg = JSON.stringify({ t: 'sealed_group', senderDid: userA.did, text: 'sealed group message' });
		const { ciphertext, nonce } = encryptGroupMessage(groupMsg, aliceSenderKey);

		const { status: ss, body } = await api('/messages/sealed-group', {
			method: 'POST',
			body: JSON.stringify({
				groupId: testGroupId,
				deliveryToken: groupDeliveryToken,
				ciphertext,
				nonce,
				epoch: 0,
			})
		});
		assert(ss === 200, 'Sealed group message stored');
		assert(body.ids?.length >= 1, `Fanned out to ${body.ids?.length} members`);

		// Fetch messages for Bob — should contain the sealed group message
		const { body: fetched } = await api(`/messages?did=${encodeURIComponent(userB.did)}`);
		const sealedGroupMsgs = fetched.messages?.filter((m: any) => m.senderDid === 'sealed' && m.groupId === testGroupId);
		assert(sealedGroupMsgs?.length >= 1, `Bob received ${sealedGroupMsgs?.length} sealed group message(s)`);

		if (sealedGroupMsgs?.length > 0) {
			const msg = sealedGroupMsgs[sealedGroupMsgs.length - 1];
			const decrypted = decryptGroupMessage(msg.ciphertext, msg.nonce, aliceSenderKey);
			const parsed = JSON.parse(decrypted);
			assert(parsed.text === 'sealed group message', 'Sealed group message decrypted correctly');
			assert(parsed.senderDid === userA.did, 'Sealed sender identity in payload');
			assert(msg.senderDid === 'sealed', 'Server only sees "sealed" sender');
		}

		// Invalid group delivery token
		const { status: bad } = await api('/messages/sealed-group', {
			method: 'POST',
			body: JSON.stringify({
				groupId: testGroupId,
				deliveryToken: 'invalid-token',
				ciphertext: encodeBase64(nacl.randomBytes(64)),
				nonce: encodeBase64(nacl.randomBytes(24)),
				epoch: 0,
			})
		});
		assert(bad === 403, 'Invalid group delivery token rejected');
	}

	// ==========================================================================
	// 18. DM invitations (first contact flow)
	// ==========================================================================
	section(18, 'DM invitations (first contact flow)');
	let dmInvitationId = '';
	{
		// Alice sends DM invitation to Charlie (first contact)
		const dmGroupId = 'dm-invite-test-' + Date.now();
		const { status, body } = await api('/invitations/dm', {
			method: 'POST',
			body: JSON.stringify({
				senderDid: userA.did,
				recipientDid: userC.did,
				groupId: dmGroupId,
				senderDisplayName: 'Alice',
				senderGeohashCell: aliceHash,
				firstMessageCiphertext: encodeBase64(nacl.randomBytes(64)),
				firstMessageNonce: encodeBase64(nacl.randomBytes(24)),
				firstMessageEpoch: 0,
			})
		});
		assert(status === 200, 'DM invitation created');
		assert(body.id !== undefined, `Invitation ID: ${body.id}`);
		dmInvitationId = body.id;

		// Duplicate should be rejected
		const { status: dup } = await api('/invitations/dm', {
			method: 'POST',
			body: JSON.stringify({
				senderDid: userA.did,
				recipientDid: userC.did,
				groupId: dmGroupId,
				senderDisplayName: 'Alice',
				firstMessageCiphertext: encodeBase64(nacl.randomBytes(64)),
				firstMessageNonce: encodeBase64(nacl.randomBytes(24)),
				firstMessageEpoch: 0,
			})
		});
		assert(dup === 409, 'Duplicate invitation rejected');

		// Charlie fetches pending invitations
		const { status: gs, body: pending } = await api(`/invitations/dm?did=${encodeURIComponent(userC.did)}`);
		assert(gs === 200, 'Pending invitations fetched');
		assert(pending.length >= 1, `Charlie has ${pending.length} pending invitation(s)`);
		if (pending.length > 0) {
			const inv = pending.find((p: any) => p.id === dmInvitationId);
			assert(inv !== undefined, 'Invitation ID found');
			assert(inv?.senderDid === userA.did, 'Invitation sender is Alice');
			assert(inv?.senderDisplayName === 'Alice', 'Sender display name present');
			assert(inv?.senderBoxPublicKey !== null, 'Sender boxPublicKey enriched');
		}

		// Charlie accepts the invitation
		const { status: acceptStatus, body: acceptBody } = await api(`/invitations/dm/${dmInvitationId}/accept`, {
			method: 'POST'
		});
		assert(acceptStatus === 200, 'DM invitation accepted');
		assert(acceptBody.groupId === dmGroupId, 'Accepted invitation returns groupId');

		// Pending should now be empty for this invitation
		const { body: afterAccept } = await api(`/invitations/dm?did=${encodeURIComponent(userC.did)}`);
		assert(!afterAccept.some((p: any) => p.id === dmInvitationId), 'Accepted invitation no longer pending');
	}

	// DM invitation blocking
	{
		const dmGroupId2 = 'dm-block-test-' + Date.now();
		const { body: inv } = await api('/invitations/dm', {
			method: 'POST',
			body: JSON.stringify({
				senderDid: userB.did,
				recipientDid: userC.did,
				groupId: dmGroupId2,
				senderDisplayName: 'Bob',
				firstMessageCiphertext: encodeBase64(nacl.randomBytes(64)),
				firstMessageNonce: encodeBase64(nacl.randomBytes(24)),
				firstMessageEpoch: 0,
			})
		});
		const blockInvId = inv.id;

		const { status: blockStatus } = await api(`/invitations/dm/${blockInvId}/block`, { method: 'POST' });
		assert(blockStatus === 200, 'DM invitation blocked');

		// Check block was created
		const { body: blockList } = await api(`/moderation/blocks?did=${encodeURIComponent(userC.did)}`);
		assert(blockList.some((b: any) => b.blockedDid === userB.did), 'Block entry created from invitation block');

		// Clean up: unblock for future tests
		await api('/moderation/unblock', { method: 'POST', body: JSON.stringify({ blockerDid: userC.did, blockedDid: userB.did }) });
	}

	// ==========================================================================
	// 19. DM leave / status
	// ==========================================================================
	section(19, 'DM leave / status');
	{
		const leaveGroupId = 'dm-leave-test-' + Date.now();
		// Create an invitation first so the leave has context
		await api('/invitations/dm', {
			method: 'POST',
			body: JSON.stringify({
				senderDid: userA.did, recipientDid: userB.did, groupId: leaveGroupId,
				senderDisplayName: 'Alice',
				firstMessageCiphertext: encodeBase64(nacl.randomBytes(64)),
				firstMessageNonce: encodeBase64(nacl.randomBytes(24)),
				firstMessageEpoch: 0,
			})
		});

		// Alice leaves the DM
		const { status } = await api('/invitations/dm-leave', {
			method: 'POST', body: JSON.stringify({ groupId: leaveGroupId, did: userA.did })
		});
		assert(status === 200, 'DM leave recorded');

		// Check leave status
		const { body: leaves } = await api(`/invitations/dm-status?groupId=${encodeURIComponent(leaveGroupId)}`);
		assert(leaves.some((l: any) => l.leaverDid === userA.did), 'Leave record found');

		// Messages should be blocked in this conversation
		const { status: msgStatus, body: msgBody } = await api('/messages', {
			method: 'POST',
			body: JSON.stringify({
				groupId: leaveGroupId, senderDid: userB.did, recipientDid: userA.did,
				epoch: 0, ciphertext: encodeBase64(nacl.randomBytes(32)), nonce: encodeBase64(nacl.randomBytes(24)),
			})
		});
		assert(msgStatus === 403, 'Messages blocked after DM leave');

		// Clean up leave
		const { status: ds } = await api('/invitations/dm-leave', {
			method: 'DELETE', body: JSON.stringify({ groupId: leaveGroupId })
		});
		assert(ds === 200, 'DM leave records cleared');
	}

	// ==========================================================================
	// 20. Group invite & accept
	// ==========================================================================
	section(20, 'Group invite & accept');
	{
		// Alice invites Charlie to the test group
		const { status } = await api(`/groups/${testGroupId}/invite`, {
			method: 'POST',
			body: JSON.stringify({ inviterDid: userA.did, inviteeDid: userC.did })
		});
		assert(status === 200, 'Alice invited Charlie');

		// Charlie sees pending invite
		const { body: pending } = await api(`/groups/invites/pending?did=${encodeURIComponent(userC.did)}`);
		assert(pending.some((i: any) => i.groupId === testGroupId), 'Charlie sees pending group invite');

		// Charlie accepts
		const invite = pending.find((i: any) => i.groupId === testGroupId);
		if (invite) {
			const { status: as } = await api(`/groups/invites/${invite.id}/respond`, {
				method: 'POST', body: JSON.stringify({ action: 'accept' })
			});
			assert(as === 200, 'Charlie accepted group invite');

			// Verify Charlie is now a member
			const { body: group } = await api(`/groups/${testGroupId}`);
			assert(group.members?.some((m: any) => m.did === userC.did), 'Charlie is now a group member');
			assert(group.members?.length === 3, `Group now has ${group.members?.length} members`);
		}
	}

	// ==========================================================================
	// 21. Group join requests
	// ==========================================================================
	section(21, 'Group join requests');
	let joinRequestGroupId = '';
	{
		// Create a new group for join request testing
		const { body: ng } = await api('/groups', {
			method: 'POST',
			body: JSON.stringify({ name: 'Join Request Group', creatorDid: userA.did })
		});
		joinRequestGroupId = ng.groupId;

		// Bob requests to join (not a member)
		const { status, body } = await api(`/groups/${joinRequestGroupId}/request-join`, {
			method: 'POST', body: JSON.stringify({ did: userB.did })
		});
		assert(status === 200, 'Bob requested to join');

		// Duplicate request should be handled
		const { body: dupBody } = await api(`/groups/${joinRequestGroupId}/request-join`, {
			method: 'POST', body: JSON.stringify({ did: userB.did })
		});
		assert(dupBody.alreadyRequested === true, 'Duplicate join request detected');

		// Alice (admin) sees join requests
		const { body: requests } = await api(`/groups/${joinRequestGroupId}/join-requests?did=${encodeURIComponent(userA.did)}`);
		assert(requests.length >= 1, `Admin sees ${requests.length} join request(s)`);

		// Alice also sees it in aggregated admin endpoint
		const { body: allReqs } = await api(`/groups/my-admin-join-requests?did=${encodeURIComponent(userA.did)}`);
		assert(allReqs.some((r: any) => r.groupId === joinRequestGroupId), 'Admin sees request in aggregated endpoint');

		// Alice approves Bob's request (join-requests returns `did` field, my-admin returns `requesterDid`)
		const req = requests.find((r: any) => r.did === userB.did);
		assert(req !== undefined, 'Found Bob\'s join request');
		if (req) {
			const { status: approveStatus } = await api(`/groups/${joinRequestGroupId}/join-requests/${req.id}/respond`, {
				method: 'POST', body: JSON.stringify({ did: userA.did, action: 'approve' })
			});
			assert(approveStatus === 200, 'Alice approved Bob\'s join request');

			// Verify Bob is now a member
			const { body: group } = await api(`/groups/${joinRequestGroupId}`);
			assert(group.members?.some((m: any) => m.did === userB.did), 'Bob is now a member');
		}
	}

	// Join request denial
	{
		// Charlie requests to join
		await api(`/groups/${joinRequestGroupId}/request-join`, {
			method: 'POST', body: JSON.stringify({ did: userC.did })
		});

		const { body: requests } = await api(`/groups/${joinRequestGroupId}/join-requests?did=${encodeURIComponent(userA.did)}`);
		const req = requests.find((r: any) => r.did === userC.did);
		assert(req !== undefined, 'Found Charlie\'s join request');
		if (req) {
			const { status: denyStatus } = await api(`/groups/${joinRequestGroupId}/join-requests/${req.id}/respond`, {
				method: 'POST', body: JSON.stringify({ did: userA.did, action: 'deny' })
			});
			assert(denyStatus === 200, 'Alice denied Charlie\'s join request');

			// Verify Charlie is NOT a member
			const { body: group } = await api(`/groups/${joinRequestGroupId}`);
			assert(!group.members?.some((m: any) => m.did === userC.did), 'Charlie is not a member after denial');
		}
	}

	// ==========================================================================
	// 22. Group invite link
	// ==========================================================================
	section(22, 'Group invite link');
	{
		// Alice creates an invite link
		const inviteKey = encodeBase64(nacl.randomBytes(32));
		const inviteKeyHash = await sha256Hex(inviteKey);

		const { status } = await api(`/groups/${joinRequestGroupId}/invite-link`, {
			method: 'POST',
			body: JSON.stringify({ did: userA.did, inviteKeyHash: inviteKeyHash, maxUses: 5, expiresInHours: 24 })
		});
		assert(status === 200, 'Invite link created');

		// Charlie joins via invite link
		const { status: js, body: jb } = await api(`/groups/${joinRequestGroupId}/join`, {
			method: 'POST',
			body: JSON.stringify({ did: userC.did, inviteKey })
		});
		assert(js === 200, 'Charlie joined via invite link');
		assert(jb.groupId === joinRequestGroupId, 'Join returns groupId');

		// Verify Charlie is now a member
		const { body: group } = await api(`/groups/${joinRequestGroupId}`);
		assert(group.members?.some((m: any) => m.did === userC.did), 'Charlie is a member after invite link join');

		// Delete invite link
		const { status: ds } = await api(`/groups/${joinRequestGroupId}/invite-link`, {
			method: 'DELETE', body: JSON.stringify({ did: userA.did })
		});
		assert(ds === 200, 'Invite link deleted');
	}

	// ==========================================================================
	// 23. Group leave & kick
	// ==========================================================================
	section(23, 'Group leave & kick');
	{
		// Charlie leaves the join request group
		const { status: ls } = await api(`/groups/${joinRequestGroupId}/leave`, {
			method: 'POST', body: JSON.stringify({ did: userC.did })
		});
		assert(ls === 200, 'Charlie left group');

		const { body: group } = await api(`/groups/${joinRequestGroupId}`);
		assert(!group.members?.some((m: any) => m.did === userC.did), 'Charlie no longer a member after leave');

		// Alice kicks Bob from join request group
		const { status: ks } = await api(`/groups/${joinRequestGroupId}/kick`, {
			method: 'POST', body: JSON.stringify({ did: userA.did, targetDid: userB.did })
		});
		assert(ks === 200, 'Alice kicked Bob');

		const { body: group2 } = await api(`/groups/${joinRequestGroupId}`);
		assert(!group2.members?.some((m: any) => m.did === userB.did), 'Bob no longer a member after kick');
	}

	// ==========================================================================
	// 24. Moderation: reports
	// ==========================================================================
	section(24, 'Moderation: reports');
	{
		const { status } = await api('/moderation/report', {
			method: 'POST',
			body: JSON.stringify({
				reporterDid: userA.did,
				reportedDid: userB.did,
				reason: 'spam',
				details: 'Sending unsolicited messages',
			})
		});
		assert(status === 200, 'Report submitted');
	}

	// ==========================================================================
	// 25. Moderation: flags with independence weighting
	// ==========================================================================
	section(25, 'Moderation: flags');
	{
		// Create a fresh user to flag
		const flagTarget = createUser('FlagTarget');
		await registerUser(flagTarget);

		// Create multiple flaggers (independent — not in same groups)
		const flagger1 = createUser('Flagger1');
		const flagger2 = createUser('Flagger2');
		const flagger3 = createUser('Flagger3');
		await registerUser(flagger1);
		await registerUser(flagger2);
		await registerUser(flagger3);

		// Create signed flag payloads (Ed25519 signed)
		for (const flagger of [flagger1, flagger2, flagger3]) {
			const flagPayload = JSON.stringify({
				flaggerDid: flagger.did,
				flaggedDid: flagTarget.did,
				category: 'fake_profile',
				timestamp: Date.now(),
			});
			const signedBlob = encodeBase64(new TextEncoder().encode(flagPayload));
			const signature = encodeBase64(nacl.sign.detached(new TextEncoder().encode(flagPayload), flagger.sign.secretKey));

			const { status } = await api('/moderation/flag', {
				method: 'POST',
				body: JSON.stringify({
					flaggerDid: flagger.did,
					flaggedDid: flagTarget.did,
					category: 'fake_profile',
					signedBlob,
					signature,
				})
			});
			assert(status === 200, `Flag from ${flagger.name} submitted`);
		}

		// Check flag status — 3 independent flags should trigger throttle (weight >= 3.0)
		const { body: flagStatus } = await api(`/moderation/flag-status?did=${encodeURIComponent(flagTarget.did)}`);
		assert(flagStatus.level === 'throttled' || flagStatus.level === 'hidden', `Flag target level: ${flagStatus.level}`);

		// Appeal
		const { status: appealStatus } = await api('/moderation/appeal', {
			method: 'POST', body: JSON.stringify({ did: flagTarget.did })
		});
		assert(appealStatus === 200, 'Appeal submitted');
	}

	// ==========================================================================
	// 26. Media upload & download
	// ==========================================================================
	section(26, 'Media upload & download');
	{
		// Encrypt a test "image"
		const testImage = nacl.randomBytes(256);
		const mediaKey = nacl.randomBytes(nacl.secretbox.keyLength);
		const mediaNonce = nacl.randomBytes(nacl.secretbox.nonceLength);
		const encryptedMedia = nacl.secretbox(testImage, mediaNonce, mediaKey);

		// Upload
		const formData = new FormData();
		formData.append('file', new Blob([encryptedMedia], { type: 'application/octet-stream' }), 'test.enc');
		formData.append('uploaderDid', userA.did);
		formData.append('mimeType', 'image/jpeg');
		formData.append('mediaKeyWrapped', encodeBase64(mediaKey)); // simplified — normally wrapped for recipient

		const { status, body } = await apiForm('/media/upload', formData);
		assert(status === 200, 'Media uploaded');
		assert(body.mediaId !== undefined, `Media ID: ${body.mediaId}`);

		// Download metadata
		const { status: ds, body: meta } = await api(`/media/${body.mediaId}`);
		assert(ds === 200, 'Media metadata fetched');
		assert(meta.mimeType === 'image/jpeg', `Media type: ${meta.mimeType}`);
		assert(meta.encryptedBlob !== null, 'Encrypted blob returned as base64');

		// Download raw blob
		const rawRes = await fetch(`${BASE}/media/${body.mediaId}/blob`);
		assert(rawRes.status === 200, 'Raw blob downloaded');
		const rawData = new Uint8Array(await rawRes.arrayBuffer());
		assert(rawData.length === encryptedMedia.length, `Blob size matches: ${rawData.length}`);

		// Decrypt
		const decryptedMedia = nacl.secretbox.open(rawData, mediaNonce, mediaKey);
		assert(decryptedMedia !== null, 'Media decrypted');
		if (decryptedMedia) {
			assert(encodeBase64(decryptedMedia) === encodeBase64(testImage), 'Decrypted media matches original');
		}

		// Delete
		const { status: delStatus } = await api(`/media/${body.mediaId}`, {
			method: 'DELETE', body: JSON.stringify({ did: userA.did })
		});
		assert(delStatus === 200, 'Media deleted');

		// Verify deleted
		const { status: goneStatus } = await api(`/media/${body.mediaId}`);
		assert(goneStatus === 404, 'Deleted media returns 404');
	}

	// ==========================================================================
	// 27. View-once media
	// ==========================================================================
	section(27, 'View-once media');
	{
		const testImage = nacl.randomBytes(128);
		const formData = new FormData();
		formData.append('file', new Blob([testImage], { type: 'application/octet-stream' }), 'viewonce.enc');
		formData.append('uploaderDid', userA.did);
		formData.append('mimeType', 'image/png');
		formData.append('viewOnce', 'true');

		const { body } = await apiForm('/media/upload', formData);
		assert(body.mediaId !== undefined, 'View-once media uploaded');

		// Mark as viewed
		const { status: vs } = await api(`/media/${body.mediaId}/viewed`, {
			method: 'POST', body: JSON.stringify({ did: userB.did })
		});
		assert(vs === 200, 'View-once marked as viewed');

		// Should be deleted
		const { status: goneStatus } = await api(`/media/${body.mediaId}`);
		assert(goneStatus === 404, 'View-once media deleted after viewing');
	}

	// ==========================================================================
	// 28. Sealed media upload (with delivery token)
	// ==========================================================================
	section(28, 'Sealed media upload');
	{
		const testImage = nacl.randomBytes(128);
		const formData = new FormData();
		formData.append('file', new Blob([testImage], { type: 'application/octet-stream' }), 'sealed.enc');
		formData.append('deliveryToken', groupDeliveryToken); // group delivery token
		formData.append('mimeType', 'image/jpeg');

		const { status, body } = await apiForm('/media/upload-sealed', formData);
		assert(status === 200, 'Sealed media uploaded');
		assert(body.mediaId !== undefined, 'Sealed media ID returned');

		// Verify uploaderDid is null (anonymous)
		const { body: meta } = await api(`/media/${body.mediaId}`);
		assert(meta.uploaderDid === null, 'Sealed media has no uploaderDid');

		// Invalid delivery token
		const badForm = new FormData();
		badForm.append('file', new Blob([nacl.randomBytes(64)]), 'bad.enc');
		badForm.append('deliveryToken', 'invalid-token');
		badForm.append('mimeType', 'image/png');

		const { status: badStatus } = await apiForm('/media/upload-sealed', badForm);
		assert(badStatus === 403, 'Invalid delivery token rejected for sealed media');
	}

	// ==========================================================================
	// 29. WebSocket sealed group message relay
	// ==========================================================================
	section(29, 'WebSocket sealed group message relay');
	await new Promise<void>((resolve) => {
		const wsA = new WebSocket('ws://localhost:3000');
		const wsB = new WebSocket('ws://localhost:3000');
		let aReady = false, bReady = false;

		const timeout = setTimeout(() => {
			console.log('  ✗ WS sealed group test timed out');
			failed++;
			wsA.close(); wsB.close();
			resolve();
		}, 5000);

		wsA.onopen = () => wsA.send(JSON.stringify({ type: 'register', did: userA.did }));
		wsB.onopen = () => wsB.send(JSON.stringify({ type: 'register', did: userB.did }));

		wsA.onmessage = (e) => {
			const data = JSON.parse(e.data);
			if (data.type === 'registered') { aReady = true; if (bReady) sendSealed(); }
		};

		wsB.onmessage = (e) => {
			const data = JSON.parse(e.data);
			if (data.type === 'registered') { bReady = true; if (aReady) sendSealed(); }
			// Server relays sealed group messages as type 'group_message' with senderDid 'sealed'
			if (data.type === 'group_message' && data.senderDid === 'sealed' && data.groupId === testGroupId) {
				assert(true, 'WS sealed group: received group_message with sealed sender');
				assert(data.ciphertext !== undefined, 'WS sealed group: ciphertext present');
				// Decrypt and verify
				try {
					const decrypted = decryptGroupMessage(data.ciphertext, data.nonce, aliceSenderKey);
					const parsed = JSON.parse(decrypted);
					assert(parsed.text === 'ws sealed group test', 'WS sealed group: decrypted text matches');
				} catch (err) {
					assert(false, `WS sealed group: decryption failed: ${err}`);
				}
				clearTimeout(timeout);
				wsA.close(); wsB.close();
				resolve();
			}
		};

		function sendSealed() {
			const groupMsg = JSON.stringify({ t: 'sealed_group', senderDid: userA.did, text: 'ws sealed group test' });
			const { ciphertext, nonce } = encryptGroupMessage(groupMsg, aliceSenderKey);

			// Get group member DIDs (we know it's A, B, C)
			wsA.send(JSON.stringify({
				type: 'sealed_group_message',
				groupId: testGroupId,
				deliveryToken: groupDeliveryToken,
				ciphertext,
				nonce,
				epoch: 0,
			}));
		}
	});

	// ==========================================================================
	// 30. Profile search
	// ==========================================================================
	section(30, 'Profile search');
	{
		const { status, body } = await api(`/profiles/search?q=Alice`);
		assert(status === 200, 'Profile search returned');
		assert(body.some((p: any) => p.did === userA.did), 'Alice found in search');
		assert(!body.some((p: any) => p.did === userB.did), 'Bob not in Alice search results');
	}

	// ==========================================================================
	// 31. Auth challenge/verify flow
	// ==========================================================================
	section(31, 'Auth challenge/verify');
	{
		const { status: cs, body: challenge } = await api('/auth/challenge', {
			method: 'POST', body: JSON.stringify({ did: userA.did })
		});
		assert(cs === 200, 'Challenge received');
		assert(challenge.challenge !== undefined, 'Challenge string present');

		if (challenge.challenge) {
			const sig = nacl.sign.detached(
				new TextEncoder().encode(challenge.challenge),
				userA.sign.secretKey
			);
			const { status: vs, body: verified } = await api('/auth/verify', {
				method: 'POST',
				body: JSON.stringify({
					did: userA.did,
					challenge: challenge.challenge,
					signature: encodeBase64(sig),
				})
			});
			assert(vs === 200, 'Signature verified');
			assert(verified.token !== undefined || verified.ok !== undefined, 'Auth result received');
		}
	}

	// ==========================================================================
	// 32. Push notification subscription
	// ==========================================================================
	section(32, 'Push notification subscription');
	{
		// Get VAPID public key
		const { status: vk, body: vapid } = await api('/push/vapid-public-key');
		assert(vk === 200, 'VAPID public key returned');
		assert(vapid.publicKey !== undefined, `VAPID key present: ${vapid.publicKey?.slice(0, 20)}...`);

		// Subscribe
		const fakeSub = {
			endpoint: 'https://fcm.googleapis.com/fcm/send/test-' + Date.now(),
			keys: {
				p256dh: encodeBase64(nacl.randomBytes(65)),
				auth: encodeBase64(nacl.randomBytes(16)),
			},
		};

		const { status: ss } = await api('/push/subscribe', {
			method: 'POST',
			body: JSON.stringify({ did: userA.did, subscription: fakeSub })
		});
		assert(ss === 200, 'Push subscription stored');

		// Re-subscribe with same endpoint (should replace)
		const { status: rs } = await api('/push/subscribe', {
			method: 'POST',
			body: JSON.stringify({ did: userA.did, subscription: fakeSub })
		});
		assert(rs === 200, 'Push re-subscription works');

		// Unsubscribe
		const { status: us } = await api('/push/unsubscribe', {
			method: 'POST',
			body: JSON.stringify({ did: userA.did, endpoint: fakeSub.endpoint })
		});
		assert(us === 200, 'Push unsubscription works');
	}

	// ==========================================================================
	// 33. CSAM hash check
	// ==========================================================================
	section(33, 'CSAM hash check');
	{
		const { status, body } = await api('/moderation/check-csam', {
			method: 'POST',
			body: JSON.stringify({ mediaId: 'test-media-id', perceptualHash: 'abc123def456' })
		});
		assert(status === 200, 'CSAM check returned');
		assert(body.blocked === false, 'CSAM check: clear (no match)');
	}

	// ==========================================================================
	// Summary
	// ==========================================================================
	console.log(`\n${'='.repeat(50)}`);
	console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} total`);
	console.log(`${'='.repeat(50)}\n`);

	if (failed > 0) process.exit(1);
}

main().catch(e => {
	console.error('Test failed with error:', e);
	process.exit(1);
});
