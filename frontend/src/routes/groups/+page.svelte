<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { identityStore } from '$lib/stores/identity';
	import { conversationsStore } from '$lib/stores/conversations';
	import { listGroups, createGroup, listPendingInvites, respondToInvite, discoverProfiles, searchProfiles, setInviteLinkHash } from '$lib/api';
	import { randomHex, sha256Hex } from '$lib/crypto/util';
	import { locationStore } from '$lib/stores/location';

	interface Group {
		id: string;
		name: string;
		creatorDid: string;
		role: string;
		members: Array<{ did: string; role: string }>;
		createdAt: string;
	}

	let groups = $state<Group[]>([]);
	let invites = $state<Array<{ id: string; groupId: string; inviterDid: string; groupName: string }>>([]);
	let loading = $state(true);

	// Create group form
	let showCreate = $state(false);
	let groupName = $state('');
	let creating = $state(false);
	let createdInviteLink = $state('');
	let createdGroupId = $state('');
	let createdGroupName = $state('');

	// Invite search
	let nearbyProfiles = $state<Array<{ did: string; displayName: string }>>([]);
	let searchQuery = $state('');
	let searchResults = $state<Array<{ did: string; displayName: string }>>([]);
	let searching = $state(false);
	let searchTimer: ReturnType<typeof setTimeout> | null = null;
	let selectedInvitees = $state<string[]>([]);
	let selectedInviteeNames = $state<Map<string, string>>(new Map());

	let myDid = $derived($identityStore.identity?.did);
	let loaded = $state(false);

	// Left groups from conversations store
	let leftGroups = $derived(
		$conversationsStore
			.filter(c => c.isGroup && c.left)
			.map(c => ({ id: c.groupId, name: c.peerName }))
	);

	$effect(() => {
		const did = myDid;
		if (!did || loaded) return;
		loaded = true;
		(async () => {
			try {
				[groups, invites] = await Promise.all([
					listGroups(did),
					listPendingInvites(did),
				]);

				const contactMap = new Map<string, string>();
				const convos = $conversationsStore;
				for (const c of convos) {
					if (c.peerDid && c.peerDid !== did && !c.isGroup) {
						contactMap.set(c.peerDid, c.peerName);
					}
				}

				const loc = $locationStore;
				if (loc.queryCells.length > 0) {
					try {
						const profiles = await discoverProfiles(loc.queryCells, did);
						for (const p of profiles) {
							if (p.did !== did) contactMap.set(p.did, p.displayName);
						}
					} catch {}
				}

				nearbyProfiles = Array.from(contactMap.entries()).map(([did, displayName]) => ({
					did, displayName,
				}));
			} catch {}
			loading = false;
		})();
	});

	async function handleCreate() {
		if (!myDid || !groupName.trim()) return;
		creating = true;
		try {
			const result = await createGroup(groupName.trim(), myDid, selectedInvitees);
			const key = randomHex(16);
			const hash = await sha256Hex(key);
			await setInviteLinkHash(result.groupId, myDid, hash);
			createdInviteLink = `${window.location.origin}/invite#groupId=${encodeURIComponent(result.groupId)}&key=${encodeURIComponent(key)}`;
			createdGroupId = result.groupId;
			createdGroupName = groupName.trim();
			groups = await listGroups(myDid);
		} catch {} finally {
			creating = false;
		}
	}

	async function handleInvite(inviteId: string, action: 'accept' | 'decline') {
		try {
			const result = await respondToInvite(inviteId, action);
			invites = invites.filter(i => i.id !== inviteId);
			if (action === 'accept' && result.groupId) {
				if (myDid) groups = await listGroups(myDid);
			}
		} catch {}
	}

	function toggleInvitee(did: string, displayName: string) {
		if (selectedInvitees.includes(did)) {
			selectedInvitees = selectedInvitees.filter(d => d !== did);
			const next = new Map(selectedInviteeNames);
			next.delete(did);
			selectedInviteeNames = next;
		} else {
			selectedInvitees = [...selectedInvitees, did];
			selectedInviteeNames = new Map(selectedInviteeNames).set(did, displayName);
		}
	}

	let copiedGroupId = $state('');

	async function copyInviteLink(groupId: string) {
		if (!myDid) return;
		const key = randomHex(16);
		const hash = await sha256Hex(key);
		await setInviteLinkHash(groupId, myDid, hash);
		const url = `${window.location.origin}/invite#groupId=${encodeURIComponent(groupId)}&key=${encodeURIComponent(key)}`;
		await navigator.clipboard.writeText(url);
		copiedGroupId = groupId;
		setTimeout(() => { copiedGroupId = ''; }, 2000);
	}

	async function shareInviteLink(groupId: string, name: string) {
		if (!myDid) return;
		const key = randomHex(16);
		const hash = await sha256Hex(key);
		await setInviteLinkHash(groupId, myDid, hash);
		const url = `${window.location.origin}/invite#groupId=${encodeURIComponent(groupId)}&key=${encodeURIComponent(key)}`;

		if (typeof navigator.share !== 'undefined') {
			try {
				await navigator.share({
					title: `Join ${name}`,
					text: `You're invited to ${name}. Tap to join and see who's nearby.`,
					url,
				});
				return;
			} catch {}
		}
		// Fallback to clipboard
		await navigator.clipboard.writeText(url);
		copiedGroupId = groupId;
		setTimeout(() => { copiedGroupId = ''; }, 2000);
	}

	function handleSearchInput(value: string) {
		searchQuery = value;
		if (searchTimer) clearTimeout(searchTimer);
		if (!value.trim()) {
			searchResults = [];
			return;
		}
		searching = true;
		searchTimer = setTimeout(async () => {
			try {
				searchResults = await searchProfiles(value.trim(), myDid);
			} catch {
				searchResults = [];
			}
			searching = false;
		}, 300);
	}
