/**
 * API client for the proximity server.
 */

/** API base: env var in dev, same origin in production. */
export const BASE = import.meta.env.VITE_API_URL || (typeof window !== 'undefined' ? window.location.origin : '');

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		headers: { 'Content-Type': 'application/json', ...opts.headers as Record<string, string> },
		...opts
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error || `request failed: ${res.status}`);
	}
	return res.json();
}

// --- Auth ---

export function register(did: string, displayName: string, publicKey: string, boxPublicKey: string) {
	return request<{ ok: boolean; did: string }>('/auth/register', {
		method: 'POST',
		body: JSON.stringify({ did, displayName, publicKey, boxPublicKey })
	});
}

// --- Profiles ---

export function updateProfile(did: string, data: {
	displayName?: string;
	bio?: string;
	age?: number;
	geohashCells?: string[];
	avatarMediaId?: string;
	avatarKey?: string;
	avatarNonce?: string;
	instagram?: string;
	profileLink?: string;
	encryptedFields?: string;
	encryptedFieldsNonce?: string;
	profileKeyVersion?: number;
}) {
	return request<{ ok: boolean }>(`/profiles/${encodeURIComponent(did)}`, {
		method: 'PUT',
		body: JSON.stringify(data)
	});
}

export function discoverProfiles(cells: string[], requesterDid?: string) {
	let url = `/profiles/discover?cells=${cells.join(',')}`;
	if (requesterDid) url += `&requesterDid=${encodeURIComponent(requesterDid)}`;
	return request<Array<{
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
		encryptedFields: string | null;
		encryptedFieldsNonce: string | null;
		profileKeyVersion: number | null;
		wrappedProfileKey: string | null;
		wrappedProfileKeyNonce: string | null;
		wrappedProfileKeyVersion: number | null;
		geohashCell: string;
		lastSeen: string;
	}>>(url);
}

export function searchProfiles(query: string, requesterDid?: string) {
	let url = `/profiles/search?q=${encodeURIComponent(query)}`;
	if (requesterDid) url += `&requesterDid=${encodeURIComponent(requesterDid)}`;
	return request<Array<{
		did: string;
		displayName: string;
		boxPublicKey: string | null;
	}>>(url);
}

export function deleteProfile(did: string) {
	return request<{ ok: boolean }>(`/profiles/${encodeURIComponent(did)}`, {
		method: 'DELETE'
	});
}

export function getProfile(did: string) {
	return request<{
		did: string;
		displayName: string;
		bio: string;
		age: number | null;
		publicKey: string | null;
		boxPublicKey: string | null;
		avatarMediaId: string | null;
		avatarKey: string | null;
		avatarNonce: string | null;
		instagram: string | null;
		profileLink: string | null;
		encryptedFields: string | null;
		encryptedFieldsNonce: string | null;
		profileKeyVersion: number | null;
		geohashCells: string;
		lastSeen: string;
	}>(`/profiles/${encodeURIComponent(did)}`);
}

// --- Profile Keys ---

export function storeProfileKeys(ownerDid: string, keys: Array<{ recipientDid: string; wrappedKey: string; wrappedKeyNonce: string; keyVersion: number }>) {
	return request<{ ok: boolean }>('/profiles/keys', {
		method: 'POST',
		body: JSON.stringify({ ownerDid, keys })
	});
}

export function getProfileKeysForMe(recipientDid: string) {
	return request<Array<{
		ownerDid: string;
		wrappedKey: string;
		wrappedKeyNonce: string;
		keyVersion: number;
	}>>(`/profiles/keys?recipientDid=${encodeURIComponent(recipientDid)}`);
}

export function revokeProfileKey(ownerDid: string, recipientDid: string) {
	return request<{ ok: boolean }>('/profiles/keys', {
		method: 'DELETE',
		body: JSON.stringify({ ownerDid, recipientDid })
	});
}

// --- Messages ---

export function sendMessage(data: {
	groupId: string;
	senderDid: string;
	recipientDid: string;
	epoch: number;
	ciphertext: string;
	nonce: string;
	dhPublicKey?: string;
	previousCounter?: number;
}) {
	return request<{ ok: boolean; id: string }>('/messages', {
		method: 'POST',
		body: JSON.stringify(data)
	});
}

