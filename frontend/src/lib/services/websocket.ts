/**
 * WebSocket service for real-time message delivery.
 * Connects to the Bun server's WebSocket endpoint.
 */
import { writable, get } from 'svelte/store';

export type WsStatus = 'disconnected' | 'connecting' | 'connected';
export const wsStatus = writable<WsStatus>('disconnected');

type MessageHandler = (data: any) => void;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let myDid: string | null = null;
const handlers: Set<MessageHandler> = new Set();

// --- Activity tracking ---
// Tracks whether the user is actually present (tab visible + recent interaction).
// Heartbeats only update lastSeen on the server when the user is active.
let lastInteraction = 0;
let activityListenersAttached = false;
const ACTIVITY_WINDOW = 5 * 60 * 1000; // 5 minutes — interaction within this window counts as "active"

function markInteraction() {
	lastInteraction = Date.now();
}

function attachActivityListeners() {
	if (activityListenersAttached || typeof window === 'undefined') return;
	activityListenersAttached = true;
	const events = ['click', 'touchstart', 'keydown', 'scroll', 'mousemove'];
	for (const evt of events) {
		window.addEventListener(evt, markInteraction, { passive: true, capture: true });
	}
	// Also mark active when tab becomes visible again
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') markInteraction();
	});
	// Initial mark
	markInteraction();
}

/** True when the tab is in the foreground AND the user interacted recently */
function isUserActive(): boolean {
	if (typeof document === 'undefined') return false;
	const tabVisible = document.visibilityState === 'visible';
	const recentInteraction = Date.now() - lastInteraction < ACTIVITY_WINDOW;
	return tabVisible && recentInteraction;
}

// Derive WS URL: env var in dev, or derive from current origin in production.
// Uses /ws path so Vite dev proxy forwards to the backend.
function getWsUrl(): string {
	if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
	if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL.replace(/^http/, 'ws') + '/ws';
	if (typeof window !== 'undefined') {
		const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${proto}//${window.location.host}/ws`;
	}
	return 'ws://localhost:3000/ws';
}
const WS_URL = getWsUrl();

/**
 * Connect to the WebSocket server and register with our DID.
 */
export function connect(did: string): void {
	attachActivityListeners();

	if (ws && ws.readyState === WebSocket.OPEN) {
		// Already connected, just re-register
		ws.send(JSON.stringify({ type: 'register', did }));
		myDid = did;
		return;
	}

	myDid = did;
	wsStatus.set('connecting');

	try {
		ws = new WebSocket(WS_URL);
	} catch {
		wsStatus.set('disconnected');
		scheduleReconnect();
		return;
	}

	ws.onopen = () => {
		wsStatus.set('connected');
		if (myDid) {
			ws!.send(JSON.stringify({ type: 'register', did: myDid }));
		}
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		// Heartbeat every 60s — only flags "active" when user is genuinely present
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = setInterval(() => {
			if (ws && ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: 'heartbeat', active: isUserActive() }));
			}
		}, 60000);
	};

	ws.onmessage = (event) => {
		try {
			const data = JSON.parse(event.data);
			for (const handler of handlers) {
				handler(data);
			}
		} catch {}
	};

	ws.onclose = () => {
		wsStatus.set('disconnected');
		ws = null;
		scheduleReconnect();
	};

	ws.onerror = () => {
		wsStatus.set('disconnected');
	};
}

function scheduleReconnect(): void {
	if (reconnectTimer) return;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		if (myDid) connect(myDid);
	}, 3000);
}

/**
 * Send a message through the WebSocket.
 */
export function wsSend(data: any): void {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(data));
	}
}

/**
 * Register a handler for incoming messages.
 */
export function onMessage(handler: MessageHandler): () => void {
	handlers.add(handler);
	return () => handlers.delete(handler);
}

/**
 * Disconnect the WebSocket.
 */
export function disconnect(): void {
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}
	if (ws) {
		ws.close();
		ws = null;
	}
	wsStatus.set('disconnected');
	myDid = null;
}
