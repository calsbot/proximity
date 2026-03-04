<script lang="ts">
	import { page } from '$app/state';
	import { tick, onMount, onDestroy } from 'svelte';
	import { identityStore } from '$lib/stores/identity';
	import { conversationsStore, markRead, getOrCreateConversation, markConversationLeft, unmarkConversationLeft } from '$lib/stores/conversations';
	import { sendChatMessage, sendDMMediaMessage, initChat, sendGroupMessage, sendGroupMediaMessage, bootstrapGroupKeys, distributeGroupKey, rotateGroupKey, handleMediaViewed } from '$lib/services/chat';
	import { getGroup, getProfile, leaveGroup, kickMember, inviteToGroup, searchProfiles, setInviteLinkHash, requestJoinGroup, listJoinRequests, respondToJoinRequest } from '$lib/api';
	import { goto } from '$app/navigation';
	import { randomHex, sha256Hex } from '$lib/crypto/util';
	import { locationStore, requestLocation } from '$lib/stores/location';
	import { center as geohashCenter, distanceMeters } from '$lib/geo/geohash';
	import MediaViewer from '$lib/components/MediaViewer.svelte';
	import ProximityMap from '$lib/components/ProximityMap.svelte';

	let input = $state('');
	let sending = $state(false);
	let pendingMessage = $state<{ text: string; isMedia: boolean } | null>(null);
	let messagesEl: HTMLDivElement | undefined = $state();
	let isGroupChat = $state(false);
	let groupMembers = $state<Array<{ did: string; displayName: string; boxPublicKey: string | null; role?: string }>>([]);

	// Tabs: 'chat', 'members', or 'map'
	let activeTab = $state<'chat' | 'members' | 'map'>(
		typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('new') ? 'members' : 'chat'
	);
	let addSearchQuery = $state('');

	// Map tab state
	interface MapMemberProfile {
		did: string;
		displayName: string;
		bio: string;
		age: number | null;
		boxPublicKey: string | null;
		avatarMediaId: string | null;
		avatarKey: string | null;
		avatarNonce: string | null;
		instagram: string | null;
		profileLink: string | null;
		geohashCell: string;
		distance?: number;
		lastSeen: string;
		sharedGroups: Array<{ id: string; name: string }>;
	}
	let mapProfiles = $state<MapMemberProfile[]>([]);
	let mapLoading = $state(false);
	let mapLoaded = $state(false);
	let location = $derived($locationStore);
	let addSearchResults = $state<Array<{ did: string; displayName: string }>>([]);
	let addSearchTimer: ReturnType<typeof setTimeout> | null = null;
	let inviteLinkCopied = $state(false);
	let requestingJoin = $state(false);
	let rejoinError = $state('');
	let requestSent = $state(false);
	let joinRequests = $state<Array<{ id: string; did: string; displayName: string }>>([]);
	let fileInput: HTMLInputElement | undefined = $state();
	let viewingMedia = $state<{ messageId: string; mediaId: string; mediaKey: string; mediaNonce: string; mimeType: string; senderDid: string } | null>(null);

	// Staged attachment preview
	let stagedFile = $state<File | null>(null);
	let stagedPreviewUrl = $state<string | null>(null);

	let groupId = $derived(page.params.groupId);
	let convo = $derived($conversationsStore.find(c => c.groupId === groupId));
	let hasLeft = $derived(convo?.left === true);
	let messages = $derived(convo?.messages ?? []);
	let myDid = $derived($identityStore.identity?.did);
	let loaded = $state(false);

	$effect(() => {
		const did = myDid;
		if (!did || loaded) return;
		loaded = true;
		(async () => {
			await initChat();

			// If no local conversation, check if it's a server group
			if (!$conversationsStore.find(c => c.groupId === groupId)) {
				try {
					const group = await getGroup(groupId);
					isGroupChat = true;
					groupMembers = group.members;
					getOrCreateConversation(
						groupId,
						'', // no single peer for group
						group.name,
						'',
						null, // no DM keys for group chat
						true // isGroup
					);
				} catch {
					// Not a group either — genuinely not found
				}
			} else {
				const c = $conversationsStore.find(c => c.groupId === groupId);
				if (c?.isGroup) {
					isGroupChat = true;
					try {
						const group = await getGroup(groupId);
						groupMembers = group.members;
						// Bootstrap group encryption keys
						await bootstrapGroupKeys(groupId);
						// If admin and no keys exist yet, generate and distribute
						const me = group.members.find(m => m.did === did);
						const freshConvo = $conversationsStore.find(cv => cv.groupId === groupId);
						if (me?.role === 'admin' && !freshConvo?.groupKeyEpoch && freshConvo?.groupKeyEpoch !== 0) {
							const membersWithKeys = group.members.filter(m => m.boxPublicKey);
							if (membersWithKeys.length > 0) {
								await distributeGroupKey(groupId, membersWithKeys as Array<{ did: string; boxPublicKey: string }>, 0);
							}
						}
						// Fetch join requests if admin
						if (me?.role === 'admin') {
							try {
								joinRequests = await listJoinRequests(groupId, did);
							} catch {}
						}
					} catch {}
				}
			}

			if (groupId) markRead(groupId);
		})();
	});

	// Auto-scroll on new messages or pending message
	$effect(() => {
		const _msgs = messages.length;
		const _pending = pendingMessage;
		tick().then(() => {
			if (messagesEl) {
				messagesEl.scrollTop = messagesEl.scrollHeight;
			}
		});
	});

	// Mark as read when viewing
	$effect(() => {
		if (groupId && convo && convo.unreadCount > 0) {
			markRead(groupId);
		}
	});

	// Listen for real-time group events from WebSocket
	function handleMemberRemoved(e: Event) {
		const { groupId: gid, targetDid } = (e as CustomEvent).detail;
		if (gid === groupId) {
			groupMembers = groupMembers.filter(m => m.did !== targetDid);
		}
	}
	function handleJoinRequest(e: Event) {
		const { groupId: gid, requesterDid, requesterName } = (e as CustomEvent).detail;
		if (gid === groupId && isAdmin) {
			// Add to local join requests if not already there
			if (!joinRequests.some(r => r.did === requesterDid)) {
				joinRequests = [...joinRequests, { id: '', did: requesterDid, displayName: requesterName }];
				// Refresh from server to get the actual request ID
				if (myDid) listJoinRequests(groupId, myDid).then(r => { joinRequests = r; }).catch(() => {});
			}
		}
	}
	function handleJoinApproved(e: Event) {
		const { groupId: gid } = (e as CustomEvent).detail;
		if (gid === groupId) {
			unmarkConversationLeft(groupId);
			requestSent = false;
			getGroup(groupId).then(g => { groupMembers = g.members; }).catch(() => {});
		}
	}
	function handleJoinDenied(e: Event) {
		const { groupId: gid } = (e as CustomEvent).detail;
		if (gid === groupId) {
			requestSent = false;
			rejoinError = 'your join request was denied.';
		}
	}
	onMount(() => {
		window.addEventListener('group-member-removed', handleMemberRemoved);
		window.addEventListener('group-join-request', handleJoinRequest);
		window.addEventListener('group-join-approved', handleJoinApproved);
		window.addEventListener('group-join-denied', handleJoinDenied);
	});
	onDestroy(() => {
		window.removeEventListener('group-member-removed', handleMemberRemoved);
		window.removeEventListener('group-join-request', handleJoinRequest);
		window.removeEventListener('group-join-approved', handleJoinApproved);
		window.removeEventListener('group-join-denied', handleJoinDenied);
	});

	async function handleSend() {
		if (stagedFile) {
			await sendStagedMedia();
			return;
		}
		if (!input.trim() || sending) return;
		const text = input.trim();
		input = '';
		sending = true;
		pendingMessage = { text, isMedia: false };
		try {
			if (isGroupChat) {
				await sendGroupMessage(groupId, text, groupMembers.map(m => m.did));
			} else {
				await sendChatMessage(groupId, text);
			}
		} catch (e) {
			console.error('Failed to send:', e);
			input = text; // restore on failure
		} finally {
			sending = false;
			pendingMessage = null;
		}
	}

	function formatTime(ts: string): string {
		try {
			const d = new Date(ts);
			return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		} catch {
			return '';
		}
	}

	function shouldShowTimeSeparator(index: number): boolean {
		if (index === 0) return true;
		const prev = messages[index - 1];
		const curr = messages[index];
		if (!prev || !curr) return false;
		// Skip system messages for gap calculation
		if (curr.senderDid === 'system') return false;
		const prevTime = new Date(prev.timestamp).getTime();
		const currTime = new Date(curr.timestamp).getTime();
		// Show separator if 5+ minute gap
		return (currTime - prevTime) > 5 * 60 * 1000;
	}

	function senderName(msg: { senderDid: string; senderName?: string }): string {
		if (msg.senderName) return msg.senderName;
		const member = groupMembers.find(m => m.did === msg.senderDid);
		if (member) return member.displayName;
		return msg.senderDid.slice(-8);
	}

	let myRole = $derived(groupMembers.find(m => m.did === myDid)?.role);
	let isAdmin = $derived(myRole === 'admin');

	async function handleLeave() {
		if (!myDid) return;
		try {
			await leaveGroup(groupId, myDid);
			markConversationLeft(groupId);
			activeTab = 'chat';
		} catch (e) {
			console.error('Failed to leave group:', e);
		}
	}

	async function handleRequestJoin() {
		if (!myDid) return;
		requestingJoin = true;
		try {
			const result = await requestJoinGroup(groupId, myDid);
			if (result.alreadyMember) {
				unmarkConversationLeft(groupId);
				const group = await getGroup(groupId);
				groupMembers = group.members;
			} else {
				requestSent = true;
			}
		} catch {
			rejoinError = 'failed to send join request.';
		} finally {
			requestingJoin = false;
		}
	}

	async function handleJoinResponse(requestId: string, action: 'approve' | 'deny') {
		if (!myDid) return;
		try {
			await respondToJoinRequest(groupId, requestId, myDid, action);
			joinRequests = joinRequests.filter(r => r.id !== requestId);
			if (action === 'approve') {
				const group = await getGroup(groupId);
				groupMembers = group.members;
				// Distribute current group key to new member
				const membersWithKeys = group.members.filter(m => m.boxPublicKey) as Array<{ did: string; boxPublicKey: string }>;
				const freshConvo = $conversationsStore.find(cv => cv.groupId === groupId);
				const epoch = freshConvo?.groupKeyEpoch ?? 0;
				if (membersWithKeys.length > 0) {
					await distributeGroupKey(groupId, membersWithKeys, epoch);
				}
			}
		} catch (e) {
			console.error('Failed to respond to join request:', e);
		}
	}

	async function handleKick(targetDid: string) {
		if (!myDid) return;
		try {
			await kickMember(groupId, myDid, targetDid);
			const remaining = groupMembers.filter(m => m.did !== targetDid);
			groupMembers = remaining;
			// Rotate group key so kicked member can't decrypt future messages
			const membersWithKeys = remaining.filter(m => m.boxPublicKey) as Array<{ did: string; boxPublicKey: string }>;
			if (membersWithKeys.length > 0) {
				await rotateGroupKey(groupId, membersWithKeys);
			}
		} catch (e) {
			console.error('Failed to kick member:', e);
		}
	}

	async function handleAddMember(targetDid: string) {
		if (!myDid) return;
		try {
			await inviteToGroup(groupId, myDid, targetDid);
			// Refresh members
			const group = await getGroup(groupId);
			groupMembers = group.members;
			addSearchQuery = '';
			addSearchResults = [];
		} catch (e) {
			console.error('Failed to invite member:', e);
		}
	}

	async function shareInvite() {
		if (!myDid) return;
		const key = randomHex(16);
		const hash = await sha256Hex(key);
		await setInviteLinkHash(groupId, myDid, hash);
		const url = `${window.location.origin}/invite#groupId=${encodeURIComponent(groupId)}&key=${encodeURIComponent(key)}`;

		if (typeof navigator.share !== 'undefined') {
			try {
				const name = convo?.peerName ?? 'proximity';
				await navigator.share({
					title: `Join ${name}`,
					text: `You're invited to ${name}. Tap to join and see who's nearby.`,
					url
				});
				return;
			} catch {}
		}
		// Fallback to clipboard
		await navigator.clipboard.writeText(url);
		inviteLinkCopied = true;
		setTimeout(() => { inviteLinkCopied = false; }, 2000);
	}

	async function copyInviteLink() {
		if (!myDid) return;
		const key = randomHex(16);
		const hash = await sha256Hex(key);
		await setInviteLinkHash(groupId, myDid, hash);
		const url = `${window.location.origin}/invite#groupId=${encodeURIComponent(groupId)}&key=${encodeURIComponent(key)}`;
		await navigator.clipboard.writeText(url);
		inviteLinkCopied = true;
		setTimeout(() => { inviteLinkCopied = false; }, 2000);
	}

	function handleFileAttach(e: Event) {
		const target = e.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) return;
		target.value = '';

		if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) return;
		if (file.size > 50 * 1024 * 1024) return;

		// Stage instead of sending immediately
		stagedFile = file;
		stagedPreviewUrl = URL.createObjectURL(file);
	}

	async function sendStagedMedia() {
		if (!stagedFile) return;
		const file = stagedFile;
		clearStaged();
		sending = true;
		pendingMessage = { text: 'photo', isMedia: true };
		try {
			if (isGroupChat) {
				await sendGroupMediaMessage(groupId, file, true, groupMembers.map(m => m.did));
			} else {
				await sendDMMediaMessage(groupId, file, true);
			}
		} catch (e) {
			console.error('Failed to send media:', e);
		} finally {
			sending = false;
			pendingMessage = null;
		}
	}

	function clearStaged() {
		if (stagedPreviewUrl) URL.revokeObjectURL(stagedPreviewUrl);
		stagedFile = null;
		stagedPreviewUrl = null;
	}

	function openMediaViewer(msg: import('$lib/stores/conversations').DecryptedMessage) {
		if (!msg.mediaId || !msg.mediaKey || !msg.mediaNonce || !msg.mimeType) return;
		if (msg.viewed && msg.viewOnce) return; // already viewed
		viewingMedia = {
			messageId: msg.id,
			mediaId: msg.mediaId,
			mediaKey: msg.mediaKey,
			mediaNonce: msg.mediaNonce,
			mimeType: msg.mimeType,
			senderDid: msg.senderDid,
		};
	}

	async function closeMediaViewer() {
		if (!viewingMedia) return;
		const { messageId, mediaId, senderDid } = viewingMedia;
		viewingMedia = null;
		// Mark as viewed — wipes key locally + notifies server/sender
		await handleMediaViewed(groupId, messageId, mediaId, senderDid);
	}

	async function loadMapProfiles() {
		if (mapLoaded || mapLoading) return;
		mapLoading = true;

		// Request location if not available
		if (!location.lat || !location.lon) {
			try { await requestLocation(); } catch {}
		}

		try {
			const results: MapMemberProfile[] = [];
			const loc = $locationStore;

			for (const member of groupMembers) {
				if (member.did === myDid) continue;
				try {
					const p = await getProfile(member.did);
					if (!p.geohashCells) continue;
					const cells: string[] = JSON.parse(p.geohashCells);
					if (cells.length === 0) continue;

					const cell = cells[0];
					const c = geohashCenter(cell);
					const dist = loc.lat && loc.lon ? distanceMeters(loc.lat, loc.lon, c.lat, c.lon) : undefined;

					results.push({
						did: p.did,
						displayName: p.displayName,
						bio: p.bio ?? '',
						age: p.age,
						boxPublicKey: p.boxPublicKey,
						avatarMediaId: p.avatarMediaId,
						avatarKey: p.avatarKey,
						avatarNonce: p.avatarNonce,
						instagram: p.instagram,
						profileLink: p.profileLink,
						geohashCell: cell,
						distance: dist,
						lastSeen: p.lastSeen,
						sharedGroups: [{ id: groupId, name: convo?.peerName ?? '' }],
					});
				} catch {}
			}

			mapProfiles = results;
			mapLoaded = true;
		} finally {
			mapLoading = false;
		}
	}

	// Load map profiles when map tab is activated
	$effect(() => {
		if (activeTab === 'map' && isGroupChat && !mapLoaded) {
			loadMapProfiles();
		}
	});

	function handleAddSearch(value: string) {
		addSearchQuery = value;
		if (addSearchTimer) clearTimeout(addSearchTimer);
		if (!value.trim()) { addSearchResults = []; return; }
		addSearchTimer = setTimeout(async () => {
			try {
				addSearchResults = await searchProfiles(value.trim(), myDid);
			} catch { addSearchResults = []; }
		}, 300);
	}
