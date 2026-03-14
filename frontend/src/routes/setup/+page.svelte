<script lang="ts">
	import { generateIdentity, saveIdentityToStorage, importIdentityBackup, loadIdentityFromStorage } from '$lib/crypto/identity';
	import type { Identity } from '$lib/crypto/identity';
	import { encodeBase64 } from '$lib/crypto/util';
	import { identityStore, broadcastIdentityChange, cacheIdentityInSession } from '$lib/stores/identity';
	import { register, subscribeNewsletter } from '$lib/api';
	import { goto } from '$app/navigation';

	let displayName = $state('');
	let creating = $state(false);
	let showDataInfo = $state(false);
	let error = $state('');
	let wantsUpdates = $state(false);
	let email = $state('');

	// If identity already exists (e.g. opened /setup in another tab), redirect away
	$effect(() => {
		if ($identityStore.identity) {
			const params = new URLSearchParams(window.location.search);
			const redirect = params.get('return') ?? params.get('redirect');
			goto(redirect?.startsWith('/') ? redirect : '/grid');
		}
	});

	async function createIdentity() {
		if (!displayName.trim()) {
			error = 'pick a name to get started';
			return;
		}

		creating = true;
		error = '';

		try {
			// If identity already exists in storage (e.g. server DB wiped but keys remain),
			// re-register with the entered display name instead of generating new keys
			const existing = await loadIdentityFromStorage();
			if (existing) {
				await register(
					existing.did,
					displayName.trim(),
					encodeBase64(existing.publicKey),
					encodeBase64(existing.boxPublicKey)
				);
				cacheIdentityInSession(existing);
				identityStore.set({ identity: existing, loading: false, error: null });
				broadcastIdentityChange();
				if (wantsUpdates && email.trim()) {
					subscribeNewsletter(email.trim(), displayName.trim()).catch(() => {});
				}
				const params = new URLSearchParams(window.location.search);
				const redirect = params.get('return') ?? params.get('redirect');
				goto(redirect?.startsWith('/') ? redirect : '/grid');
				return;
			}

			const identity = generateIdentity();
			await saveIdentityToStorage(identity);

			await register(
				identity.did,
				displayName.trim(),
				encodeBase64(identity.publicKey),
				encodeBase64(identity.boxPublicKey)
			);

			cacheIdentityInSession(identity);
			identityStore.set({ identity, loading: false, error: null });
			broadcastIdentityChange();

			if (wantsUpdates && email.trim()) {
				subscribeNewsletter(email.trim(), displayName.trim()).catch(() => {});
			}

			const params = new URLSearchParams(window.location.search);
			const redirect = params.get('return') ?? params.get('redirect');
			goto(redirect?.startsWith('/') ? redirect : '/grid');
		} catch (e) {
			error = e instanceof Error ? e.message : 'failed to create identity';
			creating = false;
		}
	}

	let importError = $state('');
	let importingBackup = $state(false);
	let setupFileInput: HTMLInputElement | undefined = $state();

	async function handleImportBackup(event: Event) {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) return;
		importingBackup = true;
		importError = '';
		try {
			const identity = await importIdentityBackup(file);
			await saveIdentityToStorage(identity);

			await register(
				identity.did,
				'user',
				encodeBase64(identity.publicKey),
				encodeBase64(identity.boxPublicKey)
			);

			cacheIdentityInSession(identity);
			identityStore.set({ identity, loading: false, error: null });
			broadcastIdentityChange();

			const params = new URLSearchParams(window.location.search);
			const redirect = params.get('return') ?? params.get('redirect');
			goto(redirect?.startsWith('/') ? redirect : '/grid');
		} catch (e) {
			importError = e instanceof Error ? e.message : 'failed to import backup';
			importingBackup = false;
		}
	}
</script>

