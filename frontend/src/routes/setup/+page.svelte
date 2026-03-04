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
	<div class="card">
		<div class="card-header">
			<span class="dot green"></span>
			<span class="title">get started</span>
		</div>
		<div class="card-body">
			<p class="hero">no account, email, or phone&nbsp;number.</p>
			<p class="note">pick a name. your identity exists only on this device. if you lose it, we can't get it&nbsp;back.</p>

			<form onsubmit={(e) => { e.preventDefault(); createIdentity(); }}>
				<label>
					<span>display name</span>
					<input type="text" bind:value={displayName} autofocus />
				</label>

				{#if error}
					<p class="error">{error}</p>
				{/if}

				<button type="submit" disabled={creating}>
					{creating ? 'generating keys...' : 'enter'}
				</button>
			</form>

			<div class="warning-box">
				<p class="warning-title">heads up</p>
				<p class="warning-text">clearing browser data or switching browsers erases your identity. back it up from your&nbsp;profile.</p>
			</div>

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
			<button class="link-btn" onclick={() => setupFileInput?.click()} disabled={importingBackup}>
				{importingBackup ? 'importing...' : 'restore from backup'}
			</button>
			{#if importError}
				<p class="error" style="margin-top: 6px">{importError}</p>
			{/if}
			<p class="note restore-note">have a backup? restore it&nbsp;here.</p>
		</div>
	</div>
</div>

<style>
	.setup {
		max-width: 420px;
	}
	.card {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.card-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--border);
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}
	.dot.green {
		background: var(--accent);
	}
	.title {
		color: var(--text-muted);
		font-size: 13px;
	}
	.card-body {
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.hero {
		font-size: 14px;
		line-height: 1.5;
		color: var(--text);
	}
	.note {
		color: var(--text-muted);
		font-size: 11px;
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
		font-size: 13px;
		color: var(--text-muted);
	}
	.error {
		color: var(--danger);
		font-size: 13px;
	}
	.warning-box {
		padding: 12px 16px;
		border: 1px solid rgba(255, 170, 68, 0.2);
		border-radius: var(--radius);
		background: rgba(255, 170, 68, 0.04);
	}
	.warning-title {
		font-size: 13px;
		color: var(--warning);
		margin-bottom: 4px;
	}
	.warning-text {
		font-size: 11px;
		line-height: 1.5;
		color: var(--text-muted);
	}
	.expand-toggle {
		background: none;
		border: none;
		color: var(--text-muted);
		font-size: 13px;
		padding: 0;
		cursor: pointer;
		text-align: left;
		width: 100%;
		min-height: auto;
	}
	.expand-toggle:hover {
		color: var(--text);
		background: transparent;
	}
	.data-info p {
		font-size: 11px;
		line-height: 1.5;
		color: var(--text-muted);
		margin-bottom: 8px;
	}
	.data-info p:last-child {
		margin-bottom: 0;
	}
	.link-btn {
		color: var(--text-muted);
	}
	.link-btn:hover {
		color: var(--text);
	}
	.divider {
		border-top: 1px solid var(--border);
	}
	.file-input {
		display: none;
	}
	.restore-note {
		color: var(--text-muted);
		font-size: 11px;
		line-height: 1.5;
		margin-top: -8px;
	}
</style>
