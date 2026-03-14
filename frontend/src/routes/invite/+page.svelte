<script lang="ts">
	import { goto } from '$app/navigation';
	import { identityStore, broadcastIdentityChange, cacheIdentityInSession } from '$lib/stores/identity';
	import { generateIdentity, saveIdentityToStorage, loadIdentityFromStorage } from '$lib/crypto/identity';
	import { encodeBase64 } from '$lib/crypto/util';
	import { getGroup, joinGroupViaInvite, register, subscribeNewsletter } from '$lib/api';
	import { getOrCreateConversation } from '$lib/stores/conversations';

	let groupId = $state('');
	let inviteKey = $state('');
	let groupName = $state('');
	let memberCount = $state(0);
	let error = $state('');
	let joining = $state(false);
	let loading = $state(true);
	let showSignup = $state(false);
	let displayName = $state('');
	let creating = $state(false);
	let wantsUpdates = $state(false);
	let email = $state('');

	let myDid = $derived($identityStore.identity?.did);
	let identityLoading = $derived($identityStore.loading);

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

	function handleEnter() {
		if (myDid) {
			handleJoin();
		} else {
			showSignup = true;
		}
	}

	async function handleJoin() {
		const did = myDid;
		if (!did || !groupId || !inviteKey) return;
		joining = true;
		error = '';
		try {
			await joinGroupViaInvite(groupId, did, inviteKey);
			getOrCreateConversation(groupId, '', groupName, '', null, true);
			goto(`/chat/${encodeURIComponent(groupId)}`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'failed to join.';
			joining = false;
		}
	}

	async function handleSignupAndJoin() {
		if (!displayName.trim()) {
			error = 'pick a name to get started';
			return;
		}

		creating = true;
		error = '';

		try {
			// Guard: don't overwrite an existing identity
			const existing = await loadIdentityFromStorage();
			if (existing) {
				cacheIdentityInSession(existing);
				identityStore.set({ identity: existing, loading: false, error: null });
				// Now join with existing identity
				await joinGroupViaInvite(groupId, existing.did, inviteKey);
				getOrCreateConversation(groupId, '', groupName, '', null, true);
				goto(`/chat/${encodeURIComponent(groupId)}`);
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

			// Now join the group
			await joinGroupViaInvite(groupId, identity.did, inviteKey);
			getOrCreateConversation(groupId, '', groupName, '', null, true);
			goto(`/chat/${encodeURIComponent(groupId)}`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'failed to create account';
			creating = false;
		}
	}
</script>

<div class="invite-page">
	{#if loading || identityLoading}
		<span class="pulse"></span>
	{:else if error && !groupName}
		<p class="expired-text">{error}</p>
	{:else}
		<div class="page-container">
			<div class="page-header">
				<span class="page-title">{groupName}</span>
			</div>
			<div class="page-content">
				<p>{memberCount} {memberCount === 1 ? 'person' : 'people'} already here</p>

				{#if error}
					<p class="error">{error}</p>
				{/if}

				{#if showSignup}
					<form onsubmit={(e) => { e.preventDefault(); handleSignupAndJoin(); }}>
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
						<button class="btn-primary" type="submit" disabled={creating}>
							{creating ? 'generating keys...' : 'join'}
						</button>
					</form>
				{:else}
					<button class="btn-primary" onclick={handleEnter} disabled={joining}>
						{joining ? 'joining...' : 'enter'}
					</button>
				{/if}
			</div>
		</div>
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
	.error {
		color: var(--danger);
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
		content: '\2713';
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
</style>