export function fetchMessages(did: string, since?: string) {
	const params = new URLSearchParams({ did });
	if (since) params.set('since', since);
	return request<{
		messages: Array<{
			id: string;
			groupId: string;
			senderDid: string;
			recipientDid: string;
			epoch: number;
			ciphertext: string;
			nonce: string;
			dhPublicKey?: string;
			previousCounter?: number;
			createdAt: string;
		}>;
		sealed: Array<{
			id: string;
			recipientDid: string;
			sealedPayload: string;
			ephemeralPublicKey: string;
			nonce: string;
			createdAt: string;
		}>;
	}>(`/messages?${params}`);
}

// --- Groups ---

export function createGroup(name: string, creatorDid: string, initialMembers?: string[]) {
	return request<{ ok: boolean; groupId: string }>('/groups', {
		method: 'POST',
		body: JSON.stringify({ name, creatorDid, initialMembers })
	});
}

export function listGroups(did: string) {
	return request<Array<{
		id: string;
		name: string;
		creatorDid: string;
		role: string;
		members: Array<{ did: string; role: string }>;
		createdAt: string;
	}>>(`/groups?did=${encodeURIComponent(did)}`);
}

export function getGroup(groupId: string) {
	return request<{
		id: string;
		name: string;
		creatorDid: string;
		members: Array<{ did: string; role: string; displayName: string; boxPublicKey: string | null }>;
		createdAt: string;
	}>(`/groups/${groupId}`);
}

export function inviteToGroup(groupId: string, inviterDid: string, inviteeDid: string) {
	return request<{ ok: boolean; inviteId: string }>(`/groups/${groupId}/invite`, {
		method: 'POST',
		body: JSON.stringify({ inviterDid, inviteeDid })
	});
}

export function listPendingInvites(did: string) {
	return request<Array<{
		id: string;
		groupId: string;
		inviterDid: string;
		groupName: string;
		groupDescription: string;
		memberCount: number;
		inviterDisplayName: string;
		createdAt: string;
	}>>(`/groups/invites/pending?did=${encodeURIComponent(did)}`);
}

export function respondToInvite(inviteId: string, action: 'accept' | 'decline') {
	return request<{ ok: boolean; groupId?: string }>(`/groups/invites/${inviteId}/respond`, {
		method: 'POST',
		body: JSON.stringify({ action })
	});
}

export function leaveGroup(groupId: string, did: string) {
	return request<{ ok: boolean }>(`/groups/${groupId}/leave`, {
		method: 'POST',
		body: JSON.stringify({ did })
	});
}

export function kickMember(groupId: string, did: string, targetDid: string) {
	return request<{ ok: boolean }>(`/groups/${groupId}/kick`, {
		method: 'POST',
		body: JSON.stringify({ did, targetDid })
	});
}

// --- Invite Links ---

export function setInviteLinkHash(groupId: string, did: string, inviteKeyHash: string, opts?: { maxUses?: number | null; expiresInHours?: number | null }) {
	return request<{ ok: boolean }>(`/groups/${groupId}/invite-link`, {
		method: 'POST',
		body: JSON.stringify({ did, inviteKeyHash, maxUses: opts?.maxUses, expiresInHours: opts?.expiresInHours })
	});
}

export function joinGroupViaInvite(groupId: string, did: string, inviteKey: string) {
	return request<{ ok: boolean; groupId: string; alreadyMember?: boolean }>(`/groups/${groupId}/join`, {
		method: 'POST',
		body: JSON.stringify({ did, inviteKey })
	});
}

export function requestJoinGroup(groupId: string, did: string) {
	return request<{ ok: boolean; alreadyMember?: boolean; alreadyRequested?: boolean }>(`/groups/${groupId}/request-join`, {
		method: 'POST',
		body: JSON.stringify({ did })
	});
}

export function listJoinRequests(groupId: string, did: string) {
	return request<Array<{
		id: string;
		did: string;
		displayName: string;
		createdAt: string;
	}>>(`/groups/${groupId}/join-requests?did=${encodeURIComponent(did)}`);
}

export function respondToJoinRequest(groupId: string, requestId: string, did: string, action: 'approve' | 'deny') {
	return request<{ ok: boolean }>(`/groups/${groupId}/join-requests/${requestId}/respond`, {
		method: 'POST',
		body: JSON.stringify({ did, action })
	});
}

