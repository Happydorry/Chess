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

export const socket = io('http://localhost:5001', {
  auth: { playerId },
});