<div class="page-container">
	<div class="page-header">
		<span class="page-title">get started</span>
	</div>
	<div class="page-content">
		<p>pick a display&nbsp;name</p>

		<form onsubmit={(e) => { e.preventDefault(); createIdentity(); }}>
			<label>
				<span class="text-label">display name</span>
				<input type="text" bind:value={displayName} autofocus />
			</label>

			<label class="checkbox-row">
				<input type="checkbox" bind:checked={wantsUpdates} />
				<span>send me project updates</span>
			</label>
			{#if wantsUpdates}
				<label>
					<span class="text-label">email</span>
					<input type="email" bind:value={email} placeholder="you@example.com" />
				</label>
				<p class="text-caption">never linked to your account.</p>
			{/if}

			{#if error}
				<p class="error">{error}</p>
			{/if}

			<button class="btn-primary" type="submit" disabled={creating}>
				{creating ? 'generating keys...' : 'enter'}
			</button>
		</form>

		<div class="warning-box">
			<p class="text-caption">Your identity is stored only on this device and can't be recovered. Clearing browser data or switching browsers will erase it. Back it up from your&nbsp;profile.</p>
		</div>

		<button class="expand-toggle" onclick={() => showDataInfo = !showDataInfo}>
			{showDataInfo ? '− ' : '+ '}how your data is (not)&nbsp;used
		</button>
		{#if showDataInfo}
			<div class="data-info">
				<p class="text-caption">DMs use a double ratchet [X25519 DH + XSalsa20-Poly1305] with forward secrecy — each message gets a fresh key. sealed sender hides who sent a DM from the server. group messages use sender keys [nacl.secretbox] so only members can read them. photos are encrypted client-side before upload — the server only stores ciphertext. profile fields [bio, age, tags] are encrypted per-profile. your location is hidden using decoy cells [geohash k-anonymity] so the server can't tell where you actually&nbsp;are.</p>
			</div>
		{/if}

		<div class="divider"></div>
		<input type="file" accept=".json" onchange={handleImportBackup} bind:this={setupFileInput} class="file-input" />
		<button onclick={() => setupFileInput?.click()} disabled={importingBackup}>
			{importingBackup ? 'importing...' : 'restore from backup'}
		</button>
		{#if importError}
			<p class="error" style="margin-top: 6px">{importError}</p>
		{/if}
	</div>
</div>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.checkbox-row {
		flex-direction: row;
		align-items: center;
		gap: 8px;
	}
	.checkbox-row input[type="checkbox"] {
		-webkit-appearance: none;
		appearance: none;
		width: 18px;
		height: 18px;
		min-width: 18px;
		min-height: 18px;
		border: 1.5px solid var(--text-muted);
		border-radius: 0;
		background: transparent;
		cursor: pointer;
		position: relative;
	}
	.checkbox-row input[type="checkbox"]:checked {
		background: var(--white);
		border-color: var(--white);
	}
	.checkbox-row input[type="checkbox"]:checked::after {
		content: '✓';
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		font-size: 13px;
		color: #000;
		line-height: 1;
	}
	.checkbox-row span {
		font-size: 14px;
		color: var(--text-muted);
	}
	.error {
		color: var(--danger);
		font-size: 14px;
	}
	.warning-box {
		padding: 12px 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-surface);
	}
	.warning-title {
		font-size: 14px;
		color: var(--text);
		margin-bottom: 4px;
	}
	.expand-toggle {
		background: none;
		border: none;
		color: var(--text-muted);
		font-size: 14px;
		padding: 0;
		cursor: pointer;
		text-align: left;
		width: 100%;
		min-height: auto;
	}
	@media (hover: hover) {
		.expand-toggle:hover {
			color: var(--text);
			background: transparent;
		}
	}
	.data-info p {
		margin-bottom: 8px;
	}
	.data-info p:last-child {
		margin-bottom: 0;
	}
	.divider {
		border-top: 1px solid var(--border);
	}
	.file-input {
		display: none;
	}
</style>