export function listMyAdminJoinRequests(did: string) {
	return request<Array<{
		id: string;
		groupId: string;
		groupName: string;
		requesterDid: string;
		requesterName: string;
		createdAt: string;
	}>>(`/groups/my-admin-join-requests?did=${encodeURIComponent(did)}`);
}

export function revokeInviteLink(groupId: string, did: string) {
	return request<{ ok: boolean }>(`/groups/${groupId}/invite-link`, {
		method: 'DELETE',
		body: JSON.stringify({ did })
	});
}

// --- Moderation ---

export function blockUser(blockerDid: string, blockedDid: string) {
	return request<{ ok: boolean }>('/moderation/block', {
		method: 'POST',
		body: JSON.stringify({ blockerDid, blockedDid })
	});
}

export function unblockUser(blockerDid: string, blockedDid: string) {
	return request<{ ok: boolean }>('/moderation/unblock', {
		method: 'POST',
		body: JSON.stringify({ blockerDid, blockedDid })
	});
}

export function listBlocks(did: string) {
	return request<Array<{ blockedDid: string; createdAt: string }>>(`/moderation/blocks?did=${encodeURIComponent(did)}`);
}

export function reportUser(reporterDid: string, reportedDid: string, reason: string, details?: string) {
	return request<{ ok: boolean }>('/moderation/report', {
		method: 'POST',
		body: JSON.stringify({ reporterDid, reportedDid, reason, details })
	});
}

export function submitFlag(data: {
	flaggerDid: string;
	flaggedDid: string;
	category: string;
	signedBlob: string;
	signature: string;
}) {
	return request<{ ok: boolean }>('/moderation/flag', {
		method: 'POST',
		body: JSON.stringify(data)
	});
}

export function getFlagStatus(did: string) {
	return request<{
		level: 'none' | 'throttled' | 'hidden';
		reason?: string;
		effectiveAt?: string;
		expiresAt?: string;
		appealedAt?: string;
		expired?: boolean;
	}>(`/moderation/flag-status?did=${encodeURIComponent(did)}`);
}

export function submitAppeal(did: string) {
	return request<{ ok: boolean }>('/moderation/appeal', {
		method: 'POST',
		body: JSON.stringify({ did })
	});
}

export function checkCsam(mediaId: string, perceptualHash: string) {
	return request<{ blocked: boolean }>('/moderation/check-csam', {
		method: 'POST',
		body: JSON.stringify({ mediaId, perceptualHash })
	});
}

// --- Group Keys ---

export function storeGroupKeys(groupId: string, senderDid: string, keys: Array<{ memberDid: string; wrappedKey: string; wrappedKeyNonce: string }>, epoch: number) {
	return request<{ ok: boolean }>(`/groups/${groupId}/keys`, {
		method: 'POST',
		body: JSON.stringify({ senderDid, keys, epoch })
	});
}

export function getMyGroupKeys(groupId: string, did: string) {
	return request<Array<{
		id: string;
		groupId: string;
		memberDid: string;
		wrappedKey: string;
		wrappedKeyNonce: string;
		senderDid: string;
		epoch: number;
		createdAt: string;
	}>>(`/groups/${groupId}/keys/${encodeURIComponent(did)}`);
}

// --- Media ---

export async function uploadMedia(uploaderDid: string, encryptedFile: Blob, mimeType: string, mediaKeyWrapped?: string, viewOnce?: boolean) {
	const formData = new FormData();
	formData.append('file', encryptedFile);
	formData.append('uploaderDid', uploaderDid);
	formData.append('mimeType', mimeType);
	if (mediaKeyWrapped) formData.append('mediaKeyWrapped', mediaKeyWrapped);
	if (viewOnce) formData.append('viewOnce', 'true');

	const res = await fetch(`${BASE}/media/upload`, {
		method: 'POST',
		body: formData
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error || `upload failed: ${res.status}`);
	}
	return res.json() as Promise<{ ok: boolean; mediaId: string }>;
}

export function getMedia(mediaId: string) {
	return request<{
		id: string;
		uploaderDid: string;
		mediaKeyWrapped: string;
		mimeType: string;
		size: number;
		encryptedBlob: string | null;
	}>(`/media/${mediaId}`);
}

