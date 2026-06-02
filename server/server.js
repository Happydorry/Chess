const { v4: uuidv4 } = require('uuid');
const { verifyToken } = require('./token');

const rooms = {}; // roomId -> { white, black, fen, clock }  (white/black = { playerId, socketId } | null)
const cleanupTimers = {}; // playerId -> timeout
const flagTimers = {}; // roomId -> timeout that fires when the running clock hits zero
const GRACE_MS = Number(process.env.GRACE_MS) || 30_000; // keep a room alive this long after a player drops

// Time control. Deadline-based: we store each side's remaining ms plus when the
// running side's turn started, and derive live time on demand (no per-second tick).
const INITIAL_TIME_MS = Number(process.env.CLOCK_MS) || 5 * 60_000; // default 5 min/side
const INCREMENT_MS = Number(process.env.INCREMENT_MS) || 0; // default no increment
const MIN_TIME_MS = 10_000; // 10s
const MAX_TIME_MS = 60 * 60_000; // 60 min
const MAX_INCREMENT_MS = 60_000; // 60s

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// The room creator picks the time control; never trust the client's numbers.
function sanitizeTimeControl(tc) {
  const initialMs = Number(tc?.timeMs);
  const incrementMs = Number(tc?.incrementMs);
  return {
    initialMs: Number.isFinite(initialMs)
      ? clamp(initialMs, MIN_TIME_MS, MAX_TIME_MS)
      : INITIAL_TIME_MS,
    incrementMs: Number.isFinite(incrementMs)
      ? clamp(incrementMs, 0, MAX_INCREMENT_MS)
      : INCREMENT_MS,
  };
}

const seatOf = (room, playerId) =>
  room?.white?.playerId === playerId
    ? 'white'
    : room?.black?.playerId === playerId
      ? 'black'
      : null;

const roomIdOfPlayer = (playerId) =>
  Object.keys(rooms).find((id) => seatOf(rooms[id], playerId)) ?? null;

// Live clock values: subtract the time elapsed on the running side's turn.
function clockSnapshot(room) {
  const c = room?.clock;
  if (!c) return null;
  const elapsed = c.turn ? Date.now() - c.turnStartedAt : 0;
  return {
    white: c.turn === 'white' ? Math.max(0, c.white - elapsed) : c.white,
    black: c.turn === 'black' ? Math.max(0, c.black - elapsed) : c.black,
    turn: c.turn,
  };
}

// Arm a single timeout for the exact moment the running side flags. Re-armed on
// every move; cleared when the game ends or the room goes away.
function scheduleFlagFall(io, roomId) {
  clearTimeout(flagTimers[roomId]);
  const room = rooms[roomId];
  const c = room?.clock;
  if (!c?.turn) return;
  const remaining = c[c.turn] - (Date.now() - c.turnStartedAt);
  flagTimers[roomId] = setTimeout(
    () => {
      const room = rooms[roomId];
      if (!room?.clock?.turn) return;
      const loser = room.clock.turn;
      const winner = loser === 'white' ? 'black' : 'white';
      room.clock[loser] = 0;
      room.clock.turn = null; // stop the clock
      io.to(roomId).emit('time_up', {
        loser,
        winner,
        clock: clockSnapshot(room),
      });
      endGame(roomId);
    },
    Math.max(0, remaining),
  );
}

// Mark the game as over: freeze the clock, cancel its flag timer, and flag the
// room so reconnects don't drag the player back into a finished match.
function endGame(roomId) {
  clearTimeout(flagTimers[roomId]);
  delete flagTimers[roomId];
  const room = rooms[roomId];
  if (!room) return;
  if (room.clock) room.clock.turn = null;
  room.over = true;
}

