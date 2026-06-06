const { v4: uuidv4 } = require('uuid');
const { verifyToken } = require('./token');
const User = require('./models/User');
const { isDBConnected } = require('./db');

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

// Display name for a connection: the logged-in username, or 'Guest'.
const nameFromSocket = (socket) => socket.data.user?.username || 'Guest';

// Account id behind a connection, or null for guests. Stored on the seat so the
// final result can be credited to the right account when the game ends.
const userIdFromSocket = (socket) => socket.data.user?.id ?? null;

// Build a fresh seat for a connection.
const makeSeat = (socket, playerId) => ({
  playerId,
  socketId: socket.id,
  name: nameFromSocket(socket),
  userId: userIdFromSocket(socket),
});

// Seat names keyed by colour, for the client UI (null until that seat fills).
const namesOf = (room) => ({
  white: room?.white?.name ?? null,
  black: room?.black?.name ?? null,
});

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
      endGame(roomId, { winner });
    },
    Math.max(0, remaining),
  );
}

// Map a game outcome to (white score, black score), where 1 = win, 0 = loss,
// 0.5 = draw. `winner` is 'white' | 'black' | null (null = draw).
const scoresFor = (winner) =>
  winner === 'white'
    ? [1, 0]
    : winner === 'black'
      ? [0, 1]
      : [0.5, 0.5];

// Credit a finished game to the players' accounts. Only logged-in seats are
// recorded; guests have no account to update. Best-effort: if the DB is down we
// just skip it (the game still ends normally). `outcome` is undefined for games
// that shouldn't count (e.g. aborts).
async function recordResult(room, outcome) {
  if (!outcome || !isDBConnected()) return;

  const whiteId = room.white?.userId ?? null;
  const blackId = room.black?.userId ?? null;
  if (!whiteId && !blackId) return; // both guests — nothing to record
  if (whiteId && whiteId === blackId) return; // same account on both seats

  const [whiteScore, blackScore] = scoresFor(outcome.winner);
  const field = (score) =>
    score === 1 ? 'wins' : score === 0 ? 'losses' : 'draws';

  await Promise.all(
    [
      whiteId && [whiteId, field(whiteScore)],
      blackId && [blackId, field(blackScore)],
    ]
      .filter(Boolean)
      .map(([id, key]) =>
        User.findByIdAndUpdate(id, { $inc: { [`stats.${key}`]: 1 } }),
      ),
  );
}

// Mark the game as over: freeze the clock, cancel its flag timer, flag the room
// so reconnects don't drag the player back into a finished match, and record the
// result to the players' accounts. The room.over guard makes this idempotent so
// the result is recorded exactly once even though several paths (and both
// clients) can signal the same ending.
function endGame(roomId, outcome) {
  clearTimeout(flagTimers[roomId]);
  delete flagTimers[roomId];
  const room = rooms[roomId];
  if (!room) return;
  if (room.over) return;
  if (room.clock) room.clock.turn = null;
  room.over = true;
  recordResult(room, outcome).catch((err) =>
    console.error('[stats] failed to record result:', err.message),
  );
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
        room[seat].name = nameFromSocket(socket); // refresh in case they logged in/out
        room[seat].userId = userIdFromSocket(socket);
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
            names: namesOf(room),
          });
          // Tell the opponent we're back.
          socket.to(existingRoomId).emit('opponent_joined', {
            names: namesOf(room),
          });
        } else {
          // Still waiting for an opponent — put the creator back on the lobby
          // waiting screen with their room code.
          socket.emit('room_created', {
            roomId: existingRoomId,
            color: seat,
            timeControl: room.timeControl,
            names: namesOf(room),
          });
        }
      }
    }

    // CREATE ROOM
    socket.on('create_room', (payload) => {
      const roomId = uuidv4().slice(0, 6).toUpperCase(); // e.g. "A3F9B2"
      const timeControl = sanitizeTimeControl(payload);
      rooms[roomId] = {
        white: makeSeat(socket, playerId),
        black: null,
        fen: 'start', // initial board state
        timeControl, // chosen by the creator; applied when the game starts
        clock: null, // set when the second player joins and the game starts
      };
      socket.join(roomId);
      socket.emit('room_created', {
        roomId,
        color: 'white',
        timeControl,
        names: namesOf(rooms[roomId]),
      });
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
        room[existingSeat].name = nameFromSocket(socket);
        room[existingSeat].userId = userIdFromSocket(socket);
      } else {
        room.black = makeSeat(socket, playerId);
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
        names: namesOf(room),
      });

      // Notify the other player in the room (the creator) that an opponent
      // joined and the game can start. Emitting to the ROOM rather than a
      // stored socket id makes this resilient to reconnects: the creator's
      // current socket is whatever is presently in the room, even if their
      // original socket id went stale during a network drop / server cold
      // start. socket.to(...) excludes the joiner, so only the creator gets it.
      socket.to(roomId).emit('opponent_joined', { clock, names: namesOf(room) });
    });

    // LEAVE ROOM — back out of a room you created while still waiting for an
    // opponent (the "Cancel" button on the waiting screen). Frees the seat and
    // deletes the room if it's now empty so it doesn't linger in memory.
    socket.on('leave_room', ({ roomId }) => {
      const room = rooms[roomId];
      if (!room) return;
      const seat = seatOf(room, playerId);
      if (!seat) return;

      room[seat] = null;
      socket.leave(roomId);

      if (!room.white && !room.black) {
        clearTimeout(flagTimers[roomId]);
        delete flagTimers[roomId];
        delete rooms[roomId];
      } else {
        // An opponent is still seated — let them know the seat opened up.
        socket.to(roomId).emit('opponent_left');
      }
    });

    socket.on('resign', ({ roomId }) => {
      const room = rooms[roomId];
      const seat = room && seatOf(room, playerId);
      // The resigning side loses; their opponent is credited the win.
      const winner = seat ? (seat === 'white' ? 'black' : 'white') : null;
      endGame(roomId, winner ? { winner } : undefined);
      socket.to(roomId).emit('opponent_resigned');
    });

    // Aborts don't count — pass no outcome so nothing is recorded.
    socket.on('abort', ({ roomId }) => {
      endGame(roomId);
      socket.to(roomId).emit('opponent_aborted');
    });

    // Game reached a natural end (checkmate / stalemate / draw). The client that
    // detected it reports the winner (null = draw); we don't trust it for moves
    // but the result is consistent with the authoritative FEN both sides share.
    socket.on('game_ended', ({ roomId, result }) => {
      const winner =
        result?.winner === 'white' || result?.winner === 'black'
          ? result.winner
          : null;
      endGame(roomId, { winner });
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
              endGame(roomId, { winner: opponentSeat });
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
