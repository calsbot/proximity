/**
 * Shared store for pending request count (DM invitations + group invites).
 * Used by layout nav badge, chat page, and grid page.
 */
import { writable } from 'svelte/store';

export const requestCountStore = writable(0);
