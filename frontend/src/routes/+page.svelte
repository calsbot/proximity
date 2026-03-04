<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { loadIdentityFromStorage } from '$lib/crypto/identity';

	onMount(async () => {
		const stored = await loadIdentityFromStorage();
		if (stored) {
			goto('/grid');
		} else {
			goto('/setup');
		}
	});
</script>

<div class="landing">
	<pre class="logo">proximity</pre>
	<p>privacy-preserving discovery.</p>
	<p>your location stays yours.</p>
</div>

<style>
	.landing {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 60vh;
		text-align: center;
		gap: 4px;
	}
	.logo {
		font-size: 16px;
		letter-spacing: 4px;
		margin-bottom: 12px;
		color: var(--text);
	}
	p {
		color: var(--text-muted);
		font-size: 13px;
	}
</style>