function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    const playerId = socket.handshake.auth?.playerId || socket.id;

    // If the client is logged in it also sends a JWT. Decode it (best-effort)
    // so the socket knows the real account behind this connection. Guests have
    // no token and simply get user = null — game logic still keys on playerId.
    const decoded = verifyToken(socket.handshake.auth?.token);
    socket.data.user = decoded
      ? { id: decoded.sub, username: decoded.username }
      : null;

    console.log(
      'Connected:',
      socket.id,
      'player:',
      playerId,
      socket.data.user ? `(user: ${socket.data.user.username})` : '(guest)',
    );

    // The player is back — cancel any pending room cleanup.
    clearTimeout(cleanupTimers[playerId]);
    delete cleanupTimers[playerId];

    // Auto-rejoin an existing game (after reload / reconnect / server hiccup).
    const existingRoomId = roomIdOfPlayer(playerId);
    if (existingRoomId) {
      const room = rooms[existingRoomId];
      if (room.over) {
        // The game already ended (abort / resign / time-out / checkmate).
        // Don't drag the player back in on refresh — drop their seat and let
        // them land in the lobby. Delete the room if both players are now gone.
        const seat = seatOf(room, playerId);
        if (seat) room[seat] = null;
        if (!room.white && !room.black) {
          clearTimeout(flagTimers[existingRoomId]);
          delete flagTimers[existingRoomId];
          delete rooms[existingRoomId];
        }
      } else {
        const seat = seatOf(room, playerId);
        room[seat].socketId = socket.id;
        socket.join(existingRoomId);

        // Has the game actually started (both seats filled)? If so, drop the
        // player straight back into the live game. If they're still the lone
        // creator waiting for an opponent, restore the *waiting* screen instead
        // of throwing them onto an empty board. This also means a creator who
        // briefly dropped while waiting will recover correctly when they
        // reconnect — and will be told the game started via 'opponent_joined'
        // once the second player arrives.
        const started = Boolean(room.white && room.black);
        if (started) {
          socket.emit('rejoined', {
            roomId: existingRoomId,
            color: seat,
            fen: room.fen,
            clock: clockSnapshot(room),
          });
          // Tell the opponent we're back.
          socket.to(existingRoomId).emit('opponent_joined');
        } else {
          // Still waiting for an opponent — put the creator back on the lobby
          // waiting screen with their room code.
          socket.emit('room_created', {
            roomId: existingRoomId,
            color: seat,
            timeControl: room.timeControl,
          });
        }
      }
    }

    // CREATE ROOM
    socket.on('create_room', (payload) => {
      const roomId = uuidv4().slice(0, 6).toUpperCase(); // e.g. "A3F9B2"
      const timeControl = sanitizeTimeControl(payload);
      rooms[roomId] = {
        white: { playerId, socketId: socket.id },
        black: null,
        fen: 'start', // initial board state
        timeControl, // chosen by the creator; applied when the game starts
        clock: null, // set when the second player joins and the game starts
      };
      socket.join(roomId);
      socket.emit('room_created', { roomId, color: 'white', timeControl });
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
        // Brand-new opponent → the game starts now. Start white's clock using
        // the creator's chosen time control.
        const tc = room.timeControl ?? sanitizeTimeControl();
        room.clock = {
          white: tc.initialMs,
          black: tc.initialMs,
          increment: tc.incrementMs,
          turn: 'white',
          turnStartedAt: Date.now(),
        };
        scheduleFlagFall(io, roomId);
      }

      const clock = clockSnapshot(room);
      socket.join(roomId);
      socket.emit('room_joined', {
        roomId,
        color: existingSeat || 'black',
        clock,
      });

      // Notify the other player in the room (the creator) that an opponent
      // joined and the game can start. Emitting to the ROOM rather than a
      // stored socket id makes this resilient to reconnects: the creator's
      // current socket is whatever is presently in the room, even if their
      // original socket id went stale during a network drop / server cold
      // start. socket.to(...) excludes the joiner, so only the creator gets it.
      socket.to(roomId).emit('opponent_joined', { clock });
    });
    socket.on('resign', ({ roomId }) => {
      endGame(roomId);
      socket.to(roomId).emit('opponent_resigned');
    });

    socket.on('abort', ({ roomId }) => {
      endGame(roomId);
      socket.to(roomId).emit('opponent_aborted');
    });

    // Game reached a natural end (checkmate / stalemate / draw) — stop the clock
    // so its flag timer can't fire a spurious time-out afterwards.
    socket.on('game_ended', ({ roomId }) => {
      endGame(roomId);
    });

    // MAKE MOVE — broadcast to the other player; keep the authoritative FEN and
    // charge the mover's clock, then start the opponent's.
    socket.on('make_move', ({ roomId, move, fen }) => {
      const room = rooms[roomId];
      if (!room) return;
      if (fen) room.fen = fen;

      const c = room.clock;
      if (c?.turn) {
        const mover = c.turn; // the running side is the one who just moved
        c[mover] =
          Math.max(0, c[mover] - (Date.now() - c.turnStartedAt)) + c.increment;
        c.turn = mover === 'white' ? 'black' : 'white';
        c.turnStartedAt = Date.now();
        scheduleFlagFall(io, roomId);
      }

      socket.to(roomId).emit('move_made', { move, fen });
      io.to(roomId).emit('clock_update', clockSnapshot(room));
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

          // If the game is still live and the opponent is still around, treat
          // the disconnect as a forfeit — closing your tab no longer lets you
          // escape a losing position.
          if (seat && !room.over) {
            const opponentSeat = seat === 'white' ? 'black' : 'white';
            if (room[opponentSeat]) {
              io.to(roomId).emit('opponent_forfeit', {
                winner: opponentSeat,
                loser: seat,
              });
              endGame(roomId);
            }
          }

          if (seat) room[seat] = null;
          if (!room.white && !room.black) {
            clearTimeout(flagTimers[roomId]);
            delete flagTimers[roomId];
            delete rooms[roomId];
          }
        }
        delete cleanupTimers[playerId];
      }, GRACE_MS);
    });
  });
}

module.exports = registerSocketHandlers;
