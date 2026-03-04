<script lang="ts">
	import { goto } from '$app/navigation';
	import { conversationsStore, removeConversation } from '$lib/stores/conversations';
	import { identityStore } from '$lib/stores/identity';
	import { listPendingInvites, respondToInvite, createGroup } from '$lib/api';
	import { initChat } from '$lib/services/chat';

	let conversations = $derived($conversationsStore);
	let invites = $state<Array<{ id: string; groupId: string; inviterDid: string; groupName: string }>>([]);
	let myDid = $derived($identityStore.identity?.did);
	let loaded = $state(false);

	// Action panel
	let showPanel = $state(false);
	let panelView = $state<'menu' | 'create'>('menu');

	// Create group form
	let groupName = $state('');
	let creating = $state(false);

	$effect(() => {
		const did = myDid;
		if (!did || loaded) return;
		loaded = true;
		(async () => {
			await initChat();
			try {
				invites = await listPendingInvites(did);
			} catch {}
		})();
	});

	async function handleInvite(inviteId: string, action: 'accept' | 'decline') {
		try {
			await respondToInvite(inviteId, action);
			invites = invites.filter(i => i.id !== inviteId);
		} catch {}
	}

	async function handleCreate() {
		if (!myDid || !groupName.trim()) return;
		creating = true;
		try {
			const result = await createGroup(groupName.trim(), myDid, []);
			// Navigate to the new group chat on members tab — user can invite/share from there
			goto(`/chat/${result.groupId}?new=1`);
		} catch {
			creating = false;
		}
	}

	function closePanel() {
		showPanel = false;
		panelView = 'menu';
		groupName = '';
	}

	function lastMessagePreview(convo: (typeof conversations)[0]): string {
		if (!convo.lastMessage) return 'no messages yet';
		const last = convo.messages[convo.messages.length - 1];
		if (!last) return convo.lastMessage;
		if (last.senderDid === 'system') return convo.lastMessage;
		let preview = convo.lastMessage;
		if (last.mediaId) {
			if (last.viewed) {
				preview = last.viewOnce ? 'opened photo' : 'photo';
			} else {
				preview = last.viewOnce ? 'view-once photo' : 'photo';
			}
		}
		if (!convo.isGroup) return preview;
		if (last.isMine) return `you: ${preview}`;
		const name = last.senderName || last.senderDid?.slice(-8) || '';
		return name ? `${name}: ${preview}` : preview;
	}

	let confirmDeleteId = $state<string | null>(null);

	async function handleDeleteChat(groupId: string) {
		await removeConversation(groupId);
		confirmDeleteId = null;
	}

	function timeAgo(dateStr: string): string {
		const diff = Date.now() - new Date(dateStr).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'now';
		if (mins < 60) return `${mins}m`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h`;
		return `${Math.floor(hrs / 24)}d`;
	}
</script>

<div class="page">
	<!-- Header with + button -->
	<div class="page-header">
		<span class="page-title">messages</span>
		<button class="plus-btn" onclick={() => { showPanel = !showPanel; if (!showPanel) closePanel(); }}>
			{showPanel ? '×' : '+'}
		</button>
	</div>

	<!-- Action panel -->
	{#if showPanel}
		<div class="panel">
			{#if panelView === 'menu'}
				<button class="panel-item" onclick={() => panelView = 'create'}>
					<span class="panel-icon">+</span>
					<span>create group</span>
				</button>
			{:else if panelView === 'create'}
				<form class="create-form" onsubmit={(e) => { e.preventDefault(); handleCreate(); }}>
					<input type="text" bind:value={groupName} placeholder="group name" autofocus />
					<div class="form-actions">
						<button type="submit" disabled={creating || !groupName.trim()}>
							{creating ? 'creating...' : 'create'}
						</button>
						<button type="button" class="small muted" onclick={() => panelView = 'menu'}>back</button>
					</div>
				</form>
			{/if}
		</div>
	{/if}

	<!-- Pending invites -->
	{#if invites.length > 0}
		<div class="card">
			<div class="card-header">
				<span class="dot orange"></span>
				<span class="title">invites ({invites.length})</span>
			</div>
			<div class="card-body">
				{#each invites as invite}
					<div class="invite-row">
						<span class="name">{invite.groupName}</span>
						<div class="invite-actions">
							<button class="small" onclick={() => handleInvite(invite.id, 'accept')}>accept</button>
							<button class="small muted" onclick={() => handleInvite(invite.id, 'decline')}>decline</button>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Conversation list -->
	<div class="card">
		<div class="card-body">
			{#if conversations.length === 0}
				<p class="empty">no conversations yet. tap someone on the grid to start&nbsp;chatting.</p>
			{:else}
				{#each conversations.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()) as convo}
					<div class="row-wrapper">
						{#if confirmDeleteId === convo.groupId}
							<div class="delete-confirm">
								<span class="delete-text">delete this chat?</span>
								<button class="small danger" onclick={() => handleDeleteChat(convo.groupId)}>delete</button>
								<button class="small muted" onclick={() => confirmDeleteId = null}>cancel</button>
							</div>
						{:else}
							<a href="/chat/{convo.groupId}" class="row">
								<div class="row-top">
									<span class="name">
										{convo.peerName}
										{#if convo.isGroup}<span class="group-tag">group</span>{/if}
										{#if convo.left}<span class="group-tag left-tag">left</span>{/if}
									</span>
									<div class="row-meta">
										{#if convo.lastMessage}
											<span class="time">{timeAgo(convo.lastMessageAt)}</span>
										{/if}
										{#if convo.unreadCount > 0}
											<span class="badge">{convo.unreadCount}</span>
										{/if}
										<button class="delete-btn" onclick={(e) => { e.preventDefault(); e.stopPropagation(); confirmDeleteId = convo.groupId; }} title="delete chat">×</button>
									</div>
								</div>
								<span class="preview">{lastMessagePreview(convo)}</span>
							</a>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.page-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.page-title {
		color: var(--text-muted);
		font-size: 13px;
	}
	.plus-btn {
		width: 44px;
		height: 44px;
		border-radius: var(--radius);
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text);
		font-size: 18px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		padding: 0;
		line-height: 1;
	}
	.plus-btn:hover {
		background: var(--bg-hover);
	}

	/* Panel */
	.panel {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.panel-item {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		background: transparent;
		border: none;
		border-radius: 0;
		color: var(--text);
		cursor: pointer;
		font-size: 13px;
		text-align: left;
		min-height: 44px;
		width: 100%;
	}
	.panel-item:hover {
		background: var(--bg-hover);
	}
	.panel-icon {
		font-size: 16px;
		width: 20px;
		text-align: center;
		color: var(--text-muted);
	}
	.create-form {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
	}
	.form-actions {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	/* Cards */
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
	.dot.orange { background: var(--warning); }
	.title {
		color: var(--text-muted);
		font-size: 13px;
	}
	.card-body {
		padding: 0;
	}
	.empty {
		color: var(--text-muted);
		text-align: center;
		padding: 32px 16px;
		font-size: 13px;
	}

	/* Conversation rows */
	.row {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 12px 16px;
		text-decoration: none;
		min-height: 44px;
		justify-content: center;
	}
	.row:hover { background: var(--bg-hover); }
	.row-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.name {
		color: var(--text);
		font-size: 13px;
		display: flex;
		align-items: center;
		gap: 6px;
		line-height: 1.4;
	}
	.group-tag {
		font-size: 11px;
		color: var(--text-muted);
		border: 1px solid var(--border);
		padding: 1px 6px;
		border-radius: 4px;
	}
	.left-tag {
		color: var(--danger);
		border-color: var(--danger);
		opacity: 0.6;
	}
	.preview {
		color: var(--text-muted);
		font-size: 13px;
		line-height: 1.4;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.row-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}
	.time {
		color: var(--text-muted);
		font-size: 13px;
	}
	.badge {
		background: var(--text);
		color: var(--bg);
		font-size: 11px;
		padding: 2px 7px;
		border-radius: 10px;
		font-weight: 600;
	}

	/* Invites */
	.invite-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 16px;
		min-height: 44px;
	}
	.invite-row:not(:last-child) {
		border-bottom: 1px solid var(--border);
	}
	.invite-actions { display: flex; gap: 8px; }
	button.small { padding: 6px 12px; font-size: 13px; min-height: 36px; }
	button.muted { color: var(--text-muted); border-color: transparent; }
	button.danger { color: var(--danger); border-color: var(--danger); }

	/* Row wrappers */
	.row-wrapper {
		border-bottom: 1px solid var(--border);
	}
	.row-wrapper:last-child {
		border-bottom: none;
	}
	.delete-btn {
		border: none;
		background: transparent;
		color: var(--text-muted);
		font-size: 16px;
		padding: 0 4px;
		cursor: pointer;
		opacity: 0;
		transition: opacity 0.15s;
		min-height: 28px;
		min-width: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		line-height: 1;
	}
	.row-wrapper:hover .delete-btn {
		opacity: 0.5;
	}
	.delete-btn:hover {
		opacity: 1 !important;
		color: var(--danger);
	}
	.delete-confirm {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 16px;
		min-height: 44px;
	}
	.delete-text {
		color: var(--text-muted);
		font-size: 13px;
		flex: 1;
	}
</style>
