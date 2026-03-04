/**
 * Comprehensive E2E test for the proximity app.
 * Tests: registration, profile discovery, messaging, WebSocket relay.
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

// --- API helpers ---

async function api(path: string, opts: RequestInit = {}) {
	const res = await fetch(`${BASE}${path}`, {
		headers: { 'Content-Type': 'application/json', ...opts.headers as Record<string, string> },
		...opts
	});
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

async function main() {
	console.log('\n=== E2E Test Suite ===\n');

	// --- 1. Health check ---
	console.log('1. Server health check');
	{
		const { status, body } = await api('/');
		assert(status === 200, `Health check returned ${status}`);
		assert(body.status === 'ok', `Server status: ${body.status}`);
	}

	// --- 2. Generate two identities ---
	console.log('\n2. Generate identities');
	const userA = {
		sign: nacl.sign.keyPair(),
		box: nacl.box.keyPair(),
		did: '',
		name: 'Alice'
	};
	userA.did = publicKeyToDid(userA.sign.publicKey);

	const userB = {
		sign: nacl.sign.keyPair(),
		box: nacl.box.keyPair(),
		did: '',
		name: 'Bob'
	};
	userB.did = publicKeyToDid(userB.sign.publicKey);

	assert(userA.did.startsWith('did:key:z6Mk'), `Alice DID: ${userA.did.slice(0, 30)}...`);
	assert(userB.did.startsWith('did:key:z6Mk'), `Bob DID: ${userB.did.slice(0, 30)}...`);
	assert(userA.did !== userB.did, 'DIDs are unique');

	// --- 3. Register both users ---
	console.log('\n3. Register users');
	{
		const { status, body } = await api('/auth/register', {
			method: 'POST',
			body: JSON.stringify({
				did: userA.did,
				displayName: userA.name,
				publicKey: encodeBase64(userA.sign.publicKey),
				boxPublicKey: encodeBase64(userA.box.publicKey),
			})
		});
		assert(status === 200, `Alice registered: ${JSON.stringify(body)}`);
	}
	{
		const { status, body } = await api('/auth/register', {
			method: 'POST',
			body: JSON.stringify({
				did: userB.did,
				displayName: userB.name,
				publicKey: encodeBase64(userB.sign.publicKey),
				boxPublicKey: encodeBase64(userB.box.publicKey),
			})
		});
		assert(status === 200, `Bob registered: ${JSON.stringify(body)}`);
	}

	// --- 4. Fetch profiles by DID ---
	console.log('\n4. Fetch profiles by DID');
	{
		const { status, body } = await api(`/profiles/${encodeURIComponent(userA.did)}`);
		assert(status === 200, `Alice profile fetched`);
		assert(body.did === userA.did, `Alice DID matches`);
		assert(body.displayName === 'Alice', `Alice name: ${body.displayName}`);
		assert(body.boxPublicKey === encodeBase64(userA.box.publicKey), `Alice boxPublicKey stored correctly`);
		console.log(`  Alice profile: ${JSON.stringify({ did: body.did?.slice(0, 20), displayName: body.displayName, boxPublicKey: body.boxPublicKey?.slice(0, 10) })}`);
	}
	{
		const { status, body } = await api(`/profiles/${encodeURIComponent(userB.did)}`);
		assert(status === 200, `Bob profile fetched`);
		assert(body.boxPublicKey === encodeBase64(userB.box.publicKey), `Bob boxPublicKey stored correctly`);
	}

	// --- 5. Publish geohash cells (both in London) ---
	console.log('\n5. Publish geohash cells');
	const londonLat = 51.5074;
	const londonLon = -0.1278;
	// Alice at exact London center
	const aliceHash = geohashEncode(londonLat, londonLon, 7);
	const aliceCells = [aliceHash, ...geohashNeighbors(aliceHash)];
	// Bob 200m away
	const bobHash = geohashEncode(londonLat + 0.001, londonLon + 0.001, 7);
	const bobCells = [bobHash, ...geohashNeighbors(bobHash)];

	console.log(`  Alice geohash: ${aliceHash}, Bob geohash: ${bobHash}`);
	console.log(`  Same cell? ${aliceHash === bobHash}`);
	console.log(`  Alice cells overlap with Bob cells? ${aliceCells.some(c => bobCells.includes(c))}`);

	{
		const { status } = await api(`/profiles/${encodeURIComponent(userA.did)}`, {
			method: 'PUT',
			body: JSON.stringify({ geohashCells: aliceCells })
		});
		assert(status === 200, `Alice published ${aliceCells.length} geohash cells`);
	}
	{
		const { status } = await api(`/profiles/${encodeURIComponent(userB.did)}`, {
			method: 'PUT',
			body: JSON.stringify({ geohashCells: bobCells })
		});
		assert(status === 200, `Bob published ${bobCells.length} geohash cells`);
	}

	// Verify cells were stored
	{
		const { body } = await api(`/profiles/${encodeURIComponent(userA.did)}`);
		const storedCells = JSON.parse(body.geohashCells || '[]');
		assert(storedCells.length === 9, `Alice has ${storedCells.length} cells stored`);
		assert(storedCells.includes(aliceHash), `Alice's real hash is in stored cells`);
	}

	// --- 6. Discover profiles ---
	console.log('\n6. Discover nearby profiles');
	{
		// Alice queries with her cells + some decoys
		const queryCells = [...aliceCells, 'aaaaaa', 'bbbbbb'];
		const { status, body } = await api(`/profiles/discover?cells=${queryCells.join(',')}&requesterDid=${encodeURIComponent(userA.did)}`);
		assert(status === 200, `Discovery returned ${body.length} profiles`);
		const bobFound = body.some((p: any) => p.did === userB.did);
		assert(bobFound, `Alice can see Bob: ${bobFound}`);
		if (!bobFound) {
			console.log('  DEBUG: query cells:', queryCells);
			console.log('  DEBUG: Bob cells:', bobCells);
			console.log('  DEBUG: returned profiles:', JSON.stringify(body));
		}
		const selfFound = body.some((p: any) => p.did === userA.did);
		console.log(`  Self-discovery: ${selfFound} (filtered client-side)`);
	}
	{
		// Bob queries with his cells
		const queryCells = [...bobCells, 'cccccc', 'dddddd'];
		const { body } = await api(`/profiles/discover?cells=${queryCells.join(',')}&requesterDid=${encodeURIComponent(userB.did)}`);
		const aliceFound = body.some((p: any) => p.did === userA.did);
		assert(aliceFound, `Bob can see Alice: ${aliceFound}`);
		if (aliceFound) {
			const aliceProfile = body.find((p: any) => p.did === userA.did);
			assert(!!aliceProfile.boxPublicKey, `Alice's boxPublicKey visible to Bob`);
		}
	}

	// --- 7. Derive conversation keys ---
	console.log('\n7. Derive conversation keys');
	const enc = new TextEncoder();
	const dec = new TextDecoder();

	// Alice's perspective
	const sharedA = nacl.box.before(userB.box.publicKey, userA.box.secretKey);
	const isAInitiator = userA.did < userB.did;
	const chainInit_A = await hmacSha256(sharedA, enc.encode('chain-initiator'));
	const chainResp_A = await hmacSha256(sharedA, enc.encode('chain-responder'));
	const combinedA = isAInitiator
		? new Uint8Array([...userA.box.publicKey, ...userB.box.publicKey])
		: new Uint8Array([...userB.box.publicKey, ...userA.box.publicKey]);
	const groupIdA = hexEncode(await sha256(combinedA)).slice(0, 32);

	// Bob's perspective
	const sharedB = nacl.box.before(userA.box.publicKey, userB.box.secretKey);
	const isBInitiator = userB.did < userA.did;
	const chainInit_B = await hmacSha256(sharedB, enc.encode('chain-initiator'));
	const chainResp_B = await hmacSha256(sharedB, enc.encode('chain-responder'));
	const combinedB = isBInitiator
		? new Uint8Array([...userB.box.publicKey, ...userA.box.publicKey])
		: new Uint8Array([...userA.box.publicKey, ...userB.box.publicKey]);
	const groupIdB = hexEncode(await sha256(combinedB)).slice(0, 32);

	assert(encodeBase64(sharedA) === encodeBase64(sharedB), `DH shared secrets match`);
	assert(groupIdA === groupIdB, `Group IDs match: ${groupIdA}`);
	assert(isAInitiator !== isBInitiator, `Exactly one initiator`);

	// Alice's send chain = Bob's recv chain
	const aSendChain = isAInitiator ? chainInit_A : chainResp_A;
	const aRecvChain = isAInitiator ? chainResp_A : chainInit_A;
	const bSendChain = isBInitiator ? chainInit_B : chainResp_B;
	const bRecvChain = isBInitiator ? chainResp_B : chainInit_B;

	assert(encodeBase64(aSendChain) === encodeBase64(bRecvChain), `Alice send == Bob recv chain`);
	assert(encodeBase64(aRecvChain) === encodeBase64(bSendChain), `Alice recv == Bob send chain`);

	// --- 8. Encrypt & send a message (Alice → Bob) ---
	console.log('\n8. Encrypt & send message (Alice → Bob)');
	const plaintext = 'hello bob, this is a secret message!';

	// Ratchet Alice's send chain
	const msgKeyA = await hmacSha256(aSendChain, enc.encode('msg'));
	const nextSendChainA = await hmacSha256(aSendChain, enc.encode('chain'));

	const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
	const ciphertext = nacl.secretbox(enc.encode(plaintext), nonce, msgKeyA);

	const encryptedMsg = {
		groupId: groupIdA,
		senderDid: userA.did,
		recipientDid: userB.did,
		epoch: 0,
		ciphertext: encodeBase64(ciphertext),
		nonce: encodeBase64(nonce),
	};

	assert(ciphertext.length > 0, `Ciphertext generated: ${ciphertext.length} bytes`);

	// Send via REST
	{
		const { status, body } = await api('/messages', {
			method: 'POST',
			body: JSON.stringify(encryptedMsg)
		});
		assert(status === 200, `Message stored via REST: ${JSON.stringify(body)}`);
	}

	// --- 9. Fetch messages for Bob ---
	console.log('\n9. Fetch messages for Bob');
	{
		const { status, body } = await api(`/messages?did=${encodeURIComponent(userB.did)}`);
		assert(status === 200, `Message fetch returned ${body.length} messages`);
		assert(body.length === 1, `Exactly 1 message for Bob`);

		if (body.length > 0) {
			const msg = body[0];
			assert(msg.senderDid === userA.did, `Sender is Alice`);
			assert(msg.recipientDid === userB.did, `Recipient is Bob`);
			assert(msg.groupId === groupIdA, `Group ID matches`);
			assert(msg.epoch === 0, `Epoch is 0`);

			// Decrypt
			const msgKeyB = await hmacSha256(bRecvChain, enc.encode('msg'));
			assert(encodeBase64(msgKeyA) === encodeBase64(msgKeyB), `Message keys match`);

			const decryptedBytes = nacl.secretbox.open(
				decodeBase64(msg.ciphertext),
				decodeBase64(msg.nonce),
				msgKeyB
			);
			assert(decryptedBytes !== null, `Decryption succeeded`);
			if (decryptedBytes) {
				const decryptedText = dec.decode(decryptedBytes);
				assert(decryptedText === plaintext, `Decrypted text matches: "${decryptedText}"`);
			}
		}
	}

	// --- 10. WebSocket test ---
	console.log('\n10. WebSocket relay test');
	await new Promise<void>((resolve) => {
		let wsADone = false;
		let wsBDone = false;

		const wsA = new WebSocket('ws://localhost:3000');
		const wsB = new WebSocket('ws://localhost:3000');
		let wsTestPassed = false;

		const timeout = setTimeout(() => {
			console.log('  ✗ WebSocket test timed out');
			failed++;
			wsA.close();
			wsB.close();
			resolve();
		}, 5000);

		wsB.onopen = () => {
			wsB.send(JSON.stringify({ type: 'register', did: userB.did }));
		};

		wsB.onmessage = (event) => {
			const data = JSON.parse(event.data);
			if (data.type === 'registered') {
				wsBDone = true;
				if (wsADone) sendTestMessage();
			}
			if (data.type === 'message') {
				wsTestPassed = true;
				assert(data.senderDid === userA.did, `WS: sender is Alice`);
				assert(data.recipientDid === userB.did, `WS: recipient is Bob`);
				assert(data.ciphertext !== undefined, `WS: ciphertext present`);
				clearTimeout(timeout);
				wsA.close();
				wsB.close();
				resolve();
			}
		};

		wsA.onopen = () => {
			wsA.send(JSON.stringify({ type: 'register', did: userA.did }));
		};

		wsA.onmessage = (event) => {
			const data = JSON.parse(event.data);
			if (data.type === 'registered') {
				wsADone = true;
				if (wsBDone) sendTestMessage();
			}
		};

		function sendTestMessage() {
			// Alice sends a message to Bob via WebSocket
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

	// --- 11. Test message polling with `since` param ---
	console.log('\n11. Message polling with since param');
	{
		// First, get all messages to find the latest timestamp
		const { body: allMsgs } = await api(`/messages?did=${encodeURIComponent(userB.did)}`);
		assert(allMsgs.length >= 1, `Bob has ${allMsgs.length} stored messages`);

		if (allMsgs.length > 0) {
			const lastTs = allMsgs[allMsgs.length - 1].createdAt;
			console.log(`  Last message createdAt: ${lastTs} (type: ${typeof lastTs})`);

			// Send another message
			await api('/messages', {
				method: 'POST',
				body: JSON.stringify({
					groupId: groupIdA,
					senderDid: userA.did,
					recipientDid: userB.did,
					epoch: 2,
					ciphertext: encodeBase64(nacl.randomBytes(32)),
					nonce: encodeBase64(nacl.randomBytes(24)),
				})
			});

			// Poll with since param
			const sinceValue = typeof lastTs === 'string' ? lastTs : new Date(lastTs * 1000).toISOString();
			console.log(`  Polling with since=${sinceValue}`);
			const { body: newMsgs } = await api(`/messages?did=${encodeURIComponent(userB.did)}&since=${encodeURIComponent(sinceValue)}`);
			assert(newMsgs.length >= 1, `Polling returned ${newMsgs.length} new messages after since`);

			// Check createdAt format
			if (newMsgs.length > 0) {
				const ts = newMsgs[0].createdAt;
				console.log(`  createdAt format: ${JSON.stringify(ts)} (type: ${typeof ts})`);
				if (typeof ts === 'string') {
					assert(!isNaN(new Date(ts).getTime()), `createdAt is valid ISO date: ${ts}`);
				} else if (typeof ts === 'number') {
					console.log(`  WARNING: createdAt is a number (${ts}), not ISO string!`);
					console.log(`  This will break client-side polling!`);
					failed++;
				}
			}
		}
	}

	// --- 12. Block test ---
	console.log('\n12. Block/unblock test');
	{
		// Alice blocks Bob
		const { status } = await api('/moderation/block', {
			method: 'POST',
			body: JSON.stringify({ blockerDid: userA.did, blockedDid: userB.did })
		});
		assert(status === 200, `Alice blocked Bob`);

		// Discovery should filter Bob
		const { body: filtered } = await api(`/profiles/discover?cells=${aliceCells.join(',')}&requesterDid=${encodeURIComponent(userA.did)}`);
		const bobFiltered = !filtered.some((p: any) => p.did === userB.did);
		assert(bobFiltered, `Bob is filtered from Alice's discovery after block`);

		// Unblock
		const { status: unblockStatus } = await api('/moderation/unblock', {
			method: 'POST',
			body: JSON.stringify({ blockerDid: userA.did, blockedDid: userB.did })
		});
		assert(unblockStatus === 200, `Alice unblocked Bob`);

		// Bob should be visible again
		const { body: unfiltered } = await api(`/profiles/discover?cells=${aliceCells.join(',')}&requesterDid=${encodeURIComponent(userA.did)}`);
		const bobVisible = unfiltered.some((p: any) => p.did === userB.did);
		assert(bobVisible, `Bob is visible again after unblock`);
	}

	// --- Summary ---
	console.log(`\n${'='.repeat(40)}`);
	console.log(`Results: ${passed} passed, ${failed} failed`);
	console.log(`${'='.repeat(40)}\n`);

	if (failed > 0) process.exit(1);
}

main().catch(e => {
	console.error('Test failed with error:', e);
	process.exit(1);
});