</script>

<div class="chat" class:map-mode={activeTab === 'map'}>
	<div class="card">
		<div class="card-header">
			<div class="header-top">
				<button class="back" onclick={() => goto('/chat')}>&larr;</button>
				<span class="dot green"></span>
				<span class="title">{convo?.peerName ?? 'conversation'}</span>
			</div>
			{#if isGroupChat && !hasLeft}
				<div class="tab-bar">
					<button class="tab" class:active={activeTab === 'chat'} onclick={() => activeTab = 'chat'}>chat</button>
					<button class="tab" class:active={activeTab === 'map'} onclick={() => activeTab = 'map'}>map</button>
					<button class="tab" class:active={activeTab === 'members'} onclick={() => activeTab = 'members'}>members ({groupMembers.length})</button>
				</div>
			{/if}
		</div>
		{#if activeTab === 'members' && isGroupChat && !hasLeft}
			<div class="members-panel">
				{#each groupMembers as member}
					<div class="member-row">
						<span class="member-name">{member.displayName}</span>
						<span class="member-role">{member.role ?? 'member'}</span>
						{#if isAdmin && member.did !== myDid}
							<button class="small muted" onclick={() => handleKick(member.did)}>remove</button>
						{/if}
					</div>
				{/each}

				{#if isAdmin}
					<div class="add-member">
						<input
							type="text"
							value={addSearchQuery}
							oninput={(e) => handleAddSearch(e.currentTarget.value)}
							placeholder="add member by name..."
						/>
						{#if addSearchResults.length > 0}
							<div class="search-results">
								{#each addSearchResults as profile}
									{#if !groupMembers.some(m => m.did === profile.did)}
										<button class="small" onclick={() => handleAddMember(profile.did)}>
											{profile.displayName} +
										</button>
									{/if}
								{/each}
							</div>
						{/if}
					</div>
				{/if}

				{#if isAdmin && joinRequests.length > 0}
					<div class="join-requests">
						<p class="section-label">join requests</p>
						{#each joinRequests as req}
							<div class="member-row">
								<span class="member-name">{req.displayName}</span>
								<div class="req-actions">
									<button class="small" onclick={() => handleJoinResponse(req.id, 'approve')}>approve</button>
									<button class="small muted" onclick={() => handleJoinResponse(req.id, 'deny')}>deny</button>
								</div>
							</div>
						{/each}
					</div>
				{/if}

				<div class="invite-actions">
					<button class="invite-btn" onclick={shareInvite}>send invitation</button>
					<button class="invite-btn secondary" onclick={copyInviteLink}>
						{inviteLinkCopied ? 'copied!' : 'copy link'}
					</button>
				</div>

				<button class="small muted leave-btn" onclick={handleLeave}>leave group</button>
			</div>
		{/if}

		{#if activeTab === 'map' && isGroupChat && !hasLeft}
			<div class="map-panel">
				{#if mapLoading}
					<p class="map-status">loading map...</p>
				{:else if location.lat && location.lon}
					<ProximityMap
						profiles={mapProfiles}
						userLat={location.lat}
						userLon={location.lon}
						activeFilter="all"
						groups={[{ id: groupId, name: convo?.peerName ?? '' }]}
					/>
				{:else}
					<p class="map-status">enable location to see members on&nbsp;the&nbsp;map.</p>
				{/if}
			</div>
		{/if}

		{#if activeTab === 'chat' || !isGroupChat}
			<div class="card-body" bind:this={messagesEl}>
				<div class="messages">
					{#if !convo}
						<p class="empty">conversation not found.</p>
					{:else if messages.length === 0}
						<div class="system-msg">{isGroupChat ? (isAdmin ? 'you created the group' : convo.peerName + ' was created') : 'conversation started'}</div>
					{:else}
						{#each messages as msg, i}
							{#if shouldShowTimeSeparator(i)}
								<div class="system-msg">{formatTime(msg.timestamp)}</div>
							{/if}
							{#if msg.senderDid === 'system'}
								<div class="system-msg">{msg.text}</div>
							{:else}
							<div class="msg" class:mine={msg.isMine}>
								{#if isGroupChat && !msg.isMine}
									<span class="sender">{senderName(msg)}</span>
								{/if}
								{#if msg.mediaId}
									<button class="bubble media-bubble" class:unseen={msg.isMine && !msg.viewed} onclick={() => openMediaViewer(msg)} disabled={msg.viewed && msg.viewOnce}>
										{#if msg.viewed}
											<span class="media-text">opened</span>
										{:else}
											<span class="media-icon">&#9654;</span>
											<span class="media-text">{msg.mimeType?.startsWith('video/') ? 'Play video' : 'View photo'}</span>
										{/if}
									</button>
								{:else}
									<div class="bubble">
										<span class="text">{msg.text}</span>
									</div>
								{/if}
							</div>
							{/if}
						{/each}
					{/if}
					{#if pendingMessage}
						<div class="msg mine">
							<div class="bubble sending">
								<span class="text">{pendingMessage.isMedia ? '📷 sending photo...' : pendingMessage.text}</span>
								<span class="sending-indicator">sending</span>
							</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</div>

	{#if hasLeft}
		<div class="left-banner">
			<span class="left-text">you left this group.</span>
			{#if requestSent}
				<span class="left-text">request sent — waiting for admin approval.</span>
			{:else}
				<button class="small" onclick={handleRequestJoin} disabled={requestingJoin}>
					{requestingJoin ? 'requesting...' : 'request to join'}
				</button>
			{/if}
			{#if rejoinError}
				<span class="left-error">{rejoinError}</span>
			{/if}
		</div>
	{:else if activeTab === 'chat' || !isGroupChat}
		{#if stagedPreviewUrl}
			<div class="staged-preview">
				<img src={stagedPreviewUrl} alt="" class="preview-thumb" />
				<span class="view-once-label">view once</span>
				<button class="preview-remove" onclick={clearStaged}>&times;</button>
			</div>
		{/if}
		<form class="composer" class:has-preview={!!stagedPreviewUrl} onsubmit={(e) => { e.preventDefault(); handleSend(); }}>
			<input type="file" accept="image/*,video/*" onchange={handleFileAttach} hidden bind:this={fileInput} />
			<button type="button" class="attach-btn" onclick={() => fileInput?.click()} disabled={!convo}>+</button>
			<input type="text" bind:value={input} placeholder={sending ? "sending..." : "message..."} disabled={!convo || sending} />
			<button type="submit" disabled={!convo || sending || (!input.trim() && !stagedFile)}>{sending ? 'sending...' : 'send'}</button>
		</form>
	{/if}
</div>

{#if viewingMedia}
	<MediaViewer
		mediaId={viewingMedia.mediaId}
		mediaKey={viewingMedia.mediaKey}
		mediaNonce={viewingMedia.mediaNonce}
		mimeType={viewingMedia.mimeType}
		onclose={closeMediaViewer}
	/>
{/if}

<style>
	.chat {
		display: flex;
		flex-direction: column;
		gap: 8px;
		height: calc(100dvh - 24px);
	}
	.card {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
		flex: 1;
		display: flex;
		flex-direction: column;
	}
	.card-header {
		display: flex;
		flex-direction: column;
		gap: 0;
		padding: 0;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}
	.header-top {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 16px 8px 8px;
	}
	.back {
		border: none;
		padding: 4px 8px;
		font-size: 16px;
		color: var(--text-muted);
		min-width: 48px;
		min-height: 48px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	@media (hover: hover) {
		.back:hover { color: var(--text); background: transparent; }
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}
	.dot.green { background: var(--white); }
	.title {
		color: var(--text-muted);
		font-size: 14px;
	}
	.tab-bar {
		display: flex;
		border-top: 1px solid var(--border);
	}
	.tab {
		flex: 1;
		padding: 10px 16px;
		font-size: 12px;
		letter-spacing: 0.02em;
		border: none;
		border-radius: 0;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		min-height: 40px;
		text-align: center;
	}
	.tab:not(:last-child) {
		border-right: 1px solid var(--border);
	}
	.tab.active {
		background: var(--white);
		color: var(--bg);
	}
	@media (hover: hover) {
		.tab:hover:not(.active) {
			background: var(--bg-hover);
		}
	}

	/* Message area */
	.card-body {
		flex: 1;
		overflow-y: auto;
		padding: 12px 16px;
	}
	.messages {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.msg {
		display: flex;
		flex-direction: column;
	}
	.msg.mine {
		align-items: flex-end;
	}
	.sender {
		font-size: 12px;
		color: var(--text-muted);
		margin-bottom: 2px;
		margin-left: 4px;
	}
	.bubble {
		max-width: 75%;
		padding: 10px 14px;
		border-radius: var(--radius);
		border: 1px solid var(--border);
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.mine .bubble {
		background: var(--bg-surface);
		border-color: var(--border);
	}
	.bubble.sending {
		opacity: 0.6;
		gap: 8px;
	}
	.sending-indicator {
		font-size: 11px;
		color: var(--text-muted);
		white-space: nowrap;
	}
	.text {
		color: var(--text);
		line-height: 1.5;
		word-break: break-word;
		font-size: 14px;
	}
	.system-msg {
		text-align: center;
		color: var(--text-tertiary);
		font-size: 12px;
		padding: 8px 0;
		line-height: 1.5;
	}
	.empty {
		color: var(--text-muted);
		text-align: center;
		padding: 24px 0;
		font-size: 14px;
	}

	/* Composer */
	.composer {
		display: flex;
		align-items: center;
		gap: 4px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 4px;
	}
	.composer input {
		border: none;
		padding: 8px;
		min-height: 40px;
	}
	.composer input:focus {
		border-color: transparent;
	}
	.composer button[type="submit"] {
		flex-shrink: 0;
	}

	/* Members */
	.members-panel {
		padding: 16px;
		border-bottom: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.member-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 0;
	}
	.member-name {
		color: var(--text);
		font-size: 14px;
	}
	.member-role {
		color: var(--text-muted);
		font-size: 12px;
		border: 1px solid var(--border);
		padding: 2px 6px;
		border-radius: var(--radius);
	}
	.member-row button {
		margin-left: auto;
	}
	button.small { padding: 8px 12px; font-size: 14px; min-height: 40px; }
	button.muted { color: var(--text-muted); border-color: transparent; }
	.add-member {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 8px;
	}
	.search-results {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.invite-actions {
		display: flex;
		gap: 8px;
		margin-top: 12px;
	}
	.invite-btn {
		flex: 1;
	}
	.invite-btn.secondary {
		background: transparent;
		border-color: var(--border);
		color: var(--text-muted);
	}
	@media (hover: hover) {
		.invite-btn.secondary:hover {
			color: var(--text);
			border-color: #444;
		}
	}
	.leave-btn {
		margin-top: 8px;
		color: var(--danger);
		border-color: transparent;
	}

	/* Left banner */
	.left-banner {
		display: flex;
		align-items: center;
		gap: 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 14px 16px;
		flex-wrap: wrap;
	}
	.left-text {
		color: var(--text-muted);
		font-size: 14px;
	}
	.left-error {
		color: var(--danger);
		font-size: 14px;
		width: 100%;
	}
	.join-requests {
		border-top: 1px solid var(--border);
		padding-top: 8px;
		margin-top: 8px;
	}
	.section-label {
		color: var(--text-muted);
		font-size: 14px;
		margin-bottom: 4px;
	}
	.req-actions {
		display: flex;
		gap: 4px;
		margin-left: auto;
	}

	/* Attach + media */
	.attach-btn {
		border: none;
		background: transparent;
		color: var(--text-muted);
		font-size: 20px;
		padding: 4px 8px;
		cursor: pointer;
		flex-shrink: 0;
		min-width: 48px;
		min-height: 48px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	@media (hover: hover) {
		.attach-btn:hover { color: var(--text); }
	}
	.media-bubble {
		cursor: pointer;
		align-items: center;
	}
	.media-bubble.unseen {
		background: var(--bg-surface);
		border-color: var(--text-muted);
	}
	.media-bubble:disabled {
		cursor: default;
		background: transparent;
		border-color: var(--border);
	}
	.media-icon {
		font-size: 12px;
		color: var(--text);
	}
	.media-text {
		font-size: 14px;
		color: var(--text);
		font-weight: 500;
	}
	.media-bubble:disabled .media-text {
		color: var(--text-muted);
		font-weight: 400;
	}

	/* Staged attachment preview */
	.staged-preview {
		display: flex;
		align-items: center;
		gap: 12px;
		border: 1px solid var(--border);
		border-bottom: none;
		border-radius: var(--radius) var(--radius) 0 0;
		padding: 12px;
	}
	.preview-thumb {
		width: 48px;
		height: 48px;
		border-radius: var(--radius);
		object-fit: cover;
		border: 1px solid var(--border);
	}
	.view-once-label {
		font-size: 12px;
		color: var(--text-muted);
	}
	.preview-remove {
		margin-left: auto;
		border: none;
		background: transparent;
		color: var(--text-muted);
		font-size: 20px;
		padding: 4px 8px;
		min-height: 48px;
		min-width: 48px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	@media (hover: hover) {
		.preview-remove:hover {
			color: var(--text);
			background: transparent;
		}
	}
	.composer.has-preview {
		border-top-left-radius: 0;
		border-top-right-radius: 0;
	}

	/* Map */
	.map-panel {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}
	.map-status {
		color: var(--text-muted);
		text-align: center;
		padding: 48px 16px;
		font-size: 14px;
	}
	.chat.map-mode .card {
		flex: 1;
		min-height: 0;
	}
</style>
