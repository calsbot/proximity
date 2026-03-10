<script lang="ts">
	import { identityStore } from '$lib/stores/identity';
	import { locationStore, requestLocation } from '$lib/stores/location';
	import { updateProfile, getProfile, uploadMedia, getMedia, getMediaBlob, listBlocks, unblockUser, subscribeNewsletter, BASE } from '$lib/api';
	import { encryptMedia, decryptMedia, fileToUint8Array, bytesToObjectUrl } from '$lib/crypto/media';
	import { loadIdentityFromStorage, downloadIdentityBackup } from '$lib/crypto/identity';
	import { wsStatus } from '$lib/services/websocket';
	import ImageCropper from '$lib/components/ImageCropper.svelte';

	let displayName = $state('');
	let bio = $state('');
	let age = $state('');
	let saving = $state(false);
	let saved = $state(false);
	let error = $state('');
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let initialLoad = $state(true);

	// Photo upload
	let avatarUrl = $state<string | null>(null);
	let uploading = $state(false);
	let showCropper = $state(false);
	let cropFile = $state<File | null>(null);

	let myDid = $derived($identityStore.identity?.did);
	let identity = $derived($identityStore);
	let location = $derived($locationStore);
	let ws = $derived($wsStatus);
	let loaded = $state(false);

	// Settings sections
	let blockedUsers = $state<Array<{ blockedDid: string; createdAt: string }>>([]);
	let backupDownloaded = $state(false);
	let showIdentity = $state(false);
	let showLocation = $state(false);
	let showBlocked = $state(false);
	let wantsUpdates = $state(false);
	let updateEmail = $state('');
	let subscribing = $state(false);
	let subscribed = $state(false);

	$effect(() => {
		const did = myDid;
		if (!did || loaded) return;
		loaded = true;
		(async () => {
			try {
				const profile = await getProfile(did);
				displayName = profile.displayName ?? '';
				bio = profile.bio ?? '';
				age = profile.age ? String(profile.age) : '';

					// Mark initial load complete after a tick so auto-save doesn't fire
				setTimeout(() => { initialLoad = false; }, 100);

				if (profile.avatarMediaId && profile.avatarKey && profile.avatarNonce) {
					// Decrypt the encrypted avatar
					try {
						const encryptedBuf = await getMediaBlob(profile.avatarMediaId);
						const decrypted = decryptMedia(new Uint8Array(encryptedBuf), profile.avatarNonce, profile.avatarKey);
						avatarUrl = bytesToObjectUrl(decrypted, 'image/jpeg');
					} catch {
						avatarUrl = null;
					}
				} else if (profile.avatarMediaId) {
					// Legacy unencrypted avatar
					avatarUrl = `${BASE}/media/${profile.avatarMediaId}/blob`;
				}
			} catch {}

			// Load blocked users
			try {
				blockedUsers = await listBlocks(did);
			} catch {}

			// Refresh location if permission already granted
			try {
				const perm = await navigator.permissions.query({ name: 'geolocation' });
				if (perm.state === 'granted' && !location.geohash) {
					await requestLocation();
				}
			} catch {}
		})();
	});

	// Auto-save on field changes (debounced)
	$effect(() => {
		// Track reactive deps
		const _name = displayName;
		const _bio = bio;
		const _age = age;

		// Skip the initial load — only save on user edits
		if (initialLoad) return;
		if (!myDid) return;

		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			autoSave();
		}, 800);
	});

	async function autoSave() {
		if (!myDid) return;
		saving = true;
		saved = false;
		error = '';

		try {
			await updateProfile(myDid, {
				displayName: displayName.trim() || undefined,
				bio: bio.trim(),
				age: age ? parseInt(age) : undefined,
			});
			saved = true;
			setTimeout(() => saved = false, 2000);
		} catch (e) {
			error = e instanceof Error ? e.message : 'failed to save';
		} finally {
			saving = false;
		}
	}

	function handleFileSelect(e: Event) {
		const target = e.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file || !myDid) return;

		if (!file.type.startsWith('image/')) {
			error = 'please select an image file';
			return;
		}
		if (file.size > 50 * 1024 * 1024) {
			error = 'image must be under 50MB';
			return;
		}

		cropFile = file;
		showCropper = true;
		error = '';
		target.value = '';
	}

	async function handleCrop(blob: Blob) {
		showCropper = false;
		cropFile = null;
		if (!myDid) return;

		uploading = true;
		error = '';

		try {
			// Encrypt the photo client-side before uploading
			const plainBytes = await fileToUint8Array(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
			const { encryptedBlob, nonce, key } = encryptMedia(plainBytes);

			// Upload the encrypted blob (server never sees the plaintext)
			const encryptedFile = new Blob([encryptedBlob], { type: 'application/octet-stream' });
			const result = await uploadMedia(myDid, encryptedFile, 'image/jpeg');

			// Store the decryption key + nonce on the profile so others can decrypt
			await updateProfile(myDid, {
				avatarMediaId: result.mediaId,
				avatarKey: key,
				avatarNonce: nonce,
			});

			// Show the local unencrypted blob for immediate feedback
			avatarUrl = URL.createObjectURL(blob);
		} catch (e) {
			error = e instanceof Error ? e.message : 'upload failed';
		} finally {
			uploading = false;
		}
	}

	function handleCropCancel() {
		showCropper = false;
		cropFile = null;
	}

	async function handleUnblock(blockedDid: string) {
		if (!myDid) return;
		try {
			await unblockUser(myDid, blockedDid);
			blockedUsers = blockedUsers.filter(b => b.blockedDid !== blockedDid);
		} catch {}
	}

	async function handleSubscribe() {
		if (!updateEmail.trim()) return;
		subscribing = true;
		try {
			await subscribeNewsletter(updateEmail.trim(), displayName.trim() || 'User');
			subscribed = true;
			setTimeout(() => { subscribed = false; }, 2000);
		} catch {}
		subscribing = false;
	}

	async function handleBackup() {
		try {
			const id = await loadIdentityFromStorage();
			if (id) {
				downloadIdentityBackup(id);
				backupDownloaded = true;
				setTimeout(() => { backupDownloaded = false; }, 2000);
			}
		} catch {}
	}
</script>

{#if showCropper && cropFile}
	<ImageCropper file={cropFile} oncrop={handleCrop} oncancel={handleCropCancel} />
{/if}

<div class="page">
	<!-- Profile edit card -->
	<div class="page-container">
		<div class="page-header">
			<span class="page-title">edit profile</span>
		</div>
		<div class="page-content">
			<div class="avatar-section">
				{#if avatarUrl}
					<img src={avatarUrl} alt="avatar" class="avatar" />
				{:else}
					<div class="avatar-placeholder">?</div>
				{/if}
				<label class="upload-btn">
					<input type="file" accept="image/*" onchange={handleFileSelect} hidden />
					{uploading ? 'uploading...' : 'upload photo'}
				</label>
				<p class="text-caption">your photo is encrypted locally before&nbsp;upload.</p>
			</div>

			<div class="fields">
				<label>
					<span>display name</span>
					<input type="text" bind:value={displayName} />
				</label>

				<label>
					<span>age</span>
					<input type="number" bind:value={age} min="18" max="120" />
				</label>

				<label>
					<span>bio</span>
					<textarea bind:value={bio} rows="3" placeholder="tell people about yourself"></textarea>
				</label>

				<div class="save-status">
					{#if saving}
						<span class="status-text">saving...</span>
					{:else if saved}
						<span class="status-text success">saved</span>
					{:else if error}
						<span class="status-text error">{error}</span>
					{/if}
				</div>

				<button class="btn-primary" onclick={handleBackup}>
					{backupDownloaded ? 'downloaded!' : 'back up profile'}
				</button>
				<span class="text-caption">Save your identity file. It can't be recovered if&nbsp;lost.</span>
			</div>
		</div>
	</div>

	<!-- Email updates -->
	<div class="card">
		<div class="card-body">
			<label class="checkbox-row">
				<input type="checkbox" bind:checked={wantsUpdates} />
				<span>send me project updates</span>
			</label>
			{#if wantsUpdates}
				<label>
					<span class="info-label">email</span>
					<input type="email" bind:value={updateEmail} placeholder="you@example.com" />
				</label>
				<p class="info-note" style="margin-top: 8px; border-top: none; padding-top: 0;">never linked to your account.</p>
				<button class="btn-primary" onclick={handleSubscribe} disabled={subscribing || !updateEmail.trim()}>
					{subscribing ? 'subscribing...' : subscribed ? 'subscribed!' : 'subscribe'}
				</button>
			{/if}
		</div>
	</div>

	<!-- Identity & backup -->
	<div class="card">
		<button class="card-header toggle-header" onclick={() => showIdentity = !showIdentity}>
			<span class="dot" class:green={!!identity.identity}></span>
			<span class="title">identity</span>
			<span class="chevron">{showIdentity ? '−' : '+'}</span>
		</button>
		{#if showIdentity}
			<div class="card-body">
				{#if identity.identity}
					<div class="info-row">
						<span class="info-label">did</span>
						<code class="info-value">{identity.identity.did}</code>
					</div>
					<div class="info-row">
						<span class="info-label">signing key</span>
						<span class="info-value">ed25519</span>
					</div>
					<div class="info-row">
						<span class="info-label">encryption key</span>
						<span class="info-value">x25519</span>
					</div>
					<div class="info-row">
						<span class="info-label">websocket</span>
						<span class="info-value">{ws}</span>
					</div>
					{:else}
					<p class="muted">no identity loaded</p>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Location privacy -->
	<div class="card">
		<button class="card-header toggle-header" onclick={() => showLocation = !showLocation}>
			<span class="title">location privacy</span>
			<span class="chevron">{showLocation ? '−' : '+'}</span>
		</button>
		{#if showLocation}
			<div class="card-body">
				<div class="info-row">
					<span class="info-label">status</span>
					<span class="info-value">{location.permission}</span>
				</div>
				{#if location.geohash}
					<div class="info-row">
						<span class="info-label">precision</span>
						<span class="info-value">{location.precision} (~{location.precision === 6 ? '1.2km' : location.precision === 7 ? '150m' : '5km'})</span>
					</div>
					<div class="info-row">
						<span class="info-label">decoy cells</span>
						<span class="info-value">{location.queryCells.length}</span>
					</div>
					<p class="info-note">the server sees {location.queryCells.length} cells but can't tell which is&nbsp;yours.</p>
				{:else}
					<p class="info-note">location not active. visit the grid to&nbsp;enable.</p>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Blocked users -->
	{#if blockedUsers.length > 0}
		<div class="card">
			<button class="card-header toggle-header" onclick={() => showBlocked = !showBlocked}>
				<span class="title">blocked users ({blockedUsers.length})</span>
				<span class="chevron">{showBlocked ? '−' : '+'}</span>
			</button>
			{#if showBlocked}
				<div class="card-body">
					{#each blockedUsers as blocked}
						<div class="info-row">
							<code class="info-value">{blocked.blockedDid.slice(0, 30)}...</code>
							<button class="small" onclick={() => handleUnblock(blocked.blockedDid)}>unblock</button>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	/* Secondary cards (collapsible sections) */
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
	.toggle-header {
		cursor: pointer;
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--border);
		width: 100%;
		text-align: left;
		font-family: inherit;
		font-size: inherit;
		min-height: 48px;
		border-radius: 0;
	}
	@media (hover: hover) {
		.toggle-header:hover {
			background: var(--bg-hover);
		}
	}
	.chevron {
		margin-left: auto;
		color: var(--text-muted);
		font-size: 14px;
	}
	.title {
		color: var(--text-muted);
		font-size: 14px;
	}
	/* card-body for collapsible sections */
	.card-body {
		padding: 16px;
	}

	/* Avatar */
	.avatar-section {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 12px;
		margin-bottom: 16px;
	}
	.avatar {
		width: 80px;
		height: 107px;
		border-radius: var(--radius);
		object-fit: cover;
		border: 1px solid var(--border);
	}
	.avatar-placeholder {
		width: 80px;
		height: 107px;
		border-radius: var(--radius);
		border: 1px solid var(--border);
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
		font-size: 24px;
	}
	.upload-btn {
		cursor: pointer;
		border: 1px solid var(--border);
		padding: 12px 16px;
		border-radius: var(--radius);
		font-size: 14px;
		color: var(--text);
		transition: background 0.1s;
		min-height: 48px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	@media (hover: hover) {
		.upload-btn:hover {
			background: var(--bg-hover);
		}
	}
	/* photo-note and backup-note now use global .text-caption */

	/* Fields */
	.fields {
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
	textarea {
		resize: vertical;
	}
	.save-status {
		min-height: 18px;
	}
	.status-text {
		font-size: 14px;
		color: var(--text-muted);
	}
	.status-text.success {
		color: var(--text);
	}
	.status-text.error {
		color: var(--danger);
	}

	/* Info rows */
	.info-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 10px 0;
	}
	.info-label {
		color: var(--text-muted);
		font-size: 14px;
	}
	.info-value {
		font-size: 14px;
		max-width: 60%;
		text-align: right;
		word-break: break-all;
	}
	.info-note {
		margin-top: 12px;
		font-size: 12px;
		line-height: 1.5;
		color: var(--text-muted);
		border-top: 1px solid var(--border);
		padding-top: 12px;
	}
	.muted {
		color: var(--text-muted);
	}
	.checkbox-row {
		flex-direction: row;
		align-items: center;
		gap: 8px;
	}
	.checkbox-row input[type="checkbox"] {
		width: 16px;
		height: 16px;
		accent-color: var(--white);
	}
	.checkbox-row span {
		font-size: 14px;
		color: var(--text-muted);
	}
</style>
