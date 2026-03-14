<script lang="ts">
	import { formatDistance } from '$lib/utils/distance';

	interface Props {
		displayName: string;
		age: number | null;
		bio: string;
		tags?: string[];
		avatarUrl: string | null;
		distance?: number | null;
		groupsInCommon?: number;
		groupNames?: string[];
		expanded?: boolean;
	}

	let { displayName, age, bio, tags = [], avatarUrl, distance = null, groupsInCommon = 0, groupNames = [], expanded = false }: Props = $props();

	let showGroupNames = $state(false);
</script>

{#if expanded}
	<div class="pev-full">
		<div class="pev-full-img-wrap">
			{#if avatarUrl}
				<img src={avatarUrl} alt="" class="pev-full-img" />
			{:else}
				<div class="pev-full-img-placeholder">
					<span>{displayName.charAt(0).toUpperCase()}</span>
				</div>
			{/if}
		</div>
		<div class="pev-full-info">
			<div class="pev-full-name-row">
				<span class="pev-full-name">{displayName}</span>
				{#if age}<span class="pev-full-age">{age}</span>{/if}
			</div>
			{#if bio}
				<p class="pev-full-bio">{bio}</p>
			{/if}
			{#if distance}
				<span class="pev-full-dist">{formatDistance(distance)}</span>
			{/if}
			{#if groupsInCommon > 0}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<span class="pev-full-groups" onclick={(e) => { e.stopPropagation(); showGroupNames = !showGroupNames; }}>
					{groupsInCommon} group{groupsInCommon > 1 ? 's' : ''} in common {showGroupNames ? '\u2212' : '+'}
				</span>
				{#if showGroupNames && groupNames.length > 0}
					<div class="pev-full-groups-list">
						{#each groupNames as name}
							<span>{#if name.endsWith(' [this group]')}{name.replace(' [this group]', '')} <span class="pev-this-group-tag">this group</span>{:else}{name}{/if}</span>
						{/each}
					</div>
				{/if}
			{/if}
			{#if tags.length > 0}
				<div class="pev-full-tags">
					{#each tags as tag}
						<span class="pev-full-tag">{tag}</span>
					{/each}
				</div>
			{/if}
		</div>
	</div>
{:else}
	<div class="pev">
		<div class="pev-img-wrap">
			{#if avatarUrl}
				<img src={avatarUrl} alt="" class="pev-img" />
			{:else}
				<div class="pev-img-placeholder">
					<span>{displayName.charAt(0).toUpperCase()}</span>
				</div>
			{/if}
		</div>
		<div class="pev-info">
			<div class="pev-name-row">
				<span class="pev-name">{displayName}</span>
				{#if age}<span class="pev-age">{age}</span>{/if}
			</div>
			{#if distance || bio}
				<div class="pev-bio-row">
					{#if distance}<span class="pev-dist">{formatDistance(distance)}</span>{/if}
					{#if bio}<span class="pev-bio">{bio}</span>{/if}
				</div>
			{/if}
			{#if groupsInCommon > 0}
				<span class="pev-groups">{groupsInCommon} group{groupsInCommon > 1 ? 's' : ''} in common</span>
			{/if}
			{#if tags.length > 0}
				<div class="pev-tags">
					{#each tags as tag}
						<span class="pev-tag">{tag}</span>
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* ── Compact horizontal card ── */
	.pev {
		display: flex;
		flex-direction: row;
		gap: 14px;
		align-items: center;
	}
	.pev-img-wrap {
		width: 80px;
		height: 80px;
		flex-shrink: 0;
		overflow: hidden;
	}
	.pev-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.pev-img-placeholder {
		width: 100%;
		height: 100%;
		background: var(--bg-surface);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.pev-img-placeholder span {
		font-size: 28px;
		color: var(--text-tertiary);
		font-weight: 300;
	}
	.pev-info {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
		flex: 1;
	}
	.pev-name-row {
		display: flex;
		align-items: baseline;
		gap: 6px;
	}
	.pev-name {
		font-size: 15px;
		color: var(--text);
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pev-age {
		font-size: 13px;
		color: var(--text-muted);
		font-weight: 400;
		flex-shrink: 0;
	}
	.pev-bio-row {
		display: flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
	}
	.pev-bio {
		font-size: 13px;
		color: var(--text-muted);
		line-height: 1.4;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.pev-dist {
		font-size: 13px;
		color: var(--text-tertiary);
		flex-shrink: 0;
		white-space: nowrap;
	}
	.pev-groups {
		font-size: 12px;
		color: var(--text-tertiary);
		line-height: 1.4;
	}
	.pev-tags {
		display: flex;
		flex-wrap: nowrap;
		gap: 6px;
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: none;
		margin-top: 2px;
	}
	.pev-tags::-webkit-scrollbar {
		display: none;
	}
	.pev-tag {
		font-size: 11px;
		color: var(--text-muted);
		border: 1px solid var(--border);
		padding: 2px 8px;
		border-radius: 3px;
		line-height: 1.3;
		flex-shrink: 0;
		white-space: nowrap;
	}

	/* ── Full expand vertical layout ── */
	.pev-full {
		display: flex;
		flex-direction: column;
		width: 100%;
	}
	.pev-full-img-wrap {
		width: 100%;
		aspect-ratio: 3 / 4;
		overflow: hidden;
	}
	.pev-full-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.pev-full-img-placeholder {
		width: 100%;
		height: 100%;
		background: var(--bg-surface);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.pev-full-img-placeholder span {
		font-size: 64px;
		color: var(--text-tertiary);
		font-weight: 300;
	}
	.pev-full-info {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 16px 0 0;
	}
	.pev-full-name-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.pev-full-name {
		font-size: 18px;
		color: var(--text);
		font-weight: 500;
	}
	.pev-full-age {
		font-size: 15px;
		color: var(--text-muted);
		font-weight: 400;
	}
	.pev-full-bio {
		font-size: 14px;
		color: var(--text-muted);
		line-height: 1.5;
		margin: 0;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.pev-full-dist {
		font-size: 13px;
		color: var(--text-tertiary);
	}
	.pev-full-groups {
		font-size: 13px;
		color: var(--text-tertiary);
		cursor: pointer;
	}
	.pev-full-groups-list {
		padding-left: 12px;
	}
	.pev-full-groups-list > span {
		color: var(--text-muted);
		font-size: 12px;
		display: flex;
		align-items: center;
		gap: 6px;
		line-height: 1.8;
	}
	.pev-this-group-tag {
		font-size: 11px;
		color: var(--text-muted);
		border: 1px solid var(--border);
		padding: 1px 6px;
		border-radius: var(--radius, 3px);
		line-height: 1.3;
	}
	.pev-full-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 4px;
	}
	.pev-full-tag {
		font-size: 12px;
		color: var(--text-muted);
		border: 1px solid var(--border);
		padding: 3px 10px;
		border-radius: 3px;
		line-height: 1.3;
	}
</style>
