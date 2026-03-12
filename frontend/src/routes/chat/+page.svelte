<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import { conversationsStore, removeConversation, unmarkConversationLeft, resetSealedSender } from '$lib/stores/conversations';
	import { identityStore } from '$lib/stores/identity';
	import { requestCountStore } from '$lib/stores/requestCount';
	import { listPendingInvites, respondToInvite, createGroup, getDMInvitations, acceptDMInvitation, blockDMInvitation, getProfile, listMyAdminJoinRequests, listMyPendingRequests, respondToJoinRequest } from '$lib/api';
	import { initChat, startConversation, forcePoll } from '$lib/services/chat';
	import { getDecryptedAvatarUrl } from '$lib/services/avatar';

	interface DMInvitation {
		id: string;
		senderDid: string;
		recipientDid: string;
		groupId: string;
		senderDisplayName: string;
		senderAvatarMediaId: string | null;
		senderAvatarKey: string | null;
		senderAvatarNonce: string | null;
		senderGeohashCell: string | null;
		senderBoxPublicKey: string | null;
		firstMessageCiphertext: string;
		firstMessageNonce: string;
		firstMessageEpoch: number;
		firstMessageDhPublicKey: string | null;
		firstMessagePreviousCounter: number | null;
		createdAt: string;
	}

	interface GroupInvite {
		id: string;
		groupId: string;
		inviterDid: string;
		groupName: string;
		groupDescription: string;
		memberCount: number;
		inviterDisplayName: string;
		createdAt: string;
	}

	interface JoinRequest {
		id: string;
		groupId: string;
		groupName: string;
		requesterDid: string;
		requesterName: string;
		createdAt: string;
	}

	interface MyPendingRequest {
		id: string;
		groupId: string;
		groupName: string;
		status: string;
		createdAt: string;
	}

	let conversations = $derived($conversationsStore);
	let groupInvites = $state<GroupInvite[]>([]);
	let dmInvitations = $state<DMInvitation[]>([]);
	let joinRequests = $state<JoinRequest[]>([]);
	let myPendingRequests = $state<MyPendingRequest[]>([]);
	let myDid = $derived($identityStore.identity?.did);
	let loaded = $state(false);

	// DM invitations expand/collapse
	let dmInvitesExpanded = $state(false);
	const DM_INVITES_COLLAPSED_COUNT = 2;

	// Tab state
	let chatTab = $state<'messages' | 'requests'>('messages');

	// Action panel
	let showPanel = $state(false);
	let panelView = $state<'menu' | 'create'>('menu');

	// Create group form
	let groupName = $state('');
	let creating = $state(false);

	// Invitation enrichment: avatars + ages
	let invAvatarUrls = $state<Record<string, string | null>>({});
	let invAges = $state<Record<string, number | null>>({});

	// Conversation avatar thumbnails for DMs
	let convoAvatarUrls = $state<Record<string, string | null>>({});

	$effect(() => {
		const did = myDid;
		if (!did || loaded) return;
		loaded = true;
		(async () => {
			await initChat();
			try {
				groupInvites = await listPendingInvites(did);
			} catch {}
			try {
				joinRequests = await listMyAdminJoinRequests(did);
			} catch {}
			try {
				myPendingRequests = await listMyPendingRequests(did);
			} catch {}
			try {
				dmInvitations = await getDMInvitations(did);
				// Enrich: fetch avatars and ages
				for (const inv of dmInvitations) {
					// Avatar
					if (inv.senderAvatarMediaId && inv.senderAvatarKey && inv.senderAvatarNonce) {
						getDecryptedAvatarUrl(inv.senderAvatarMediaId, inv.senderAvatarKey, inv.senderAvatarNonce).then(url => {
							if (url) invAvatarUrls = { ...invAvatarUrls, [inv.senderDid]: url };
						});
					} else if (inv.senderAvatarMediaId) {
						invAvatarUrls = { ...invAvatarUrls, [inv.senderDid]: `/media/${inv.senderAvatarMediaId}/blob` };
					}
					// Age from profile
					getProfile(inv.senderDid).then(p => {
						if (p.age) invAges = { ...invAges, [inv.senderDid]: p.age };
					}).catch(() => {});
				}
			} catch {}
			// Sync shared request count
			requestCountStore.set(groupInvites.length + dmInvitations.length + joinRequests.length);
			// Fetch avatars for DM conversations
			for (const convo of $conversationsStore) {
				if (convo.isGroup || !convo.peerDid) continue;
				getProfile(convo.peerDid).then(p => {
					if (p.avatarMediaId && p.avatarKey && p.avatarNonce) {
						getDecryptedAvatarUrl(p.avatarMediaId, p.avatarKey, p.avatarNonce).then(url => {
							if (url) convoAvatarUrls = { ...convoAvatarUrls, [convo.peerDid!]: url };
						});
					} else if (p.avatarMediaId) {
						convoAvatarUrls = { ...convoAvatarUrls, [convo.peerDid!]: `/media/${p.avatarMediaId}/blob` };
					}
				}).catch(() => {});
			}
		})();
	});

	// Badge counts for tabs
	let totalUnread = $derived(conversations.reduce((sum, c) => sum + c.unreadCount, 0));
	let totalInviteCount = $derived(groupInvites.length + dmInvitations.length + joinRequests.length + myPendingRequests.length);
	let sortedDmInvites = $derived([...dmInvitations].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
	let sortedGroupInvites = $derived([...groupInvites].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
	let visibleDmInvites = $derived(
		dmInvitesExpanded ? sortedDmInvites : sortedDmInvites.slice(0, DM_INVITES_COLLAPSED_COUNT)
	);
	let hiddenDmCount = $derived(Math.max(0, sortedDmInvites.length - DM_INVITES_COLLAPSED_COUNT));

	async function handleGroupInvite(inviteId: string, action: 'accept' | 'decline') {
		try {
			const result = await respondToInvite(inviteId, action);
			groupInvites = groupInvites.filter(i => i.id !== inviteId);
			requestCountStore.update(n => Math.max(0, n - 1));
			if (action === 'accept' && result.groupId) {
				goto(`/chat/${result.groupId}`);
			}
		} catch {}
	}

	async function handleJoinRequest(req: JoinRequest, action: 'approve' | 'deny') {
		if (!myDid) return;
		try {
			await respondToJoinRequest(req.groupId, req.id, myDid, action);
			joinRequests = joinRequests.filter(r => r.id !== req.id);
			requestCountStore.update(n => Math.max(0, n - 1));
			if (action === 'approve') {
				goto(`/chat/${req.groupId}`);
			}
		} catch {}
	}

	async function handleDmAccept(inv: DMInvitation) {
		if (!inv.senderBoxPublicKey) return;
		try {
			await acceptDMInvitation(inv.id);
			const groupId = await startConversation(inv.senderDid, inv.senderDisplayName, inv.senderBoxPublicKey);
			// Unmark left in case this is a reconnection after leaving
			unmarkConversationLeft(groupId);
			// Reset sealed sender so token exchange re-triggers naturally
			resetSealedSender(groupId);
			dmInvitations = dmInvitations.filter(i => i.id !== inv.id);
			requestCountStore.update(n => Math.max(0, n - 1));
			// Trigger immediate poll to pick up the first message (just inserted by accept handler)
			forcePoll();
			goto(`/chat/${groupId}`);
		} catch {}
	}

	async function handleDmIgnore(invId: string) {
		try {
			await blockDMInvitation(invId);
			dmInvitations = dmInvitations.filter(i => i.id !== invId);
			requestCountStore.update(n => Math.max(0, n - 1));
		} catch {}
	}

	async function handleCreate() {
		if (!myDid || !groupName.trim()) return;
		creating = true;
		try {
			const result = await createGroup(groupName.trim(), myDid, []);
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
			const isVideo = last.mimeType?.startsWith('video/');
			if (last.isMine) {
				preview = isVideo ? 'sent video' : 'sent photo';
			} else if (last.viewed) {
				preview = last.viewOnce ? 'opened' : (isVideo ? 'video' : 'photo');
			} else {
				preview = last.viewOnce ? (isVideo ? 'view-once video' : 'view-once photo') : (isVideo ? 'video' : 'photo');
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

	// Swipe-to-delete state
	let swipeId = $state<string | null>(null);
	let swipeX = $state(0);
	let swipeStartX = 0;
	let swipeStartY = 0;
	let swiping = false;
	let swipeLocked = $state(false);
	const SWIPE_THRESHOLD = 80;

	function handleSwipeStart(e: TouchEvent, groupId: string) {
		swipeStartX = e.touches[0].clientX;
		swipeStartY = e.touches[0].clientY;
		swiping = false;
		if (swipeId && swipeId !== groupId) {
			swipeId = null;
			swipeX = 0;
			swipeLocked = false;
		}
		swipeId = groupId;
	}

	function handleSwipeMove(e: TouchEvent) {
		if (!swipeId) return;
		const dx = e.touches[0].clientX - swipeStartX;
		const dy = e.touches[0].clientY - swipeStartY;

		if (!swiping && Math.abs(dy) > Math.abs(dx)) {
			swipeId = null;
			swipeX = 0;
			return;
		}

		if (Math.abs(dx) > 10) swiping = true;

		if (swiping) {
			e.preventDefault();
			swipeX = Math.max(-SWIPE_THRESHOLD - 20, Math.min(0, dx));
		}
	}

	function handleSwipeEnd() {
		if (!swipeId) return;
		if (swipeX < -SWIPE_THRESHOLD) {
			swipeX = -SWIPE_THRESHOLD;
			swipeLocked = true;
		} else {
			swipeX = 0;
			swipeId = null;
			swipeLocked = false;
		}
		swiping = false;
	}

	function handleSwipeDelete(groupId: string) {
		confirmDeleteId = groupId;
		swipeId = null;
		swipeX = 0;
		swipeLocked = false;
	}

	function resetSwipe() {
		swipeId = null;
		swipeX = 0;
		swipeLocked = false;
		swiping = false;
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

	// Listen for real-time join requests via WebSocket — refetch to get real IDs
	async function handleNewJoinRequest() {
		if (!myDid) return;
		try {
			joinRequests = await listMyAdminJoinRequests(myDid);
			requestCountStore.set(groupInvites.length + dmInvitations.length + joinRequests.length + myPendingRequests.length);
		} catch {}
	}

	// Listen for real-time group invitations via WebSocket — refetch to get full invite data
	async function handleNewGroupInvite() {
		if (!myDid) return;
		try {
			groupInvites = await listPendingInvites(myDid);
			requestCountStore.set(groupInvites.length + dmInvitations.length + joinRequests.length + myPendingRequests.length);
		} catch {}
	}

	// When our own join request is approved/denied, remove it from pending
	function handleMyJoinApproved(e: Event) {
		const { groupId: gid } = (e as CustomEvent).detail;
		myPendingRequests = myPendingRequests.filter(r => r.groupId !== gid);
		requestCountStore.set(groupInvites.length + dmInvitations.length + joinRequests.length + myPendingRequests.length);
	}
	function handleMyJoinDenied(e: Event) {
		const { groupId: gid } = (e as CustomEvent).detail;
		myPendingRequests = myPendingRequests.filter(r => r.groupId !== gid);
		requestCountStore.set(groupInvites.length + dmInvitations.length + joinRequests.length + myPendingRequests.length);
	}

	onMount(() => {
		window.addEventListener('group-join-request', handleNewJoinRequest);
		window.addEventListener('group-invite', handleNewGroupInvite);
		window.addEventListener('group-join-approved', handleMyJoinApproved);
		window.addEventListener('group-join-denied', handleMyJoinDenied);
	});
	onDestroy(() => {
		window.removeEventListener('group-join-request', handleNewJoinRequest);
		window.removeEventListener('group-invite', handleNewGroupInvite);
		window.removeEventListener('group-join-approved', handleMyJoinApproved);
		window.removeEventListener('group-join-denied', handleMyJoinDenied);
	});
</script>

<div class="page">
	<div class="page-container">
		<div class="tab-bar chat-tabs">
			<button class="tab" class:active={chatTab === 'messages'} onclick={() => chatTab = 'messages'}>
				messages
				{#if totalUnread > 0}
					<span class="tab-badge">{totalUnread}</span>
				{/if}
			</button>
			<button class="tab" class:active={chatTab === 'requests'} onclick={() => chatTab = 'requests'}>
				requests
				{#if totalInviteCount > 0}
					<span class="tab-badge">{totalInviteCount}</span>
				{/if}
			</button>
		</div>

	{#if chatTab === 'requests'}
		{#if totalInviteCount === 0}
			<p class="empty">no requests</p>
		{:else}
			<!-- DM invitations -->
			{#each visibleDmInvites as inv}
				<div class="dm-invite-row">
					{#if invAvatarUrls[inv.senderDid]}
						<img src={invAvatarUrls[inv.senderDid]} alt="" class="inv-avatar" />
					{:else}
						<div class="inv-avatar-placeholder">
							<span>{inv.senderDisplayName.charAt(0).toUpperCase()}</span>
						</div>
					{/if}
					<div class="dm-invite-content">
						<span class="name">
							{inv.senderDisplayName}{#if invAges[inv.senderDid]}, {invAges[inv.senderDid]}{/if}
						</span>
						<span class="preview">sent you a message &middot; {timeAgo(inv.createdAt)}</span>
					</div>
					<div class="invite-actions">
						<button class="small" onclick={() => handleDmAccept(inv)}>accept</button>
						<button class="small muted" onclick={() => handleDmIgnore(inv.id)}>ignore</button>
					</div>
				</div>
			{/each}
			{#if !dmInvitesExpanded && hiddenDmCount > 0}
				<button class="show-more" onclick={() => dmInvitesExpanded = true}>
					{hiddenDmCount} more message{hiddenDmCount === 1 ? '' : 's'}
				</button>
			{/if}

			<!-- Group invitations -->
			{#each sortedGroupInvites as invite}
				<div class="group-invite-row">
					<div class="group-invite-content">
						<span class="name">
							{invite.groupName}
							<span class="group-tag">group</span>
						</span>
						<span class="preview">
							{invite.inviterDisplayName} invited you
							{#if invite.memberCount > 0}
								&middot; {invite.memberCount} member{invite.memberCount === 1 ? '' : 's'}
							{/if}
							&middot; {timeAgo(invite.createdAt)}
						</span>
						{#if invite.groupDescription}
							<span class="preview">{invite.groupDescription}</span>
						{/if}
					</div>
					<div class="invite-actions">
						<button class="small" onclick={() => handleGroupInvite(invite.id, 'accept')}>join</button>
						<button class="small muted" onclick={() => handleGroupInvite(invite.id, 'decline')}>decline</button>
					</div>
				</div>
			{/each}

			<!-- Join requests (for groups you admin) -->
			{#each joinRequests as req}
				<div class="group-invite-row">
					<div class="group-invite-content">
						<span class="name">
							{req.requesterName}
							<span class="group-tag">join request</span>
						</span>
						<span class="preview">
							wants to join {req.groupName} &middot; {timeAgo(req.createdAt)}
						</span>
					</div>
					<div class="invite-actions">
						<button class="small" onclick={() => handleJoinRequest(req, 'approve')}>accept</button>
						<button class="small muted" onclick={() => handleJoinRequest(req, 'deny')}>deny</button>
					</div>
				</div>
			{/each}

			<!-- Your pending join requests -->
			{#each myPendingRequests as pr}
				<div class="group-invite-row">
					<div class="group-invite-content">
						<span class="name">
							{pr.groupName}
							<span class="group-tag pending">pending</span>
						</span>
						<span class="preview">
							you requested to join &middot; {timeAgo(pr.createdAt)}
						</span>
					</div>
				</div>
			{/each}
		{/if}
	{:else}
		{#if panelView === 'menu'}
			<div role="button" class="panel-item" tabindex="0" onclick={() => panelView = 'create'} onkeydown={(e) => e.key === 'Enter' && (panelView = 'create')}>
				<span class="panel-icon">+</span>
				<span>create group</span>
			</div>
		{:else}
			<div class="create-form">
				<input type="text" bind:value={groupName} placeholder="group name" onkeydown={(e) => e.key === 'Enter' && handleCreate()} />
				<div class="form-actions">
					<button onclick={handleCreate} disabled={creating || !groupName.trim()}>
						{creating ? '...' : 'create'}
					</button>
					<button class="muted" onclick={() => { panelView = 'menu'; groupName = ''; }}>back</button>
				</div>
			</div>
		{/if}
			{#if conversations.length === 0}
				<p class="empty">no conversations yet. tap someone on the grid to start&nbsp;chatting.</p>
			{:else}
				{#each conversations.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()) as convo}
					<div class="row-wrapper">
						{#if confirmDeleteId === convo.groupId}
							<div class="delete-confirm">
								<span class="delete-text">delete this chat?</span>
								<button class="small danger" onclick={() => handleDeleteChat(convo.groupId)}>delete</button>
								<button class="small muted" onclick={() => { confirmDeleteId = null; resetSwipe(); }}>cancel</button>
							</div>
						{:else}
							<div class="swipe-container"
								ontouchstart={(e) => handleSwipeStart(e, convo.groupId)}
								ontouchmove={(e) => handleSwipeMove(e)}
								ontouchend={handleSwipeEnd}
							>
								<div class="swipe-behind">
									<button class="swipe-delete-btn" onclick={() => handleSwipeDelete(convo.groupId)}>delete</button>
								</div>

								<a href="/chat/{convo.groupId}" class="row" class:row-with-avatar={!convo.isGroup && convo.peerDid}
									style={swipeId === convo.groupId ? `transform: translateX(${swipeX}px)` : ''}
								>
									{#if !convo.isGroup && convo.peerDid}
										{#if convoAvatarUrls[convo.peerDid]}
											<img src={convoAvatarUrls[convo.peerDid]} alt="" class="convo-avatar" />
										{:else}
											<div class="convo-avatar-placeholder">
												<span>{convo.peerName.charAt(0).toUpperCase()}</span>
											</div>
										{/if}
									{/if}
									<div class="row-body">
										<div class="row-top">
											<span class="name">
												{convo.peerName}
												{#if convo.isGroup}<span class="group-tag">group</span>{/if}
												{#if convo.left}<span class="group-tag left-tag">left</span>{/if}
												{#if convo.peerLeft && !convo.left}<span class="group-tag left-tag">they left</span>{/if}
												{#if convo.muted}<span class="group-tag muted-tag">muted</span>{/if}
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
										<span class="preview" class:media-preview={convo.messages[convo.messages.length - 1]?.mediaId}>{lastMessagePreview(convo)}</span>
									</div>
								</a>
							</div>
						{/if}
					</div>
				{/each}
			{/if}
	{/if}
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
	}
	.chat-tabs {
		border-top: none;
		border-bottom: 1px solid var(--border);
	}
	.tab-badge {
		background: var(--white);
		color: var(--bg);
		font-size: 10px;
		font-weight: 600;
		padding: 2px 4px;
		margin-left: 6px;
		line-height: 1;
	}
	.panel-item {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 16px;
		cursor: pointer;
		color: var(--text-muted);
		font-size: 14px;
		border-bottom: 1px solid var(--border);
	}
	@media (hover: hover) {
		.panel-item:hover {
			color: var(--text);
		}
	}
	.panel-icon {
		font-size: 16px;
		width: 20px;
		text-align: center;
	}
	.create-form {
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		border-bottom: 1px solid var(--border);
	}
	.form-actions {
		display: flex;
		gap: 8px;
	}
	.form-actions button {
		flex: 1;
	}

	.empty {
		color: var(--text-muted);
		text-align: center;
		padding: 32px 16px;
		font-size: 14px;
	}

	/* Conversation rows */
	.row {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 14px 16px;
		text-decoration: none;
		min-height: 48px;
		justify-content: center;
	}
	.row-with-avatar {
		flex-direction: row;
		align-items: center;
		gap: 12px;
	}
	.row-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.convo-avatar {
		width: 44px;
		height: 44px;
		border-radius: 2px;
		object-fit: cover;
		flex-shrink: 0;
	}
	.convo-avatar-placeholder {
		width: 44px;
		height: 44px;
		border-radius: 2px;
		background: var(--bg-surface);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.convo-avatar-placeholder span {
		font-size: 18px;
		color: var(--text-tertiary);
		font-weight: 300;
	}
	@media (hover: hover) {
		.row:hover { background: var(--bg-hover); }
	}
	.row-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.name {
		color: var(--text);
		font-size: 14px;
		display: flex;
		align-items: center;
		gap: 6px;
		line-height: 1.4;
		flex-wrap: wrap;
		min-width: 0;
	}
	.group-tag {
		font-size: 11px;
		color: var(--text-muted);
		border: 1px solid var(--border);
		padding: 1px 6px;
		border-radius: var(--radius);
	}
	.group-tag.pending {
		color: var(--text-muted);
		opacity: 0.7;
	}
	.left-tag {
		color: var(--danger);
		border-color: var(--danger);
		opacity: 0.6;
	}
	.muted-tag {
		opacity: 0.5;
	}
	.preview {
		color: var(--text-muted);
		font-size: 13px;
		line-height: 1.4;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.preview.media-preview {
		font-style: italic;
		opacity: 0.7;
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
		background: var(--white);
		color: var(--bg);
		font-size: 11px;
		padding: 2px 7px;
		font-weight: 600;
	}

	/* Invitation avatars */
	.inv-avatar {
		width: 44px;
		height: 44px;
		border-radius: 2px;
		object-fit: cover;
		flex-shrink: 0;
	}
	.inv-avatar-placeholder {
		width: 44px;
		height: 44px;
		border-radius: 2px;
		background: var(--bg-surface);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.inv-avatar-placeholder span {
		font-size: 18px;
		color: var(--text-tertiary);
		font-weight: 300;
	}

	/* DM Invitation rows */
	.dm-invite-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 16px;
		min-height: 48px;
		border-bottom: 1px solid var(--border);
	}
	.dm-invite-row:last-of-type {
		border-bottom: none;
	}
	.dm-invite-content {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.dm-invite-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	/* Group invitation rows */
	.group-invite-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 16px;
		min-height: 48px;
		border-bottom: 1px solid var(--border);
	}
	.group-invite-row:last-child {
		border-bottom: none;
	}
	.group-invite-content {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.group-invite-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.invite-actions {
		display: flex;
		gap: 8px;
		flex-shrink: 0;
	}

	/* Show more button */
	.show-more {
		display: block;
		width: 100%;
		padding: 10px 16px;
		background: transparent;
		border: none;
		border-top: 1px solid var(--border);
		color: var(--text-muted);
		font-size: 13px;
		cursor: pointer;
		text-align: left;
		min-height: auto;
	}
	@media (hover: hover) {
		.show-more:hover {
			color: var(--text);
		}
	}

	/* Row wrappers */
	.row-wrapper {
		border-bottom: 1px solid var(--border);
	}
	.row-wrapper:last-child {
		border-bottom: none;
	}

	/* Swipe container */
	.swipe-container {
		position: relative;
		overflow: hidden;
	}
	.swipe-behind {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		width: 80px;
		background: var(--bg-hover);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.swipe-delete-btn {
		background: transparent;
		border: none;
		color: var(--text-secondary, var(--text-muted));
		font-size: 13px;
		padding: 8px 16px;
		cursor: pointer;
		min-height: auto;
	}
	.swipe-container .row {
		position: relative;
		background: var(--bg);
		transition: none;
		will-change: transform;
	}

	/* Desktop: hover X button */
	.delete-btn {
		border: none;
		background: transparent;
		color: var(--text-muted);
		font-size: 16px;
		padding: 0 4px;
		cursor: pointer;
		opacity: 0;
		transition: opacity 0.1s;
		min-height: 28px;
		min-width: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		line-height: 1;
	}
	@media (hover: hover) {
		.row-wrapper:hover .delete-btn {
			opacity: 0.5;
		}
		.delete-btn:hover {
			opacity: 1 !important;
			color: var(--danger);
		}
	}
	/* Hide X button on touch-only devices */
	@media (hover: none) {
		.delete-btn {
			display: none;
		}
	}
	/* Hide swipe-behind on desktop */
	@media (hover: hover) {
		.swipe-behind {
			display: none;
		}
	}

	.delete-confirm {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 14px 16px;
		min-height: 48px;
	}
	.delete-text {
		color: var(--text-muted);
		font-size: 14px;
		flex: 1;
	}
</style>
