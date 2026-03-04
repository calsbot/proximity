<script lang="ts">
	import { goto } from '$app/navigation';
	import { identityStore, cacheIdentityInSession, broadcastIdentityChange } from '$lib/stores/identity';
	import { getGroup, joinGroupViaInvite, register, subscribeNewsletter } from '$lib/api';
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
	let email = $state('');
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
		if (!email.trim() || !email.includes('@')) {
			signupError = 'need a valid email';
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

			subscribeNewsletter(email.trim(), displayName.trim()).catch(() => {});

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
		<div class="loading">
			<span class="pulse"></span>
		</div>
	{:else if error && !groupName}
		<div class="expired">
			<p class="expired-icon">&#x25CB;</p>
			<p class="expired-text">{error}</p>
		</div>
	{:else}
		<div class="invite-card">
			<p class="eyebrow">you've been invited</p>
			<h1 class="group-name">{groupName}</h1>
			<div class="divider"></div>
			<p class="pitch">see who's nearby.</p>
			<p class="meta">{memberCount} {memberCount === 1 ? 'person' : 'people'} already here</p>

			{#if error}
				<p class="error">{error}</p>
			{/if}

			{#if showSignup && !hasIdentity}
				<form class="signup" onsubmit={(e) => { e.preventDefault(); handleSignupAndJoin(); }}>
					<input type="text" bind:value={displayName} placeholder="your name" autofocus />
					<input type="email" bind:value={email} placeholder="email" />
					<span class="hint">for updates only. never&nbsp;shared.</span>

					{#if signupError}
						<p class="error">{signupError}</p>
					{/if}

					<button type="submit" class="join-btn" disabled={creating}>
						{creating ? 'creating...' : 'enter'}
					</button>
				</form>
			{:else}
				<button class="join-btn" onclick={handleEnter} disabled={joining}>
					{joining ? 'joining...' : 'enter'}
				</button>
			{/if}
		</div>

		<p class="footer">invitation expires after one&nbsp;use.</p>
	{/if}
</div>

<style>
	.invite-page {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: calc(100dvh - 120px);
		padding: 24px 16px;
	}
	.loading {
		display: flex;
		align-items: center;
		justify-content: center;
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
	.expired {
		text-align: center;
	}
	.expired-icon {
		font-size: 28px;
		color: var(--text-muted);
		opacity: 0.3;
		margin-bottom: 12px;
	}
	.expired-text {
		color: var(--text-muted);
		font-size: 14px;
	}
	.invite-card {
		max-width: 340px;
		width: 100%;
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.eyebrow {
		color: var(--text-muted);
		font-size: 12px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		margin-bottom: 16px;
	}
	.group-name {
		color: var(--white);
		font-size: 24px;
		font-weight: 300;
		letter-spacing: -0.02em;
		margin: 0;
		line-height: 1.3;
	}
	.divider {
		width: 32px;
		height: 1px;
		background: var(--border);
		margin: 20px 0;
	}
	.pitch {
		color: var(--text);
		font-size: 16px;
		font-weight: 300;
		margin-bottom: 4px;
	}
	.meta {
		color: var(--text-muted);
		font-size: 14px;
		margin-bottom: 28px;
	}
	.error {
		color: var(--danger);
		font-size: 14px;
		margin-bottom: 8px;
	}
	.join-btn {
		width: 100%;
		max-width: 240px;
		padding: 14px 24px;
		font-size: 14px;
		border: 1px solid var(--border);
		background: var(--white);
		color: var(--bg);
		border-radius: var(--radius);
		cursor: pointer;
		transition: opacity 0.1s;
	}
	@media (hover: hover) {
		.join-btn:hover:not(:disabled) {
			opacity: 0.85;
		}
	}
	.signup {
		width: 100%;
		max-width: 280px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.signup input {
		text-align: center;
	}
	.hint {
		font-size: 12px;
		color: var(--text-muted);
	}
	.footer {
		color: var(--text-tertiary);
		font-size: 12px;
		margin-top: 48px;
	}
</style>
