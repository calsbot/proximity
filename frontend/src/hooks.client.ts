// Auto-reload on deploy: catch stale chunk errors from code-splitting
window.addEventListener('vite:preloadError', () => {
	window.location.reload();
});

// Catch Svelte runtime errors from completely stale cached code
// (e.g. first_child_getter undefined after template structure changes)
window.addEventListener('error', (e) => {
	const msg = e.message || '';
	if (
		msg.includes('first_child_getter') ||
		msg.includes('Failed to fetch dynamically imported module') ||
		msg.includes('error loading dynamically imported module')
	) {
		window.location.reload();
	}
});

window.addEventListener('unhandledrejection', (e) => {
	const msg = String(e.reason?.message || e.reason || '');
	if (
		msg.includes('Failed to fetch dynamically imported module') ||
		msg.includes('error loading dynamically imported module')
	) {
		window.location.reload();
	}
});
