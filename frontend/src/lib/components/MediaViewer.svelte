<script lang="ts">
	/**
	 * Fullscreen view-once media viewer.
	 * Fetches + decrypts media, shows on canvas (no downloadable <img> element).
	 * On close, triggers onclose callback which wipes the media key.
	 */
	import { getMediaBlob } from '$lib/api';
	import { decryptMedia, bytesToObjectUrl } from '$lib/crypto/media';
	import { onMount } from 'svelte';

	interface Props {
		mediaId: string;
		mediaKey: string;
		mediaNonce: string;
		mimeType: string;
		onclose: () => void;
	}

	let { mediaId, mediaKey, mediaNonce, mimeType, onclose }: Props = $props();

	let loading = $state(true);
	let loadingStatus = $state('fetching...');
	let error = $state('');
	let objectUrl = $state<string | null>(null);
	let canvas = $state<HTMLCanvasElement | undefined>();

	let isVideo = $derived(mimeType.startsWith('video/'));
	let countdown = $state(5);
	let autoCloseTimer: ReturnType<typeof setInterval> | null = null;

	// Block screenshots via Visibility API — blank the viewer when app is backgrounded
	function handleVisibility() {
		if (document.hidden && canvas) {
			const ctx = canvas.getContext('2d');
			if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
		}
	}

	onMount(() => {
		document.addEventListener('visibilitychange', handleVisibility);
		return () => {
			document.removeEventListener('visibilitychange', handleVisibility);
			if (autoCloseTimer) clearInterval(autoCloseTimer);
		};
	});

	$effect(() => {
		(async () => {
			try {
				loadingStatus = 'fetching...';
				const encryptedBuffer = await getMediaBlob(mediaId);
				loadingStatus = 'decrypting...';
				const encryptedData = new Uint8Array(encryptedBuffer);
				// Yield to UI before heavy crypto work
				await new Promise(r => setTimeout(r, 0));
				const decrypted = decryptMedia(encryptedData, mediaNonce, mediaKey);
				loadingStatus = 'rendering...';

				if (isVideo) {
					// Videos still use object URL (canvas can't play video)
					objectUrl = bytesToObjectUrl(decrypted, mimeType);
				} else {
					// Render image to canvas — no <img> src to download
					const blob = new Blob([decrypted], { type: mimeType });
					const bitmapUrl = URL.createObjectURL(blob);
					const img = new Image();
					img.onload = () => {
						if (!canvas) return;
						const dpr = window.devicePixelRatio || 1;
						const maxW = window.innerWidth - 40;
						const maxH = window.innerHeight - 120;
						const scale = Math.min(1, maxW / img.width, maxH / img.height);
						const cssW = img.width * scale;
						const cssH = img.height * scale;
						// Set canvas buffer to full resolution (dpr-aware)
						canvas.width = cssW * dpr;
						canvas.height = cssH * dpr;
						// Set display size via CSS
						canvas.style.width = cssW + 'px';
						canvas.style.height = cssH + 'px';
						const ctx = canvas.getContext('2d');
						if (ctx) {
							ctx.scale(dpr, dpr);
							ctx.imageSmoothingEnabled = true;
							ctx.imageSmoothingQuality = 'high';
							ctx.drawImage(img, 0, 0, cssW, cssH);
						}
						URL.revokeObjectURL(bitmapUrl);
					};
					img.src = bitmapUrl;
				}
			} catch (e) {
				error = e instanceof Error ? e.message : 'failed to load media';
			} finally {
				loading = false;
				// Images: 10-second countdown. Videos: close when playback ends.
				if (!error && !isVideo) {
					countdown = 10;
					autoCloseTimer = setInterval(() => {
						countdown--;
						if (countdown <= 0) {
							if (autoCloseTimer) clearInterval(autoCloseTimer);
							onclose();
						}
					}, 1000);
				}
			}
		})();

		return () => {
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	});

	function blockEvent(e: Event) {
		e.preventDefault();
		e.stopPropagation();
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	class="viewer-overlay"
	onclick={onclose}
	role="dialog"
	tabindex="-1"
	onkeydown={(e) => { if (e.key === 'Escape') onclose(); }}
	oncontextmenu={blockEvent}
>
	<div class="viewer-content" onclick={(e) => e.stopPropagation()} oncontextmenu={blockEvent}>
		{#if loading}
			<p class="viewer-status">{loadingStatus}</p>
		{:else if error}
			<p class="viewer-error">{error}</p>
		{:else if isVideo && objectUrl}
			<video
				src={objectUrl}
				autoplay
				playsinline
				class="viewer-media"
				oncontextmenu={blockEvent}
				ondragstart={blockEvent}
				onended={onclose}
			>
				<track kind="captions" />
			</video>
		{:else}
			<canvas
				bind:this={canvas}
				class="viewer-media"
				oncontextmenu={blockEvent}
				ondragstart={blockEvent}
			></canvas>
		{/if}

		<button class="viewer-close" onclick={onclose}>{loading ? 'close' : isVideo ? 'close' : `close (${countdown}s)`}</button>
	</div>
</div>

<style>
	.viewer-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.97);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 20px;
		/* Block text/image selection */
		user-select: none;
		-webkit-user-select: none;
		/* Block iOS long-press "Save Image" callout */
		-webkit-touch-callout: none;
	}
	.viewer-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		max-width: 100%;
		max-height: 100%;
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
	}
	.viewer-media {
		max-width: 100%;
		max-height: calc(100vh - 120px);
		object-fit: contain;
		border-radius: var(--radius);
		/* Prevent drag-to-save */
		-webkit-user-drag: none;
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
		/* Disable pointer events that could trigger save dialogs */
		pointer-events: none;
	}
	.viewer-status {
		color: var(--text-muted);
		font-size: 14px;
	}
	.viewer-error {
		color: var(--danger);
		font-size: 14px;
	}
	.viewer-close {
		border: 1px solid rgba(255, 255, 255, 0.2);
		background: transparent;
		color: rgba(255, 255, 255, 0.7);
		padding: 12px 24px;
		font-size: 14px;
		min-height: 48px;
		pointer-events: auto;
	}
	@media (hover: hover) {
		.viewer-close:hover {
			color: #fff;
			border-color: rgba(255, 255, 255, 0.4);
		}
	}
</style>
