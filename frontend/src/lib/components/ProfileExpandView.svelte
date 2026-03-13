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
		compact?: boolean;
		expanded?: boolean;
	}

	let { displayName, age, bio, tags = [], avatarUrl, distance = null, groupsInCommon = 0, compact = false, expanded = false }: Props = $props();

	function metaLine(): string {
		const parts: string[] = [];
		if (distance) parts.push(formatDistance(distance));
		if (groupsInCommon > 0) parts.push(`${groupsInCommon} group${groupsInCommon > 1 ? 's' : ''} in common`);
		return parts.join(' \u00B7 ');
	}
</script>

{#if expanded}
	<div class="pev-full">
		{#if avatarUrl}
			<div class="pev-full-img-wrap">
				<img src={avatarUrl} alt="" class="pev-full-img" />
			</div>
		{:else}
			<div class="pev-full-img-placeholder">
				<span>{displayName.charAt(0).toUpperCase()}</span>
			</div>
		{/if}
		<div class="pev-full-info">
			<div class="pev-full-name-row">
				<span class="pev-full-name">{displayName}</span>
				{#if age}<span class="pev-full-age">{age}</span>{/if}
			</div>
			{#if bio}
				<p class="pev-full-bio">{bio}</p>
			{/if}
			{#if metaLine()}
				<span class="pev-full-meta">{metaLine()}</span>
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
	<div class="pev" class:compact>
		{#if avatarUrl}
			<img src={avatarUrl} alt="" class="pev-img" />
		{:else}
			<div class="pev-img-placeholder">
				<span>{displayName.charAt(0).toUpperCase()}</span>
			</div>
		{/if}
		<div class="pev-info">
			<div class="pev-name-row">
				<span class="pev-name">{displayName}</span>
				{#if age}<span class="pev-age">{age}</span>{/if}
			</div>
			{#if bio}
				<span class="pev-bio">{bio}</span>
			{/if}
			{#if metaLine()}
				<span class="pev-meta">{metaLine()}</span>
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
	/* ── Compact / default horizontal card ── */
	.pev {
		display: flex;
		flex-direction: row;
		gap: 12px;
		align-items: flex-start;
	}
	.pev-img {
		width: 88px;
		height: 88px;
		object-fit: cover;
		border-radius: 2px;
		flex-shrink: 0;
	}
	.pev-img-placeholder {
		width: 88px;
		height: 88px;
		background: var(--bg-surface);
		border-radius: 2px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.pev-img-placeholder span {
		font-size: 32px;
		color: var(--text-tertiary);
		font-weight: 300;
	}
	.compact .pev-img,
	.compact .pev-img-placeholder {
		width: 72px;
		height: 72px;
	}
	.compact .pev-img-placeholder span {
		font-size: 26px;
	}
	.pev-info {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
		flex: 1;
		padding-top: 2px;
	}
	.pev-name-row {
		display: flex;
		align-items: baseline;
		gap: 6px;
	}
	.pev-name {
		font-size: 14px;
		color: var(--text);
		font-weight: 400;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pev-age {
		font-size: 13px;
		color: var(--text-tertiary);
		font-weight: 400;
		flex-shrink: 0;
	}
	.pev-bio {
		font-size: 13px;
		color: var(--text-muted);
		line-height: 1.4;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pev-meta {
		font-size: 12px;
		color: var(--text-tertiary);
		line-height: 1.4;
	}
	.pev-tags {
		display: flex;
		flex-wrap: nowrap;
		gap: 4px;
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: none;
		margin-top: 1px;
	}
	.pev-tags::-webkit-scrollbar {
		display: none;
	}
	.pev-tag {
		font-size: 11px;
		color: var(--text-muted);
		border: 1px solid var(--border);
		padding: 1px 7px;
		border-radius: 2px;
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
		border-radius: 2px;
	}
	.pev-full-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.pev-full-img-placeholder {
		width: 100%;
		aspect-ratio: 3 / 4;
		background: var(--bg-surface);
		border-radius: 2px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.pev-full-img-placeholder span {
		font-size: 56px;
		color: var(--text-tertiary);
		font-weight: 300;
	}
	.pev-full-info {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 12px 0 0;
	}
	.pev-full-name-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.pev-full-name {
		font-size: 18px;
		color: var(--text);
		font-weight: 400;
	}
	.pev-full-age {
		font-size: 16px;
		color: var(--text-tertiary);
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
	.pev-full-meta {
		font-size: 13px;
		color: var(--text-tertiary);
		line-height: 1.4;
	}
	.pev-full-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		margin-top: 2px;
	}
	.pev-full-tag {
		font-size: 12px;
		color: var(--text-muted);
		border: 1px solid var(--border);
		padding: 2px 9px;
		border-radius: 2px;
		line-height: 1.3;
	}
</style>