</script>

<div class="page">
	{#if invites.length > 0}
		<div class="card">
			<div class="card-header">
				<span class="dot orange"></span>
				<span class="title">pending invites ({invites.length})</span>
			</div>
			<div class="card-body">
				{#each invites as invite}
					<div class="invite-row">
						<span class="name">{invite.groupName}</span>
						<div class="actions">
							<button class="small" onclick={() => handleInvite(invite.id, 'accept')}>accept</button>
							<button class="small muted" onclick={() => handleInvite(invite.id, 'decline')}>decline</button>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<div class="card">
		<div class="card-header">
			<span class="dot"></span>
			<span class="title">groups</span>
			<button class="small header-btn" onclick={() => showCreate = !showCreate}>
				{showCreate ? 'cancel' : 'new group'}
			</button>
		</div>
		<div class="card-body">
			{#if showCreate}
				<div class="create-form">
					{#if createdInviteLink}
						<p class="created-title">{createdGroupName}</p>
						<p class="share-pitch">share this link — members can see who's nearby.</p>

						<div class="invite-link-box">
							<code class="invite-link">{createdInviteLink}</code>
						</div>

						<div class="share-actions">
							<button onclick={() => shareInviteLink(createdGroupId, createdGroupName)}>
								share
							</button>
							<button class="secondary" onclick={async () => { await navigator.clipboard.writeText(createdInviteLink); copiedGroupId = createdGroupId; setTimeout(() => { copiedGroupId = ''; }, 2000); }}>
								{copiedGroupId === createdGroupId ? 'copied!' : 'copy link'}
							</button>
						</div>

						<button class="secondary" onclick={() => goto(`/chat/${createdGroupId}`)}>open chat</button>
						<button class="small muted done-btn" onclick={() => { showCreate = false; createdInviteLink = ''; createdGroupId = ''; createdGroupName = ''; groupName = ''; selectedInvitees = []; selectedInviteeNames = new Map(); }}>done</button>
					{:else}
					<input type="text" bind:value={groupName} placeholder="group name" />

					<p class="label">invite people:</p>

					{#if selectedInvitees.length > 0}
						<div class="invitee-list">
							{#each selectedInvitees as did}
								<button
									class="invitee-chip selected"
									onclick={() => toggleInvitee(did, '')}
								>
									{selectedInviteeNames.get(did) ?? did.slice(-8)} &times;
								</button>
							{/each}
						</div>
					{/if}

					<input
						type="text"
						value={searchQuery}
						oninput={(e) => handleSearchInput(e.currentTarget.value)}
						placeholder="search by name..."
					/>

					{#if searchResults.length > 0}
						<div class="invitee-list">
							{#each searchResults as profile}
								{#if !selectedInvitees.includes(profile.did)}
									<button
										class="invitee-chip"
										onclick={() => { toggleInvitee(profile.did, profile.displayName); searchQuery = ''; searchResults = []; }}
									>
										{profile.displayName}
									</button>
								{/if}
							{/each}
						</div>
					{:else if nearbyProfiles.length > 0 && !searchQuery}
						<div class="invitee-list">
							{#each nearbyProfiles as profile}
								{#if !selectedInvitees.includes(profile.did)}
									<button
										class="invitee-chip"
										onclick={() => toggleInvitee(profile.did, profile.displayName)}
									>
										{profile.displayName}
									</button>
								{/if}
							{/each}
						</div>
					{/if}

					<button onclick={handleCreate} disabled={creating || !groupName.trim()}>
						{creating ? 'creating...' : 'create group'}
					</button>
					{/if}
				</div>
			{:else if loading}
				<p class="status">loading...</p>
			{:else if groups.length === 0}
				<p class="status">no groups yet. create one to get started.</p>
			{:else}
				<div class="list">
					{#each groups as group}
						<div class="group-row">
							<a href="/chat/{group.id}" class="row">
								<div class="row-left">
									<span class="name">{group.name}</span>
									<span class="meta">{group.members.length} members</span>
								</div>
								<span class="role">{group.role}</span>
							</a>
							<div class="row-actions">
								<button
									class="small link-btn"
									onclick={(e) => { e.preventDefault(); shareInviteLink(group.id, group.name); }}
								>
									send invitation
								</button>
								<button
									class="small link-btn"
									onclick={(e) => { e.preventDefault(); copyInviteLink(group.id); }}
								>
									{copiedGroupId === group.id ? 'copied!' : 'copy link'}
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	{#if leftGroups.length > 0}
		<div class="card">
			<div class="card-header">
				<span class="dot muted-dot"></span>
				<span class="title">left groups</span>
			</div>
			<div class="card-body">
				<div class="list">
					{#each leftGroups as group}
						<div class="group-row">
							<a href="/chat/{group.id}" class="row">
								<div class="row-left">
									<span class="name">{group.name}</span>
								</div>
								<span class="role left-role">left</span>
							</a>
						</div>
					{/each}
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.page {
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
		padding: 10px 14px;
		border-bottom: 1px solid var(--border);
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-muted);
	}
	.dot.orange { background: #ffaa44; }
	.title {
		color: var(--text-muted);
		font-size: 12px;
	}
	.header-btn {
		margin-left: auto;
		padding: 3px 8px;
		font-size: 11px;
	}
	.card-body {
		padding: 16px;
	}
	.status {
		color: var(--text-muted);
		text-align: center;
		padding: 24px 0;
	}
	.list {
		display: flex;
		flex-direction: column;
	}
	.group-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 0;
		border-bottom: 1px solid var(--border);
	}
	.group-row:last-child { border-bottom: none; }
	.row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex: 1;
		text-decoration: none;
	}
	.row:hover { opacity: 0.7; }
	.row-actions {
		display: flex;
		gap: 4px;
		flex-shrink: 0;
	}
	.link-btn {
		flex-shrink: 0;
		color: var(--text-muted);
	}
	.row-left {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.name { color: var(--text); font-size: 13px; line-height: 1.3; }
	.meta { color: var(--text-muted); font-size: 12px; line-height: 1.3; }
	.role {
		color: var(--text-muted);
		font-size: 10px;
		line-height: 1.4;
		border: 1px solid var(--border);
		padding: 1px 5px;
		border-radius: 4px;
	}
	.invite-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 0;
		border-bottom: 1px solid var(--border);
	}
	.invite-row:last-child { border-bottom: none; }
	.actions { display: flex; gap: 6px; }
	button.small { padding: 4px 10px; font-size: 11px; }
	button.muted { color: var(--text-muted); border-color: transparent; }

	.create-form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.created-title {
		color: var(--text);
		font-size: 16px;
		font-weight: 600;
	}
	.share-pitch {
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.5;
	}
	.share-actions {
		display: flex;
		gap: 8px;
	}
	.share-actions button {
		flex: 1;
	}
	.secondary {
		background: transparent;
		border-color: var(--border);
		color: var(--text-muted);
	}
	.secondary:hover {
		color: var(--text);
		border-color: var(--text-muted);
	}
	.done-btn {
		align-self: flex-start;
	}
	.label {
		color: var(--text-muted);
		font-size: 11px;
		margin-top: 4px;
	}
	.invitee-list {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.invitee-chip {
		padding: 4px 10px;
		font-size: 11px;
		border-radius: 16px;
	}
	.invitee-chip.selected {
		background: rgba(255,255,255,0.1);
		border-color: var(--text);
	}
	.invite-link-box {
		padding: 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.invite-link {
		font-size: 11px;
		color: var(--text-muted);
		word-break: break-all;
		line-height: 1.5;
	}
	.muted-dot { background: var(--border); }
	.left-role {
		color: var(--danger, #ff4444);
		border-color: var(--danger, #ff4444);
		opacity: 0.6;
	}
</style>
