const { v4: uuidv4 } = require('uuid');

const rooms = {}; // roomId -> { white, black, fen }  (white/black = { playerId, socketId } | null)
const cleanupTimers = {}; // playerId -> timeout
const GRACE_MS = Number(process.env.GRACE_MS) || 30_000; // keep a room alive this long after a player drops

const seatOf = (room, playerId) =>
  room?.white?.playerId === playerId
    ? 'white'
    : room?.black?.playerId === playerId
      ? 'black'
      : null;

const roomIdOfPlayer = (playerId) =>
  Object.keys(rooms).find((id) => seatOf(rooms[id], playerId)) ?? null;

function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    const playerId = socket.handshake.auth?.playerId || socket.id;
    console.log('Connected:', socket.id, 'player:', playerId);

    // The player is back — cancel any pending room cleanup.
    clearTimeout(cleanupTimers[playerId]);
    delete cleanupTimers[playerId];

    // Auto-rejoin an existing game (after reload / reconnect / server hiccup).
    const existingRoomId = roomIdOfPlayer(playerId);
    if (existingRoomId) {
      const room = rooms[existingRoomId];
      const seat = seatOf(room, playerId);
      room[seat].socketId = socket.id;
      socket.join(existingRoomId);
      socket.emit('rejoined', {
        roomId: existingRoomId,
        color: seat,
        fen: room.fen,
      });
      // Tell the opponent we're back.
      socket.to(existingRoomId).emit('opponent_joined');
    }

    // CREATE ROOM
    socket.on('create_room', () => {
      const roomId = uuidv4().slice(0, 6).toUpperCase(); // e.g. "A3F9B2"
      rooms[roomId] = {
        white: { playerId, socketId: socket.id },
        black: null,
        fen: 'start', // initial board state
      };
      socket.join(roomId);
      socket.emit('room_created', { roomId, color: 'white' });
    });

    // JOIN ROOM
    socket.on('join_room', ({ roomId }) => {
      const room = rooms[roomId];

      if (!room) return socket.emit('error', { msg: 'Room not found' });

      const existingSeat = seatOf(room, playerId);
      if (!existingSeat && room.black) {
        return socket.emit('error', { msg: 'Room is full' });
      }

      if (existingSeat) {
        room[existingSeat].socketId = socket.id; // same player reconnecting
      } else {
        room.black = { playerId, socketId: socket.id };
      }

      socket.join(roomId);
      socket.emit('room_joined', { roomId, color: existingSeat || 'black' });

      // Notify white player that opponent joined — game can start.
      io.to(room.white.socketId).emit('opponent_joined');
    });
    socket.on('resign', ({ roomId }) => {
      socket.to(roomId).emit('opponent_resigned');
    });

    socket.on('abort', ({ roomId }) => {
      socket.to(roomId).emit('opponent_aborted');
    });
    // MAKE MOVE — broadcast to the other player; keep the authoritative FEN.
    socket.on('make_move', ({ roomId, move, fen }) => {
      const room = rooms[roomId];
      if (room && fen) room.fen = fen;
      socket.to(roomId).emit('move_made', { move, fen });
    });

    // DISCONNECT — don't destroy the game immediately; allow a grace period
    // so reloads / brief network drops don't kill an in-progress match.
    socket.on('disconnect', () => {
      console.log('Disconnected:', socket.id);
      const roomId = roomIdOfPlayer(playerId);
      if (!roomId) return;

      // On a reload the new socket can connect BEFORE this old one disconnects.
      // If the seat already points at a newer socket, this is a stale disconnect
      // for an already-reconnected player — ignore it (otherwise we'd schedule a
      // cleanup timer that evicts an active player 30s later).
      const room = rooms[roomId];
      const seat = seatOf(room, playerId);
      if (room[seat]?.socketId !== socket.id) return;

      socket.to(roomId).emit('opponent_left'); // temporary notice

      cleanupTimers[playerId] = setTimeout(() => {
        const room = rooms[roomId];
        if (room) {
          const seat = seatOf(room, playerId);
          if (seat) room[seat] = null;
          if (!room.white && !room.black) delete rooms[roomId];
        }
        delete cleanupTimers[playerId];
      }, GRACE_MS);
    });
  });
}

module.exports = registerSocketHandlers;
