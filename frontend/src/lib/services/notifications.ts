/**
 * Push notification service.
 * Registers service worker, subscribes to push, and manages notification permissions.
 */
import { writable, get } from 'svelte/store';
import { request } from '$lib/api';

export const notificationPermission = writable<NotificationPermission>(
	typeof Notification !== 'undefined' ? Notification.permission : 'default'
);

export const pushSupported = writable(false);
export const pushSubscribed = writable(false);

let swRegistration: ServiceWorkerRegistration | null = null;

/**
 * Register the service worker and check push support.
 * Call this once on app load.
 */
export async function initNotifications(): Promise<void> {
	if (typeof window === 'undefined') return;
	if (!('serviceWorker' in navigator)) return;

	try {
		swRegistration = await navigator.serviceWorker.register('/service-worker.js', {
			scope: '/',
		});

		// Check push support
		if ('PushManager' in window) {
			pushSupported.set(true);

			// Check if already subscribed
			const existing = await swRegistration.pushManager.getSubscription();
			if (existing) {
				pushSubscribed.set(true);
			}
		}
	} catch (err) {
		console.warn('[notifications] Service worker registration failed:', err);
	}
}

/**
 * Request notification permission and subscribe to push.
 * Returns true if subscribed successfully.
 */
export async function subscribeToPush(did: string): Promise<boolean> {
	if (!swRegistration) return false;
	if (!('PushManager' in window)) return false;

	try {
		// Request permission
		const permission = await Notification.requestPermission();
		notificationPermission.set(permission);

		if (permission !== 'granted') {
			return false;
		}

		// Get VAPID public key from server
		const { publicKey } = await request<{ publicKey: string }>('/push/vapid-public-key');

		// Convert VAPID key to Uint8Array
		const applicationServerKey = urlBase64ToUint8Array(publicKey);

		// Subscribe to push
		const subscription = await swRegistration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey,
		});

		// Send subscription to server
		const subJson = subscription.toJSON();
		await request('/push/subscribe', {
			method: 'POST',
			body: JSON.stringify({
				did,
				subscription: {
					endpoint: subJson.endpoint,
					keys: subJson.keys,
				},
			}),
		});

		pushSubscribed.set(true);
		return true;
	} catch (err) {
		console.error('[notifications] Push subscription failed:', err);
		return false;
	}
}

/**
 * Unsubscribe from push notifications.
 */
export async function unsubscribeFromPush(did: string): Promise<void> {
	if (!swRegistration) return;

	try {
		const subscription = await swRegistration.pushManager.getSubscription();
		if (subscription) {
			await subscription.unsubscribe();

			// Tell server to remove subscription
			await request('/push/unsubscribe', {
				method: 'POST',
				body: JSON.stringify({
					did,
					endpoint: subscription.endpoint,
				}),
			});
		}

		pushSubscribed.set(false);
	} catch (err) {
		console.error('[notifications] Unsubscribe failed:', err);
	}
}

/**
 * Convert a URL-safe base64 string to Uint8Array.
 * Needed for VAPID public key conversion.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
	const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const rawData = atob(base64);
	const outputArray = new Uint8Array(rawData.length);
	for (let i = 0; i < rawData.length; i++) {
		outputArray[i] = rawData.charCodeAt(i);
	}
	return outputArray;
}
