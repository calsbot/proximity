/**
 * Service Worker for meetmarket.io PWA
 * Handles push notifications and basic offline caching.
 */

const CACHE_NAME = 'meetmarket-v1';

// Install — cache the app shell
self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME).then((cache) => {
			return cache.addAll(['/']);
		}).catch(() => {
			// Cache failure is non-fatal — app still works online
		})
	);
	// Activate immediately (don't wait for existing tabs to close)
	self.skipWaiting();
});

// Activate — clean up old caches
self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys().then((keys) => {
			return Promise.all(
				keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
			);
		})
	);
	// Take control of all open tabs immediately
	self.clients.claim();
});

// Fetch — network-first with cache fallback for navigation
self.addEventListener('fetch', (event) => {
	const { request } = event;

	// Skip non-GET and API requests
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	// Skip non-http(s) schemes (chrome-extension://, etc.)
	if (!url.protocol.startsWith('http')) return;
	const apiPaths = ['/auth', '/profiles', '/messages', '/groups', '/moderation', '/invitations', '/media', '/push', '/ws', '/newsletter'];
	if (apiPaths.some((p) => url.pathname.startsWith(p))) return;

	// Navigation requests — network first, cache fallback
	if (request.mode === 'navigate') {
		event.respondWith(
			fetch(request).catch(() => {
				return caches.match('/') || new Response('Offline', { status: 503 });
			})
		);
		return;
	}

	// Static assets — cache first, network fallback
	if (url.pathname.match(/\.(js|css|png|jpg|svg|woff2?)$/)) {
		event.respondWith(
			caches.match(request).then((cached) => {
				return cached || fetch(request).then((response) => {
					// Cache the new asset
					const clone = response.clone();
					caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
					return response;
				});
			})
		);
		return;
	}
});

// Push notification received
self.addEventListener('push', (event) => {
	let data = { title: 'meetmarket.io', body: 'You have a new message' };

	try {
		if (event.data) {
			data = event.data.json();
		}
	} catch {
		// Use defaults
	}

	const options = {
		body: data.body || 'You have a new message',
		icon: '/icon-192.png',
		badge: '/icon-192.png',
		tag: data.tag || 'default',
		renotify: true,
		data: data.data || { url: '/chat' },
		// Vibrate pattern: short buzz
		vibrate: [100, 50, 100],
	};

	event.waitUntil(
		self.registration.showNotification(data.title || 'meetmarket.io', options)
	);
});

// Notification click — open the app
self.addEventListener('notificationclick', (event) => {
	event.notification.close();

	const url = event.notification.data?.url || '/chat';

	event.waitUntil(
		self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
			// If there's already a tab open, focus it and navigate
			for (const client of clientList) {
				if ('focus' in client) {
					client.focus();
					client.navigate(url);
					return;
				}
			}
			// Otherwise open a new tab
			return self.clients.openWindow(url);
		})
	);
});
