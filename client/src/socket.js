import { io } from 'socket.io-client';

// Stable per-tab identity so a reload / reconnect / server restart can rejoin
// the same game instead of being orphaned with a brand-new socket id.
// sessionStorage (not localStorage) so two tabs are two distinct players, while
// still surviving reloads within a tab.
let playerId = sessionStorage.getItem('chess_player_id');
if (!playerId) {
  playerId =
    globalThis.crypto?.randomUUID?.() ?? `p_${Date.now()}_${Math.random()}`;
  sessionStorage.setItem('chess_player_id', playerId);
}

export { playerId };

// Server URL is configurable so the same build works locally and in
// production. Set VITE_SERVER_URL at build time (e.g. on the host) to the
// deployed server's origin; falls back to the local dev server otherwise.
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:5001';

export const socket = io(SERVER_URL, {
  auth: { playerId },
});
