<script lang="ts">
	import { generateIdentity, saveIdentityToStorage, importIdentityBackup } from '$lib/crypto/identity';
	import type { Identity } from '$lib/crypto/identity';
	import { encodeBase64 } from '$lib/crypto/util';
	import { identityStore, broadcastIdentityChange, cacheIdentityInSession } from '$lib/stores/identity';
	import { register } from '$lib/api';
	import { goto } from '$app/navigation';

	let displayName = $state('');
	let creating = $state(false);
	let showDataInfo = $state(false);
	let error = $state('');

	async function createIdentity() {
		if (!displayName.trim()) {
			error = 'pick a name to get started';
			return;
		}

		creating = true;
		error = '';

		try {
			const identity = generateIdentity();
			await saveIdentityToStorage(identity);

			// Register with server (both Ed25519 signing key + X25519 encryption key)
			await register(
				identity.did,
				displayName.trim(),
				encodeBase64(identity.publicKey),
				encodeBase64(identity.boxPublicKey)
			);

			cacheIdentityInSession(identity);
			identityStore.set({ identity, loading: false, error: null });
			broadcastIdentityChange();

			// Navigate
			const redirect = new URLSearchParams(window.location.search).get('redirect');
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

			// Register with server
			await register(
				identity.did,
				'user',
				encodeBase64(identity.publicKey),
				encodeBase64(identity.boxPublicKey)
			);

			cacheIdentityInSession(identity);
			identityStore.set({ identity, loading: false, error: null });
			broadcastIdentityChange();

			const redirect = new URLSearchParams(window.location.search).get('redirect');
			goto(redirect?.startsWith('/') ? redirect : '/grid');
		} catch (e) {
			importError = e instanceof Error ? e.message : 'failed to import backup';
			importingBackup = false;
		}
	}
</script>

<div class="setup">
	<p class="page-title">get started</p>

	<p class="hero">no account, email, or phone&nbsp;number.</p>
	<p class="note">pick a display name. your identity is stored only on this device and can't be&nbsp;recovered.</p>

	<form onsubmit={(e) => { e.preventDefault(); createIdentity(); }}>
		<label>
			<span>display name</span>
			<input type="text" bind:value={displayName} autofocus />
		</label>

		{#if error}
			<p class="error">{error}</p>
		{/if}

		<button class="enter-btn" type="submit" disabled={creating}>
			{creating ? 'generating keys...' : 'enter'}
		</button>
	</form>

	<p class="warning"><span class="warning-label">heads up</span> — clearing browser data or switching browsers will erase it. back up from your&nbsp;profile.</p>

	<button class="expand-toggle" onclick={() => showDataInfo = !showDataInfo}>
		{showDataInfo ? '− ' : '+ '}how your data is&nbsp;used
	</button>
	{#if showDataInfo}
		<div class="data-info">
			<p>your photo, messages, and location never reach our server. nearby users see your name and photo. nothing&nbsp;else.</p>
			<p>we don't track you, sell data, or show&nbsp;ads.</p>
		</div>
	{/if}

	<div class="divider"></div>
	<input type="file" accept=".json" onchange={handleImportBackup} bind:this={setupFileInput} class="file-input" />
	<button class="restore-btn" onclick={() => setupFileInput?.click()} disabled={importingBackup}>
		{importingBackup ? 'importing...' : 'restore from backup'}
	</button>
	{#if importError}
		<p class="error" style="margin-top: 6px">{importError}</p>
	{/if}
</div>

<style>
	.setup {
		max-width: 420px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.page-title {
		color: var(--text-muted);
		font-size: 14px;
	}
	.hero {
		font-size: 16px;
		line-height: 1.5;
		color: var(--text);
	}
	.note {
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.5;
	}
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
	label span {
		font-size: 14px;
		color: var(--text-muted);
	}
	.enter-btn {
		background: var(--white);
		color: var(--bg);
		border: none;
	}
	@media (hover: hover) {
		.enter-btn:hover {
			opacity: 0.9;
		}
	}
	.error {
		color: var(--danger);
		font-size: 14px;
	}
	.warning {
		font-size: 12px;
		line-height: 1.5;
		color: var(--text-muted);
	}
	.warning-label {
		color: var(--text);
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
		font-size: 12px;
		line-height: 1.5;
		color: var(--text-muted);
		margin-bottom: 8px;
	}
	.data-info p:last-child {
		margin-bottom: 0;
	}
	.restore-btn {
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text-muted);
		font-size: 14px;
	}
	@media (hover: hover) {
		.restore-btn:hover {
			color: var(--text);
			background: var(--bg-hover);
		}
	}
	.divider {
		border-top: 1px solid var(--border);
	}
	.file-input {
		display: none;
	}
</style>
