import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		port: 5173,
		proxy: {
			'/auth': 'http://localhost:3000',
			'/profiles': 'http://localhost:3000',
			'/messages': 'http://localhost:3000',
			'/groups': 'http://localhost:3000',
			'/moderation': 'http://localhost:3000',
			'/invitations': 'http://localhost:3000',
			'/media': 'http://localhost:3000',
			'/push': 'http://localhost:3000',
			'/newsletter': 'http://localhost:3000',
			'/ws': {
				target: 'http://localhost:3000',
				ws: true
			}
		}
	}
});
