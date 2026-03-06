<script lang="ts">
	/**
	 * Canvas-based 3:4 image cropper.
	 * User can drag to pan, scroll/pinch to zoom, then confirm to get a cropped Blob.
	 */

	interface Props {
		file: File;
		oncrop: (blob: Blob) => void;
		oncancel: () => void;
	}

	let { file, oncrop, oncancel }: Props = $props();

	// 3:4 aspect ratio to match grid tiles
	const OUTPUT_W = 450;
	const OUTPUT_H = 600;
	const MIN_ZOOM = 0.5;
	const MAX_ZOOM = 4;

	let canvas = $state<HTMLCanvasElement | null>(null);
	let img = $state<HTMLImageElement | null>(null);
	let loaded = $state(false);

	// Transform state
	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);

	// Drag state
	let dragging = false;
	let lastX = 0;
	let lastY = 0;

	// Touch zoom state
	let lastPinchDist = 0;

	// Canvas display size (3:4)
	const CANVAS_W = 270;
	const CANVAS_H = 360;

	$effect(() => {
		if (!file) return;
		const image = new Image();
		image.onload = () => {
			img = image;
			// Fit image to canvas — scale so it fills the 3:4 crop area
			const scaleW = CANVAS_W / image.width;
			const scaleH = CANVAS_H / image.height;
			const scale = Math.max(scaleW, scaleH);
			zoom = scale;
			// Center the image
			panX = (CANVAS_W - image.width * scale) / 2;
			panY = (CANVAS_H - image.height * scale) / 2;
			loaded = true;
		};
		image.src = URL.createObjectURL(file);
		return () => URL.revokeObjectURL(image.src);
	});

	$effect(() => {
		if (!canvas || !img || !loaded) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		// Redraw on any transform change
		const _z = zoom;
		const _px = panX;
		const _py = panY;
		draw(ctx);
	});

	function draw(ctx: CanvasRenderingContext2D) {
		if (!img) return;
		ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

		// Draw the image with current transform
		ctx.drawImage(img, panX, panY, img.width * zoom, img.height * zoom);
	}

	function handleMouseDown(e: MouseEvent) {
		dragging = true;
		lastX = e.clientX;
		lastY = e.clientY;
	}

	function handleMouseMove(e: MouseEvent) {
		if (!dragging) return;
		panX += e.clientX - lastX;
		panY += e.clientY - lastY;
		lastX = e.clientX;
		lastY = e.clientY;
	}

	function handleMouseUp() {
		dragging = false;
	}

	function handleWheel(e: WheelEvent) {
		e.preventDefault();
		const delta = e.deltaY > 0 ? 0.95 : 1.05;
		applyZoom(delta, e.offsetX, e.offsetY);
	}

	function handleTouchStart(e: TouchEvent) {
		if (e.touches.length === 1) {
			dragging = true;
			lastX = e.touches[0].clientX;
			lastY = e.touches[0].clientY;
		} else if (e.touches.length === 2) {
			dragging = false;
			lastPinchDist = pinchDistance(e.touches);
		}
	}

	function handleTouchMove(e: TouchEvent) {
		e.preventDefault();
		if (e.touches.length === 1 && dragging) {
			panX += e.touches[0].clientX - lastX;
			panY += e.touches[0].clientY - lastY;
			lastX = e.touches[0].clientX;
			lastY = e.touches[0].clientY;
		} else if (e.touches.length === 2) {
			const dist = pinchDistance(e.touches);
			if (lastPinchDist > 0) {
				const delta = dist / lastPinchDist;
				applyZoom(delta, CANVAS_W / 2, CANVAS_H / 2);
			}
			lastPinchDist = dist;
		}
	}

	function handleTouchEnd(e: TouchEvent) {
		if (e.touches.length === 0) {
			dragging = false;
			lastPinchDist = 0;
		}
	}

	function pinchDistance(touches: TouchList): number {
		const dx = touches[0].clientX - touches[1].clientX;
		const dy = touches[0].clientY - touches[1].clientY;
		return Math.sqrt(dx * dx + dy * dy);
	}

	function applyZoom(factor: number, cx: number, cy: number) {
		const minDim = Math.min(img?.width ?? CANVAS_W, img?.height ?? CANVAS_H);
		const newZoom = Math.max(MIN_ZOOM * (CANVAS_W / minDim),
			Math.min(MAX_ZOOM, zoom * factor));
		// Zoom towards cursor
		panX = cx - (cx - panX) * (newZoom / zoom);
		panY = cy - (cy - panY) * (newZoom / zoom);
		zoom = newZoom;
	}

	async function confirmCrop() {
		if (!img) return;
		// Create an offscreen canvas at output resolution (3:4)
		const offscreen = document.createElement('canvas');
		offscreen.width = OUTPUT_W;
		offscreen.height = OUTPUT_H;
		const ctx = offscreen.getContext('2d');
		if (!ctx) return;

		// Scale from display canvas to output
		const scaleX = OUTPUT_W / CANVAS_W;
		const scaleY = OUTPUT_H / CANVAS_H;
		ctx.drawImage(img, panX * scaleX, panY * scaleY, img.width * zoom * scaleX, img.height * zoom * scaleY);

		offscreen.toBlob((blob) => {
			if (blob) oncrop(blob);
		}, 'image/jpeg', 0.85);
	}
</script>

<div class="cropper-overlay">
	<div class="cropper-modal">
		<p class="cropper-title">crop your photo</p>
		<p class="cropper-hint">drag to reposition, scroll to zoom</p>

		<div class="canvas-container">
			<canvas
				bind:this={canvas}
				width={CANVAS_W}
				height={CANVAS_H}
				onmousedown={handleMouseDown}
				onmousemove={handleMouseMove}
				onmouseup={handleMouseUp}
				onmouseleave={handleMouseUp}
				onwheel={handleWheel}
				ontouchstart={handleTouchStart}
				ontouchmove={handleTouchMove}
				ontouchend={handleTouchEnd}
			></canvas>
		</div>

		<div class="cropper-actions">
			<button class="cancel-btn" onclick={oncancel}>cancel</button>
			<button class="confirm-btn" onclick={confirmCrop}>crop and upload</button>
		</div>
	</div>
</div>

<style>
	.cropper-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.95);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 20px;
	}
	.cropper-modal {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		max-width: 360px;
		width: 100%;
	}
	.cropper-title {
		color: var(--text);
		font-size: 16px;
	}
	.cropper-hint {
		color: var(--text-muted);
		font-size: 12px;
	}
	.canvas-container {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
		line-height: 0;
		touch-action: none;
	}
	canvas {
		cursor: grab;
		display: block;
		max-width: 100%;
		height: auto;
	}
	canvas:active {
		cursor: grabbing;
	}
	.cropper-actions {
		display: flex;
		gap: 12px;
		width: 100%;
	}
	.cancel-btn {
		flex: 1;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text-muted);
	}
	.confirm-btn {
		flex: 2;
		background: var(--white);
		color: var(--bg);
		border: none;
	}
	@media (hover: hover) {
		.confirm-btn:hover {
			opacity: 0.9;
		}
	}
</style>
