<script lang="ts">
	import { onMount } from 'svelte';
	import { identityStore } from '$lib/stores/identity';
	import { locationStore, requestLocation } from '$lib/stores/location';
	import { listBlocks, unblockUser } from '$lib/api';
	import { wsStatus } from '$lib/services/websocket';
	import { loadIdentityFromStorage, downloadIdentityBackup } from '$lib/crypto/identity';

	let identity = $derived($identityStore);
	let location = $derived($locationStore);
	let ws = $derived($wsStatus);

	let blockedUsers = $state<Array<{ blockedDid: string; createdAt: string }>>([]);
	let myDid = $derived(identity.identity?.did);

	onMount(async () => {
		if (myDid) {
			try {
				blockedUsers = await listBlocks(myDid);
			} catch {}
		}

		// If location store is stale (e.g. after crash), check actual browser permission
		// and refresh if already granted
		try {
			const perm = await navigator.permissions.query({ name: 'geolocation' });
			if (perm.state === 'granted' && !location.geohash) {
				await requestLocation();
			}
		} catch {}
	});

	async function handleUnblock(blockedDid: string) {
		if (!myDid) return;
		try {
			await unblockUser(myDid, blockedDid);
			blockedUsers = blockedUsers.filter(b => b.blockedDid !== blockedDid);
		} catch {}
	}

	let backupDownloaded = $state(false);

	async function handleBackup() {
		try {
			const encrypted = await loadIdentityFromStorage();
			if (encrypted) {
				downloadIdentityBackup(encrypted);
				backupDownloaded = true;
				setTimeout(() => { backupDownloaded = false; }, 2000);
			}
		} catch {}
	}
</script>

<div class="settings">
	<div class="card">
		<div class="card-header">
			<span class="dot"></span>
			<span class="title">identity</span>
		</div>
		<div class="card-body">
			{#if identity.identity}
				<div class="row">
					<span class="label">did</span>
					<code class="value">{identity.identity.did}</code>
				</div>
				<div class="row">
					<span class="label">signing key</span>
					<span class="value">ed25519 ✓</span>
				</div>
				<div class="row">
					<span class="label">encryption key</span>
					<span class="value">x25519 ✓</span>
				</div>
			{:else}
				<p class="muted">no identity loaded</p>
			{/if}
			{#if identity.identity}
				<div class="backup-row">
					<button onclick={handleBackup}>
						{backupDownloaded ? 'downloaded!' : 'download backup'}
					</button>
					<span class="backup-note">encrypted with your passphrase. save it somewhere safe.</span>
				</div>
			{/if}
		</div>
	</div>

	<div class="card">
		<div class="card-header">
			<span class="dot" class:green={ws === 'connected'} class:orange={ws === 'connecting'}></span>
			<span class="title">connection</span>
		</div>
		<div class="card-body">
			<div class="row">
				<span class="label">websocket</span>
				<span class="value">{ws}</span>
			</div>
			<div class="row">
				<span class="label">server</span>
				<span class="value">localhost:3000</span>
			</div>
		</div>
	</div>

	<div class="card">
		<div class="card-header">
			<span class="dot green"></span>
			<span class="title">location privacy</span>
		</div>
		<div class="card-body">
			<div class="row">
				<span class="label">status</span>
				<span class="value">{location.permission}</span>
			</div>
			{#if location.geohash}
				<div class="row">
					<span class="label">precision</span>
					<span class="value">{location.precision} (~{location.precision === 6 ? '1.2km' : location.precision === 7 ? '150m' : '5km'})</span>
				</div>
				<div class="row">
					<span class="label">decoy cells</span>
					<span class="value">{location.queryCells.length}</span>
				</div>
				<p class="note">the server sees {location.queryCells.length} cells but can't tell which is yours.</p>
			{:else}
				<p class="note">location not active. visit the grid to enable.</p>
			{/if}
		</div>
	</div>

	{#if blockedUsers.length > 0}
		<div class="card">
			<div class="card-header">
				<span class="dot"></span>
				<span class="title">blocked users ({blockedUsers.length})</span>
			</div>
			<div class="card-body">
				{#each blockedUsers as blocked}
					<div class="row">
						<code class="value">{blocked.blockedDid.slice(0, 30)}...</code>
						<button class="small" onclick={() => handleUnblock(blocked.blockedDid)}>unblock</button>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	.settings {
		display: flex;
		flex-direction: column;
		gap: 12px;
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
		background: var(--text-muted);
	}
	.dot.green { background: var(--accent); }
	.dot.orange { background: var(--warning); }
	.title {
		color: var(--text-muted);
		font-size: 13px;
	}
	.card-body {
		padding: 16px;
	}
	.row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 0;
	}
	.label {
		color: var(--text-muted);
		font-size: 13px;
	}
	.value {
		font-size: 13px;
		max-width: 60%;
		text-align: right;
		word-break: break-all;
	}
	.note {
		margin-top: 12px;
		font-size: 11px;
		line-height: 1.5;
		color: var(--text-muted);
		border-top: 1px solid var(--border);
		padding-top: 12px;
	}
	.muted {
		color: var(--text-muted);
	}
	button.small {
		padding: 6px 12px;
		font-size: 13px;
		min-height: 36px;
	}
	.backup-row {
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.backup-note {
		color: var(--text-muted);
		font-size: 11px;
		line-height: 1.5;
	}
</style>
