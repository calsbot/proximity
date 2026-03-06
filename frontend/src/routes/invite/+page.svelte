<script lang="ts">
	import { goto } from '$app/navigation';
	import { identityStore, cacheIdentityInSession, broadcastIdentityChange } from '$lib/stores/identity';
	import { getGroup, joinGroupViaInvite, register } from '$lib/api';
	import { generateIdentity, saveIdentityToStorage, downloadIdentityBackup } from '$lib/crypto/identity';
	import { encodeBase64 } from '$lib/crypto/util';
	import { getOrCreateConversation } from '$lib/stores/conversations';

	let groupId = $state('');
	let inviteKey = $state('');
	let groupName = $state('');
	let memberCount = $state(0);
	let error = $state('');
	let joining = $state(false);
	let loading = $state(true);

	// Inline signup fields
	let showSignup = $state(false);
	let displayName = $state('');
	let creating = $state(false);
	let signupError = $state('');

	let myDid = $derived($identityStore.identity?.did);
	let hasIdentity = $derived(!!myDid);

	// Parse fragment on mount
	$effect(() => {
		if (typeof window === 'undefined') return;
		const hash = window.location.hash.slice(1);
		const params = new URLSearchParams(hash);
		groupId = params.get('groupId') ?? '';
		inviteKey = params.get('key') ?? '';

		if (!groupId || !inviteKey) {
			error = 'this link has expired.';
			loading = false;
			return;
		}

		getGroup(groupId)
			.then(group => {
				groupName = group.name;
				memberCount = group.members?.length ?? 0;
				loading = false;
			})
			.catch(() => {
				error = 'this link has expired.';
				loading = false;
			});
	});

	async function handleJoin() {
		if (!myDid || !groupId || !inviteKey) return;
		joining = true;
		error = '';
		try {
			await joinGroupViaInvite(groupId, myDid, inviteKey);
			// Create local conversation so it appears in messages
			getOrCreateConversation(groupId, '', groupName, '', null, true);
			goto(`/chat/${encodeURIComponent(groupId)}`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'failed to join.';
			joining = false;
		}
	}

	function handleEnter() {
		if (hasIdentity) {
			handleJoin();
		} else {
			showSignup = true;
		}
	}

	async function handleSignupAndJoin() {
		if (!displayName.trim()) {
			signupError = 'pick a name';
			return;
		}

		creating = true;
		signupError = '';

		try {
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

			try { downloadIdentityBackup(identity); } catch {}

			await joinGroupViaInvite(groupId, identity.did, inviteKey);
			// Create local conversation so it appears in messages
			getOrCreateConversation(groupId, '', groupName, '', null, true);
			goto(`/chat/${encodeURIComponent(groupId)}`);
		} catch (e) {
			signupError = e instanceof Error ? e.message : 'something went wrong.';
			creating = false;
		}
	}
</script>

<div class="invite-page">
	{#if loading}
		<span class="pulse"></span>
	{:else if error && !groupName}
		<p class="expired-text">{error}</p>
	{:else}
		<div class="page-container">
			<div class="page-header">
				<span class="page-title">{showSignup ? 'get started' : groupName}</span>
			</div>
			<div class="page-content">
				{#if showSignup && !hasIdentity}
					<p>invited to {groupName}. pick a display name to&nbsp;join.</p>

					<form onsubmit={(e) => { e.preventDefault(); handleSignupAndJoin(); }}>
						<label>
							<span class="text-label">display name</span>
							<input type="text" bind:value={displayName} autofocus />
						</label>

						{#if signupError}
							<p class="error">{signupError}</p>
						{/if}

						<button class="btn-primary" type="submit" disabled={creating}>
							{creating ? 'creating...' : 'enter'}
						</button>
					</form>
				{:else}
					<p>{memberCount} {memberCount === 1 ? 'person' : 'people'} already here</p>

					{#if error}
						<p class="error">{error}</p>
					{/if}

					<button class="btn-primary" onclick={handleEnter} disabled={joining}>
						{joining ? 'joining...' : 'enter'}
					</button>
				{/if}
			</div>
		</div>

		<p class="text-caption footer">invitation expires after one&nbsp;use.</p>
	{/if}
</div>

<style>
	.invite-page {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: calc(100dvh - 120px);
	}
	.pulse {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--white);
		animation: pulse 1.5s ease-in-out infinite;
	}
	@keyframes pulse {
		0%, 100% { opacity: 0.3; transform: scale(1); }
		50% { opacity: 1; transform: scale(1.5); }
	}
	.expired-text {
		color: var(--text-muted);
		font-size: 14px;
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
	.error {
		color: var(--danger);
		font-size: 14px;
	}
	.footer {
		margin-top: 16px;
	}
</style>