export async function getMediaBlob(mediaId: string): Promise<ArrayBuffer> {
	const res = await fetch(`${BASE}/media/${mediaId}/blob`);
	if (!res.ok) throw new Error('Failed to fetch media');
	return res.arrayBuffer();
}

export function notifyMediaViewed(mediaId: string, did: string) {
	return request<{ ok: boolean }>(`/media/${mediaId}/viewed`, {
		method: 'POST',
		body: JSON.stringify({ did })
	});
}

// --- Sealed Media Upload ---

export async function uploadMediaSealed(deliveryToken: string, encryptedFile: Blob, mimeType: string, viewOnce?: boolean) {
	const formData = new FormData();
	formData.append('file', encryptedFile);
	formData.append('deliveryToken', deliveryToken);
	formData.append('mimeType', mimeType);
	if (viewOnce) formData.append('viewOnce', 'true');

	const res = await fetch(`${BASE}/media/upload-sealed`, {
		method: 'POST',
		body: formData
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error || `sealed upload failed: ${res.status}`);
	}
	return res.json() as Promise<{ ok: boolean; mediaId: string }>;
}

// --- Sealed Sender ---

export function registerDeliveryToken(did: string, tokenHash: string) {
	return request<{ ok: boolean }>('/messages/delivery-token', {
		method: 'POST',
		body: JSON.stringify({ did, tokenHash })
	});
}

export function sendSealedMessage(data: {
	recipientDid: string;
	deliveryToken: string;
	sealedPayload: string;
	ephemeralPublicKey: string;
	nonce: string;
}) {
	return request<{ ok: boolean; id: string }>('/messages/sealed', {
		method: 'POST',
		body: JSON.stringify(data)
	});
}

export function registerGroupDeliveryToken(groupId: string, tokenHash: string) {
	return request<{ ok: boolean }>('/messages/group-delivery-token', {
		method: 'POST',
		body: JSON.stringify({ groupId, tokenHash })
	});
}

export function sendSealedGroupMessage(data: {
	groupId: string;
	deliveryToken: string;
	ciphertext: string;
	nonce: string;
	epoch: number;
}) {
	return request<{ ok: boolean; ids: string[] }>('/messages/sealed-group', {
		method: 'POST',
		body: JSON.stringify(data)
	});
}

// --- DM Invitations ---

export function sendDMInvitation(data: {
	senderDid: string;
	recipientDid: string;
	groupId: string;
	senderDisplayName: string;
	senderAvatarMediaId?: string;
	senderAvatarKey?: string;
	senderAvatarNonce?: string;
	senderGeohashCell?: string;
	firstMessageCiphertext: string;
	firstMessageNonce: string;
	firstMessageEpoch: number;
	firstMessageDhPublicKey?: string;
	firstMessagePreviousCounter?: number;
}) {
	return request<{ ok: boolean; id: string }>('/invitations/dm', {
		method: 'POST',
		body: JSON.stringify(data)
	});
}

export function getDMInvitations(did: string) {
	return request<Array<{
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
	}>>(`/invitations/dm?did=${encodeURIComponent(did)}`);
}

export function acceptDMInvitation(id: string) {
	return request<{ ok: boolean; groupId: string }>(`/invitations/dm/${id}/accept`, {
		method: 'POST'
	});
}

export function blockDMInvitation(id: string) {
	return request<{ ok: boolean }>(`/invitations/dm/${id}/block`, {
		method: 'POST'
	});
}

export function leaveDM(groupId: string, did: string) {
	return request<{ ok: boolean }>('/invitations/dm-leave', {
		method: 'POST',
		body: JSON.stringify({ groupId, did })
	});
}

export function getDMStatus(groupId: string) {
	return request<Array<{ leaverDid: string; createdAt: string }>>(`/invitations/dm-status?groupId=${encodeURIComponent(groupId)}`);
}

export function clearDMLeave(groupId: string) {
	return request<{ ok: boolean }>('/invitations/dm-leave', {
		method: 'DELETE',
		body: JSON.stringify({ groupId })
	});
}

// --- Newsletter ---

export function subscribeNewsletter(email: string, name: string) {
	return request<{ ok: boolean }>('/newsletter/subscribe', {
		method: 'POST',
		body: JSON.stringify({ email, name })
	});
}
