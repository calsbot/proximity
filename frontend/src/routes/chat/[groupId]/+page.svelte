<script lang="ts">
	import { page } from '$app/state';
	import { tick, onMount, onDestroy } from 'svelte';
	import { identityStore } from '$lib/stores/identity';
	import { conversationsStore, markRead, getOrCreateConversation, markConversationLeft, unmarkConversationLeft, markConversationPeerLeft, unmarkConversationPeerLeft, diffGroupMembers, addMessage, muteConversation, unmuteConversation, resetSealedSender } from '$lib/stores/conversations';
	import { sendChatMessage, sendDMMediaMessage, initChat, sendGroupMessage, sendGroupMediaMessage, bootstrapSenderKeys, distributeMySenderKey, rotateGroupKey, handleMediaViewed, startConversation } from '$lib/services/chat';
	import { getGroup, getProfile, leaveGroup, kickMember, inviteToGroup, setInviteLinkHash, requestJoinGroup, listJoinRequests, respondToJoinRequest, acceptDMInvitation, submitFlag, revokeProfileKey, leaveDM, getDMStatus, sendDMInvitation } from '$lib/api';
	import { goto } from '$app/navigation';
	import { randomHex, sha256Hex } from '$lib/crypto/util';
	import { createSignedFlag, type FlagPayload } from '$lib/crypto/moderation';
	import { getDecryptedAvatarUrl } from '$lib/services/avatar';
	import { decryptProfileFields } from '$lib/crypto/profile';
	import { unwrapProfileKey } from '$lib/crypto/profile';
	import { rotateMyProfileKey, invalidateProfileKey } from '$lib/stores/profileKeys';
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
	let inviteLinkMaxUses = $state<string>('');
	let inviteLinkExpiry = $state<string>('');
	let showLinkSettings = $state(false);
	let requestingJoin = $state(false);
	let rejoinError = $state('');
	let requestSent = $state(false);
	let requestingChat = $state(false);
	let chatRequestSent = $state(false);
	let joinRequests = $state<Array<{ id: string; did: string; displayName: string }>>([]);
	let fileInput: HTMLInputElement | undefined = $state();
	let viewingMedia = $state<{ messageId: string; mediaId: string; mediaKey: string; mediaNonce: string; mimeType: string; senderDid: string } | null>(null);

	// Staged attachment preview
	let stagedFile = $state<File | null>(null);
	let stagedPreviewUrl = $state<string | null>(null);

	// General chat menu
	let showChatMenu = $state(false);
	let showReportSubmenu = $state(false);

	// Expanded member profiles
	let expandedMember = $state<string | null>(null);
	interface MemberProfile {
		did: string;
		displayName: string;
		bio: string;
		age: number | null;
		tags: string[];
		avatarUrl: string | null;
		boxPublicKey: string | null;
	}
	let memberProfiles = $state<Record<string, MemberProfile>>({});
	let loadingMemberProfile = $state<string | null>(null);

	// Flag menu
	let showFlagMenu = $state(false);
	let flagSubmitting = $state(false);
	let flagSent = $state(false);

	// File attach error toast
	let attachError = $state('');

	// Peer profile for DM header
	interface PeerProfile {
		displayName: string;
		bio: string;
		age: number | null;
		tags: string[];
		avatarUrl: string | null;
	}
	let peerProfile = $state<PeerProfile | null>(null);

	let groupId = $derived(page.params.groupId);
	let convo = $derived($conversationsStore.find(c => c.groupId === groupId));
	let peerLeft = $derived(convo?.peerLeft === true);
	let hasLeft = $derived(convo?.left === true);
	let isMuted = $derived(convo?.muted === true);
	let messages = $derived(convo?.messages ?? []);
	let myDid = $derived($identityStore.identity?.did);
	let loaded = $state(false);

	// Pending DM invitation: accepted on first reply
	let pendingInvitationId = $state<string | null>(
		typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('invitation') : null
	);

	// Pending DM: peer info from URL params, conversation not yet created
	let pendingPeer = $state<{ did: string; name: string; key: string } | null>(
		typeof window !== 'undefined' ? (() => {
			const p = new URLSearchParams(window.location.search);
			const did = p.get('peerDid');
			const name = p.get('peerName');
			const key = p.get('peerKey');
			return did && name && key ? { did, name, key } : null;
		})() : null
	);

	$effect(() => {
		const did = myDid;
		if (!did || loaded) return;
		loaded = true;
		(async () => {
			await initChat();

			// If no local conversation, check if it's a server group or a pending DM
			if (!$conversationsStore.find(c => c.groupId === groupId)) {
				if (pendingPeer) {
					// Pending DM from grid — don't create conversation yet, wait for first message
				} else {
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
						// Seed the known member list so future diffs work
						diffGroupMembers(groupId, group.members);

						// Sender Keys: fetch existing members' keys, then distribute my own
						await bootstrapSenderKeys(groupId);
						await distributeMySenderKey(groupId);
					} catch {
						// Not a group either — genuinely not found
					}
				}
			} else {
				const c = $conversationsStore.find(c => c.groupId === groupId);
				if (c?.isGroup) {
					isGroupChat = true;
					try {
						const group = await getGroup(groupId);
						groupMembers = group.members;

						// Track member changes
						diffGroupMembers(groupId, group.members);

						// Sender Keys: fetch existing members' keys, then distribute my own
						await bootstrapSenderKeys(groupId);
						await distributeMySenderKey(groupId);

						// Fetch join requests if admin
						const me = group.members.find(m => m.did === did);
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

	// Fetch peer profile for DM header
	$effect(() => {
		const did = myDid;
		const c = convo;
		const pp = pendingPeer;
		if (!did || isGroupChat) return;
		const peerDid = c?.peerDid || pp?.did;
		if (!peerDid || peerProfile) return;
		(async () => {
			try {
				const identity = $identityStore.identity;
				const p = await getProfile(peerDid);
				let bio = p.bio || '';
				let age = p.age ?? null;
				let tags: string[] = [];

				// Try to decrypt encrypted fields
				if (p.encryptedFields && p.encryptedFieldsNonce && identity) {
					try {
						const { getProfileKeysForMe } = await import('$lib/api');
						const { decodeBase64 } = await import('$lib/crypto/util');
						const keys = await getProfileKeysForMe(did);
						const match = keys.find((k: any) => k.ownerDid === peerDid);
						if (match && p.boxPublicKey) {
							const senderPub = decodeBase64(p.boxPublicKey);
							const decryptedKey = unwrapProfileKey(
								match.wrappedKey,
								match.wrappedKeyNonce,
								senderPub,
								identity.boxSecretKey
							);
							const fields = decryptProfileFields(p.encryptedFields, p.encryptedFieldsNonce, decryptedKey);
							bio = fields.bio || bio;
							age = fields.age ?? age;
							tags = fields.tags || [];
						}
					} catch {}
				}

				// Decrypt avatar
				let avatarUrl: string | null = null;
				if (p.avatarMediaId) {
					if (p.avatarKey && p.avatarNonce) {
						avatarUrl = await getDecryptedAvatarUrl(p.avatarMediaId, p.avatarKey, p.avatarNonce) ?? null;
					} else {
						avatarUrl = `/media/${p.avatarMediaId}/blob`;
					}
				}

				peerProfile = { displayName: p.displayName, bio, age, tags, avatarUrl };
			} catch {}
		})();
	});

	// Check DM leave status on load — server is source of truth
	$effect(() => {
		const did = myDid;
		const c = convo;
		if (!did || isGroupChat || !c) return;
		(async () => {
			try {
				const leaves = await getDMStatus(groupId);
				if (leaves.length > 0) {
					const peerLeave = leaves.find(l => l.leaverDid !== did);
					if (peerLeave && !c.peerLeft) markConversationPeerLeft(groupId);
					if (!peerLeave && c.peerLeft) unmarkConversationPeerLeft(groupId);
					const myLeave = leaves.find(l => l.leaverDid === did);
					if (myLeave && !hasLeft) markConversationLeft(groupId);
					if (!myLeave && hasLeft) {
						// Server says we didn't leave — clear stale local state
						unmarkConversationLeft(groupId);
						chatRequestSent = false;
					}
				} else {
					// No leave records — clear any stale state
					if (c.peerLeft) unmarkConversationPeerLeft(groupId);
					if (hasLeft) {
						unmarkConversationLeft(groupId);
						chatRequestSent = false;
					}
				}
			} catch {}
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
	function handleDmPeerLeft(e: Event) {
		const { groupId: gid } = (e as CustomEvent).detail;
		if (gid === groupId) {
			// peerLeft is now $derived from convo.peerLeft — store update happens in chat.ts
		}
	}
	function handleDmAccepted(e: Event) {
		const { groupId: gid } = (e as CustomEvent).detail;
		if (gid === groupId) {
			// Peer accepted our reconnect invite — restore chat
			// peerLeft is now $derived from convo.peerLeft — store updates happen in chat.ts
			unmarkConversationLeft(groupId);
			chatRequestSent = false;
		}
	}
	onMount(() => {
		window.addEventListener('group-member-removed', handleMemberRemoved);
		window.addEventListener('group-join-request', handleJoinRequest);
		window.addEventListener('group-join-approved', handleJoinApproved);
		window.addEventListener('group-join-denied', handleJoinDenied);
		window.addEventListener('dm-peer-left', handleDmPeerLeft);
		window.addEventListener('dm-accepted', handleDmAccepted);
	});
	onDestroy(() => {
		window.removeEventListener('group-member-removed', handleMemberRemoved);
		window.removeEventListener('group-join-request', handleJoinRequest);
		window.removeEventListener('group-join-approved', handleJoinApproved);
		window.removeEventListener('group-join-denied', handleJoinDenied);
		window.removeEventListener('dm-peer-left', handleDmPeerLeft);
		window.removeEventListener('dm-accepted', handleDmAccepted);
	});

	async function ensureConversation(): Promise<void> {
		if (pendingPeer && !$conversationsStore.find(c => c.groupId === groupId)) {
			await startConversation(pendingPeer.did, pendingPeer.name, pendingPeer.key);
			pendingPeer = null;
		}
	}

	async function handleSend() {
		if (stagedFile) {
			await sendStagedMedia();
			return;
		}
		if (!input.trim() || sending) return;
		const text = input.trim();
		input = '';
		sending = true;
		try {
			await ensureConversation();
			if (isGroupChat) {
				await sendGroupMessage(groupId, text, groupMembers.map(m => m.did));
			} else {
				await sendChatMessage(groupId, text);
			}
			// Accept DM invitation on first reply
			if (pendingInvitationId) {
				const invId = pendingInvitationId;
				pendingInvitationId = null;
				acceptDMInvitation(invId).then(() => {
					unmarkConversationLeft(groupId);
					unmarkConversationPeerLeft(groupId);
					resetSealedSender(groupId);
				}).catch(e => console.error('[invitation] accept failed:', e));
			}
		} catch (e) {
			console.error('Failed to send:', e);
			input = text; // restore on failure
		} finally {
			sending = false;
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

	async function handleRequestChat() {
		const state = $identityStore;
		if (!state.identity || !convo?.peerDid) return;
		requestingChat = true;
		try {
			// Don't clear leave records here — they stay until the peer accepts the invitation.
			// The server's accept handler clears dm_leaves when the invitation is accepted.
			const myProfile = await getProfile(state.identity.did);
			await sendDMInvitation({
				senderDid: state.identity.did,
				recipientDid: convo.peerDid,
				groupId,
				senderDisplayName: myProfile.displayName,
				senderAvatarMediaId: myProfile.avatarMediaId ?? undefined,
				senderAvatarKey: myProfile.avatarKey ?? undefined,
				senderAvatarNonce: myProfile.avatarNonce ?? undefined,
				senderGeohashCell: myProfile.geohashCells ? JSON.parse(myProfile.geohashCells)?.[0] : undefined,
				firstMessageCiphertext: '', // empty — reconnection request, not a message
				firstMessageNonce: '',
				firstMessageEpoch: 0,
			});
			chatRequestSent = true;
		} catch (e: any) {
			if (e?.message?.includes('already pending')) {
				chatRequestSent = true;
			} else {
				rejoinError = 'failed to send chat request.';
			}
		} finally {
			requestingChat = false;
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
				// Sender Keys: re-wrap my key for all members (including the new one)
				await distributeMySenderKey(groupId);
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

	/** Clipboard write with fallback for mobile browsers */
	async function copyToClipboard(text: string): Promise<boolean> {
		// Try modern API first
		if (navigator.clipboard?.writeText) {
			try {
				await navigator.clipboard.writeText(text);
				return true;
			} catch {}
		}
		// Fallback: temporary textarea + execCommand
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.style.position = 'fixed';
		ta.style.left = '-9999px';
		ta.style.opacity = '0';
		document.body.appendChild(ta);
		ta.focus();
		ta.select();
		let ok = false;
		try { ok = document.execCommand('copy'); } catch {}
		document.body.removeChild(ta);
		return ok;
	}

	function getLinkOpts(): { maxUses?: number | null; expiresInHours?: number | null } {
		const maxUses = inviteLinkMaxUses ? parseInt(inviteLinkMaxUses) : null;
		const expiresInHours = inviteLinkExpiry ? parseFloat(inviteLinkExpiry) : null;
		return { maxUses: maxUses && maxUses > 0 ? maxUses : null, expiresInHours: expiresInHours && expiresInHours > 0 ? expiresInHours : null };
	}

	async function shareInvite() {
		if (!myDid) return;
		try {
			const key = randomHex(16);
			const hash = await sha256Hex(key);
			const url = `${window.location.origin}/invite#groupId=${encodeURIComponent(groupId)}&key=${encodeURIComponent(key)}`;

			if (typeof navigator.share !== 'undefined') {
				try {
					const name = convo?.peerName ?? 'meetmarket.io';
					await navigator.share({
						title: `Join ${name}`,
						text: `You're invited to ${name}. Tap to join and see who's nearby.`,
						url
					});
					// Store hash on server after share (don't block on it)
					setInviteLinkHash(groupId, myDid, hash, getLinkOpts()).catch(e => console.error('Failed to store invite hash:', e));
					return;
				} catch {}
			}
			// Copy to clipboard first while user gesture is still active
			await copyToClipboard(url);
			inviteLinkCopied = true;
			setTimeout(() => { inviteLinkCopied = false; }, 2000);
			// Then store hash on server
			setInviteLinkHash(groupId, myDid, hash, getLinkOpts()).catch(e => console.error('Failed to store invite hash:', e));
		} catch (e) {
			console.error('Failed to create invite link:', e);
		}
	}

	async function copyInviteLink() {
		if (!myDid) return;
		try {
			const key = randomHex(16);
			const hash = await sha256Hex(key);
			const url = `${window.location.origin}/invite#groupId=${encodeURIComponent(groupId)}&key=${encodeURIComponent(key)}`;
			// Copy to clipboard first while user gesture is still active
			await copyToClipboard(url);
			inviteLinkCopied = true;
			setTimeout(() => { inviteLinkCopied = false; }, 2000);
			// Then store hash on server (don't block clipboard on this)
			setInviteLinkHash(groupId, myDid, hash, getLinkOpts()).catch(e => console.error('Failed to store invite hash:', e));
		} catch (e) {
			console.error('Failed to copy invite link:', e);
		}
	}

	async function toggleMemberProfile(memberDid: string) {
		if (expandedMember === memberDid) {
			expandedMember = null;
			return;
		}
		expandedMember = memberDid;
		if (memberProfiles[memberDid]) return;
		loadingMemberProfile = memberDid;
		try {
			const identity = $identityStore.identity;
			const p = await getProfile(memberDid);
			let bio = p.bio || '';
			let age = p.age ?? null;
			let tags: string[] = [];
			// Try to decrypt encrypted fields
			if (p.encryptedFields && p.encryptedFieldsNonce && identity) {
				try {
					const { getProfileKeysForMe } = await import('$lib/api');
					const { decodeBase64 } = await import('$lib/crypto/util');
					const keys = await getProfileKeysForMe(identity.did);
					const match = keys.find((k: any) => k.ownerDid === memberDid);
					if (match && p.boxPublicKey) {
						const senderPub = decodeBase64(p.boxPublicKey);
						const decryptedKey = unwrapProfileKey(match.wrappedKey, match.wrappedKeyNonce, senderPub, identity.boxSecretKey);
						const fields = decryptProfileFields(p.encryptedFields, p.encryptedFieldsNonce, decryptedKey);
						bio = fields.bio || bio;
						age = fields.age ?? age;
						tags = fields.tags || [];
					}
				} catch {}
			}
			let avatarUrl: string | null = null;
			if (p.avatarMediaId) {
				if (p.avatarKey && p.avatarNonce) {
					avatarUrl = await getDecryptedAvatarUrl(p.avatarMediaId, p.avatarKey, p.avatarNonce) ?? null;
				} else {
					avatarUrl = `/media/${p.avatarMediaId}/blob`;
				}
			}
			memberProfiles = { ...memberProfiles, [memberDid]: { did: memberDid, displayName: p.displayName, bio, age, tags, avatarUrl, boxPublicKey: p.boxPublicKey ?? null } };
		} catch {}
		loadingMemberProfile = null;
	}

	function handleDmFromGroup(memberDid: string) {
		const mp = memberProfiles[memberDid];
		if (!mp) return;
		// Check if we already have a conversation with this person
		const existing = $conversationsStore.find(c => !c.isGroup && c.peerDid === memberDid);
		if (existing) {
			goto(`/chat/${existing.groupId}`);
		} else if (mp.boxPublicKey) {
			// Navigate with pending peer params to start a new DM
			const params = new URLSearchParams({
				peerDid: memberDid,
				peerName: mp.displayName,
				peerKey: mp.boxPublicKey
			});
			// Create deterministic groupId for DM
			const sortedDids = [myDid!, memberDid].sort();
			const dmGroupId = `dm-${sortedDids[0].slice(-8)}-${sortedDids[1].slice(-8)}`;
			goto(`/chat/${dmGroupId}?${params.toString()}`);
		}
	}

	const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'];

	function handleFileAttach(e: Event) {
		const target = e.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) return;
		target.value = '';

		if (!SUPPORTED_TYPES.includes(file.type)) {
			attachError = `${file.type || file.name.split('.').pop()} is not supported. use jpg, png, gif, webp, or mp4.`;
			setTimeout(() => { attachError = ''; }, 4000);
			return;
		}
		if (file.size > 50 * 1024 * 1024) {
			attachError = 'file too large. max 50MB.';
			setTimeout(() => { attachError = ''; }, 4000);
			return;
		}

		// Stage instead of sending immediately
		stagedFile = file;
		stagedPreviewUrl = URL.createObjectURL(file);
	}

	async function sendStagedMedia() {
		if (!stagedFile) return;
		const file = stagedFile;
		clearStaged();
		sending = true;
		pendingMessage = { text: 'sending...', isMedia: true };
		try {
			await ensureConversation();
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

	async function handleFlag(category: 'fake_profile' | 'harassment' | 'underage' | 'spam') {
		const state = $identityStore;
		if (!state.identity || !convo?.peerDid) return;
		flagSubmitting = true;
		try {
			const payload: FlagPayload = {
				flaggerDid: state.identity.did,
				flaggedDid: convo.peerDid,
				category,
				timestamp: Date.now(),
			};
			const { signedBlob, signature } = createSignedFlag(payload, state.identity.secretKey);
			await submitFlag({
				flaggerDid: state.identity.did,
				flaggedDid: convo.peerDid,
				category,
				signedBlob,
				signature,
			});
			flagSent = true;
			showFlagMenu = false;
			setTimeout(() => { flagSent = false; }, 3000);
		} catch (e) {
			console.error('[flag] submit failed:', e);
		} finally {
			flagSubmitting = false;
		}
	}

	function handleAddSearch(value: string) {
		addSearchQuery = value;
		if (!value.trim()) { addSearchResults = []; return; }
		// Only show people you have an existing conversation with (connected contacts)
		const q = value.trim().toLowerCase();
		addSearchResults = $conversationsStore
			.filter(c => !c.isGroup && c.peerDid && c.peerName.toLowerCase().includes(q))
			.map(c => ({ did: c.peerDid, displayName: c.peerName }));
	}
</script>

<div class="chat" class:map-mode={activeTab === 'map'}>
	<div class="card">
		<div class="card-header">
			<div class="header-top">
				<button class="back" onclick={() => goto('/chat')}>&larr;</button>
				<span class="title">{convo?.peerName ?? pendingPeer?.name ?? 'conversation'}</span>
				{#if isMuted}<span class="header-tag">muted</span>{/if}
				{#if hasLeft && !isGroupChat}<span class="header-tag left-header-tag">left</span>{/if}
				{#if peerLeft && !hasLeft && !isGroupChat}<span class="header-tag left-header-tag">{convo?.peerName ?? 'they'} left</span>{/if}
				{#if convo?.peerDid && !isGroupChat}
					<div class="menu-container">
						<button class="menu-btn" onclick={() => { showChatMenu = !showChatMenu; showReportSubmenu = false; }}>...</button>
						{#if showChatMenu}
							<div class="chat-dropdown">
								{#if !showReportSubmenu}
									<button class="menu-item" onclick={() => { showChatMenu = false; if (isMuted) { unmuteConversation(groupId); } else { muteConversation(groupId); } }}>{isMuted ? 'unmute' : 'mute'}</button>
									<button class="menu-item" onclick={async () => { showChatMenu = false; if (myDid && convo?.peerDid) { leaveDM(groupId, myDid).catch(() => {}); revokeProfileKey(myDid, convo.peerDid).catch(() => {}); revokeProfileKey(convo.peerDid, myDid).catch(() => {}); invalidateProfileKey(convo.peerDid).catch(() => {}); rotateMyProfileKey().catch(() => {}); } markConversationLeft(groupId); }}>leave chat</button>
									<button class="menu-item" onclick={() => { showReportSubmenu = true; }}>report &rarr;</button>
								{:else}
									<button class="menu-item" onclick={() => { showReportSubmenu = false; }}>&larr; back</button>
									<button class="menu-item" disabled={flagSubmitting} onclick={() => handleFlag('fake_profile')}>fake profile</button>
									<button class="menu-item" disabled={flagSubmitting} onclick={() => handleFlag('harassment')}>harassment</button>
									<button class="menu-item" disabled={flagSubmitting} onclick={() => handleFlag('underage')}>underage</button>
									<button class="menu-item" disabled={flagSubmitting} onclick={() => handleFlag('spam')}>spam</button>
								{/if}
							</div>
						{/if}
					</div>
				{/if}
				{#if flagSent}
					<span class="flag-toast">flagged</span>
				{/if}
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
					<button class="member-row" onclick={() => member.did !== myDid && toggleMemberProfile(member.did)}>
						<span class="member-name">{member.displayName}</span>
						<span class="member-role">{member.role ?? 'member'}</span>
						{#if member.did !== myDid}
							<span class="expand-arrow">{expandedMember === member.did ? '▾' : '›'}</span>
						{/if}
					</button>
					{#if expandedMember === member.did}
						<div class="member-card">
							{#if loadingMemberProfile === member.did}
								<span class="card-loading">loading...</span>
							{:else if memberProfiles[member.did]}
								{@const mp = memberProfiles[member.did]}
								<div class="card-top">
									{#if mp.avatarUrl}
										<img src={mp.avatarUrl} alt="" class="card-avatar" />
									{:else}
										<div class="card-avatar-placeholder">
											<span>{mp.displayName.charAt(0).toUpperCase()}</span>
										</div>
									{/if}
									<div class="card-info">
										<span class="card-name">{mp.displayName}{#if mp.age}, {mp.age}{/if}</span>
										{#if mp.bio}
											<span class="card-bio">{mp.bio}</span>
										{/if}
										{#if mp.tags.length > 0}
											<div class="card-tags">
												{#each mp.tags as tag}
													<span class="profile-tag">{tag}</span>
												{/each}
											</div>
										{/if}
									</div>
								</div>
								<div class="card-actions">
									<button class="small" onclick={() => handleDmFromGroup(member.did)}>message</button>
									{#if isAdmin && member.did !== myDid}
										<button class="small muted" onclick={() => handleKick(member.did)}>remove</button>
									{/if}
								</div>
							{/if}
						</div>
					{/if}
				{/each}

				{#if isAdmin}
					<div class="add-member">
						<input
							type="text"
							value={addSearchQuery}
							oninput={(e) => handleAddSearch(e.currentTarget.value)}
							placeholder="add from contacts..."
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
							<div class="member-row-static">
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

				{#if isAdmin}
					<button class="link-settings-toggle" onclick={() => showLinkSettings = !showLinkSettings}>
						link settings {showLinkSettings ? '▾' : '›'}
					</button>
					{#if showLinkSettings}
						<div class="link-settings">
							<label class="setting-row">
								<span class="setting-label">max uses</span>
								<input type="number" min="1" placeholder="unlimited" bind:value={inviteLinkMaxUses} class="setting-input" />
							</label>
							<label class="setting-row">
								<span class="setting-label">expires in (hours)</span>
								<input type="number" min="1" placeholder="never" bind:value={inviteLinkExpiry} class="setting-input" />
							</label>
							<p class="setting-hint">applies to the next link you generate</p>
						</div>
					{/if}
				{/if}

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
					{#if !convo && !pendingPeer}
						<p class="empty">conversation not found.</p>
					{:else}
						{#if !isGroupChat && peerProfile}
							<div class="profile-header">
								{#if peerProfile.avatarUrl}
									<img src={peerProfile.avatarUrl} alt="" class="profile-avatar" />
								{:else}
									<div class="profile-avatar-placeholder">
										<span>{peerProfile.displayName.charAt(0).toUpperCase()}</span>
									</div>
								{/if}
								<div class="profile-info">
									<span class="profile-name">
										{peerProfile.displayName}{#if peerProfile.age}, {peerProfile.age}{/if}
									</span>
									{#if peerProfile.bio}
										<span class="profile-bio">{peerProfile.bio}</span>
									{/if}
									{#if peerProfile.tags.length > 0}
										<div class="profile-tags">
											{#each peerProfile.tags as tag}
												<span class="profile-tag">{tag}</span>
											{/each}
										</div>
									{/if}
								</div>
							</div>
						{/if}
						{#if isGroupChat}
							<div class="system-msg">{isAdmin ? 'you created the group' : (convo?.peerName ?? '') + ' was created'}</div>
						{/if}
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
									{#if msg.isMine}
										<div class="bubble sent-media-bubble">
											<span class="sent-media-text">{msg.mimeType?.startsWith('video/') ? 'sent video' : 'sent photo'}</span>
										</div>
									{:else}
										<button class="bubble media-bubble" onclick={() => openMediaViewer(msg)} disabled={msg.viewed && msg.viewOnce}>
											{#if msg.viewed}
												<span class="media-text">opened</span>
											{:else}
												<span class="media-icon">&#9654;</span>
												<span class="media-text">{msg.mimeType?.startsWith('video/') ? 'Play video' : 'View photo'}</span>
											{/if}
										</button>
									{/if}
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
								<span class="text">{pendingMessage.text}</span>
							</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</div>

	{#if hasLeft}
		<div class="left-banner">
			{#if isGroupChat}
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
			{:else}
				<span class="left-text">you left this conversation.</span>
				{#if chatRequestSent}
					<span class="left-text">request sent — waiting for them to accept.</span>
				{:else}
					<button class="small" onclick={handleRequestChat} disabled={requestingChat}>
						{requestingChat ? 'requesting...' : 'request to chat'}
					</button>
				{/if}
				{#if rejoinError}
					<span class="left-error">{rejoinError}</span>
				{/if}
			{/if}
		</div>
	{:else if peerLeft && !isGroupChat}
		<div class="left-banner">
			<span class="left-text">{convo?.peerName ?? 'they'} left this conversation.</span>
			{#if chatRequestSent}
				<span class="left-text">request sent — waiting for them to accept.</span>
			{:else}
				<button class="small" onclick={handleRequestChat} disabled={requestingChat}>
					{requestingChat ? 'requesting...' : 'request to chat'}
				</button>
			{/if}
			{#if rejoinError}
				<span class="left-error">{rejoinError}</span>
			{/if}
		</div>
	{:else if activeTab === 'chat' || !isGroupChat}
		{#if attachError}
			<div class="attach-error">{attachError}</div>
		{/if}
		{#if stagedPreviewUrl}
			<div class="staged-preview">
				<img src={stagedPreviewUrl} alt="" class="preview-thumb" />
				<span class="view-once-label">view once</span>
				<button class="preview-remove" onclick={clearStaged}>&times;</button>
			</div>
		{/if}
		<form class="composer" class:has-preview={!!stagedPreviewUrl} onsubmit={(e) => { e.preventDefault(); handleSend(); }}>
			<input type="file" accept=".jpg,.jpeg,.png,.gif,.webp,.mp4,.mov,.webm" onchange={handleFileAttach} hidden bind:this={fileInput} />
			<button type="button" class="attach-btn" onclick={() => fileInput?.click()} disabled={!convo && !pendingPeer}>+</button>
			<input type="text" bind:value={input} placeholder="message..." disabled={(!convo && !pendingPeer) || sending} />
			<button type="submit" disabled={(!convo && !pendingPeer) || sending || (!input.trim() && !stagedFile)}>send</button>
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
		height: calc(100dvh - var(--nav-height) - var(--safe-bottom) - 24px - 8px);
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
		padding: 0 16px 0 0;
		position: relative;
		min-height: 48px;
		border-bottom: 1px solid var(--border);
	}
	.back {
		border: none;
		padding: 4px 8px;
		font-size: 16px;
		color: var(--text-muted);
		min-width: 48px;
		min-height: calc(48px - 1px);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	@media (hover: hover) {
		.back:hover { color: var(--text); background: transparent; }
	}
	.title {
		color: var(--text-muted);
		font-size: 14px;
	}
	.header-tag {
		font-size: 11px;
		color: var(--text-muted);
		border: 1px solid var(--border);
		padding: 1px 6px;
		border-radius: var(--radius);
		opacity: 0.5;
	}
	.left-header-tag {
		color: var(--danger);
		border-color: var(--danger);
		opacity: 0.6;
	}
	.tab-bar {
		border-top: none;
	}
	.tab-bar .tab {
		min-height: calc(48px - 1px);
	}
	/* Profile header (DM) */
	.profile-header {
		display: flex;
		gap: 12px;
		padding: 12px 0 16px;
		margin-bottom: 8px;
		border-bottom: 1px solid var(--border);
	}
	.profile-avatar {
		width: 56px;
		height: 56px;
		border-radius: 2px;
		object-fit: cover;
		flex-shrink: 0;
	}
	.profile-avatar-placeholder {
		width: 56px;
		height: 56px;
		border-radius: 2px;
		background: var(--bg-surface);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.profile-avatar-placeholder span {
		font-size: 22px;
		color: var(--text-tertiary);
		font-weight: 300;
	}
	.profile-info {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}
	.profile-name {
		font-size: 14px;
		color: var(--text);
		font-weight: 500;
	}
	.profile-bio {
		font-size: 13px;
		color: var(--text-muted);
		line-height: 1.4;
	}
	.profile-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 2px;
	}
	.profile-tag {
		font-size: 11px;
		color: var(--text-muted);
		border: 1px solid var(--border);
		padding: 2px 8px;
		line-height: 1.3;
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
		opacity: 0.5;
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

	.attach-error {
		font-size: 12px;
		color: var(--text-muted);
		padding: 6px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin-bottom: 4px;
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
		gap: 0;
		overflow-y: auto;
	}
	.member-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 0;
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--border);
		cursor: pointer;
		text-align: left;
		min-height: auto;
		width: 100%;
	}
	.member-row:last-of-type {
		border-bottom: none;
	}
	@media (hover: hover) {
		.member-row:hover { background: var(--bg-hover); }
	}
	.member-row-static {
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
	.expand-arrow {
		margin-left: auto;
		color: var(--text-muted);
		font-size: 12px;
	}
	/* Expanded member card */
	.member-card {
		padding: 12px 0 16px;
		border-bottom: 1px solid var(--border);
	}
	.card-loading {
		font-size: 13px;
		color: var(--text-muted);
	}
	.card-top {
		display: flex;
		gap: 12px;
	}
	.card-avatar {
		width: 56px;
		height: 56px;
		border-radius: 2px;
		object-fit: cover;
		flex-shrink: 0;
	}
	.card-avatar-placeholder {
		width: 56px;
		height: 56px;
		border-radius: 2px;
		background: var(--bg-surface);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.card-avatar-placeholder span {
		font-size: 22px;
		color: var(--text-tertiary);
		font-weight: 300;
	}
	.card-info {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}
	.card-name {
		font-size: 14px;
		color: var(--text);
		font-weight: 500;
	}
	.card-bio {
		font-size: 13px;
		color: var(--text-muted);
		line-height: 1.4;
	}
	.card-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 2px;
	}
	.card-actions {
		display: flex;
		gap: 8px;
		margin-top: 10px;
	}
	/* Link settings */
	.link-settings-toggle {
		background: transparent;
		border: none;
		color: var(--text-muted);
		font-size: 13px;
		padding: 8px 0;
		cursor: pointer;
		text-align: left;
		min-height: auto;
	}
	@media (hover: hover) {
		.link-settings-toggle:hover { color: var(--text); }
	}
	.link-settings {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 0 0 8px;
	}
	.setting-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.setting-label {
		font-size: 13px;
		color: var(--text-muted);
		flex-shrink: 0;
		min-width: 100px;
	}
	.setting-input {
		flex: 1;
		padding: 6px 8px;
		font-size: 13px;
		min-height: auto;
	}
	.setting-hint {
		font-size: 12px;
		color: var(--text-tertiary);
		margin: 0;
	}
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
	.sent-media-bubble {
		background: transparent;
		border-color: var(--border);
	}
	.sent-media-text {
		font-size: 14px;
		color: var(--text-muted);
		font-style: italic;
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

	/* Chat menu (3-dot) */
	.menu-container {
		position: relative;
		margin-left: auto;
	}
	.menu-btn {
		background: transparent;
		border: none;
		color: var(--text-muted);
		font-size: 18px;
		padding: 4px 8px;
		cursor: pointer;
		min-height: auto;
		line-height: 1;
		letter-spacing: 2px;
	}
	.chat-dropdown {
		position: absolute;
		top: 100%;
		right: 0;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		z-index: 10;
		min-width: 140px;
		overflow: hidden;
	}
	.menu-item {
		display: block;
		width: 100%;
		padding: 10px 14px;
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--border);
		color: var(--text);
		font-size: 13px;
		text-align: left;
		cursor: pointer;
		min-height: auto;
	}
	.menu-item:last-child {
		border-bottom: none;
	}
	@media (hover: hover) {
		.menu-item:hover {
			background: var(--bg-hover);
		}
	}
	.menu-item:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.flag-toast {
		font-size: 12px;
		color: var(--text-muted);
		margin-left: 8px;
	}
</style>
