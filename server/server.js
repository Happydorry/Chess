const { v4: uuidv4 } = require('uuid');
const { verifyToken } = require('./token');
const User = require('./models/User');
const Game = require('./models/Game');
const { isDBConnected } = require('./db');

const rooms = {}; // roomId -> { white, black, fen, clock }  (white/black = { playerId, socketId } | null)
const cleanupTimers = {}; // playerId -> timeout
const flagTimers = {}; // roomId -> timeout that fires when the running clock hits zero
const GRACE_MS = Number(process.env.GRACE_MS) || 5_000; // reconnect window after a drop before it's a forfeit
const ABORT_WINDOW_MS = Number(process.env.ABORT_WINDOW_MS) || 20_000; // abort only allowed this long after the game starts

// Matchmaking queue: players waiting to be auto-paired with someone who picked
// the same time control. Each entry is a seat-to-be plus the chosen control and
// a `key` that two players must share to be matched.
// { playerId, socketId, name, userId, timeControl, key }
let matchQueue = [];

const tcKey = (tc) => `${tc.initialMs}/${tc.incrementMs}`;

const removeFromQueue = (playerId) => {
  matchQueue = matchQueue.filter((e) => e.playerId !== playerId);
};

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

// Free a player's seat and tear the room down if it's now empty. Used when a
// player leaves a finished game so it doesn't linger in memory (or keep them
// "stuck" in a dead room from matchmaking's point of view).
function releaseSeat(roomId, playerId) {
  const room = rooms[roomId];
  if (!room) return;
  const seat = seatOf(room, playerId);
  if (seat) room[seat] = null;
  if (!room.white && !room.black) {
    clearTimeout(flagTimers[roomId]);
    delete flagTimers[roomId];
    delete rooms[roomId];
  }
}

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
// While paused (an opponent is disconnected) no time elapses, so both sides
// freeze at their banked values.
function clockSnapshot(room) {
  const c = room?.clock;
  if (!c) return null;
  const elapsed = c.turn && !c.paused ? Date.now() - c.turnStartedAt : 0;
  return {
    white: c.turn === 'white' ? Math.max(0, c.white - elapsed) : c.white,
    black: c.turn === 'black' ? Math.max(0, c.black - elapsed) : c.black,
    turn: c.turn,
    paused: Boolean(c.paused),
  };
}

// Pause the running clock (e.g. while an opponent is mid-disconnect): bank the
// time spent on the current turn and stop the flag timer so no one flags while
// a reconnect is still possible.
function pauseClock(roomId) {
  const c = rooms[roomId]?.clock;
  if (!c?.turn || c.paused) return;
  c[c.turn] = Math.max(0, c[c.turn] - (Date.now() - c.turnStartedAt));
  c.paused = true;
  clearTimeout(flagTimers[roomId]);
}

// Resume a paused clock: restart the current turn's timer and re-arm the flag.
function resumeClock(io, roomId) {
  const c = rooms[roomId]?.clock;
  if (!c?.turn || !c.paused) return;
  c.paused = false;
  c.turnStartedAt = Date.now();
  scheduleFlagFall(io, roomId);
}

// Arm a single timeout for the exact moment the running side flags. Re-armed on
// every move; cleared when the game ends or the room goes away.
function scheduleFlagFall(io, roomId) {
  clearTimeout(flagTimers[roomId]);
  const room = rooms[roomId];
  const c = room?.clock;
  if (!c?.turn || c.paused) return; // never flag while paused
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
      endGame(io, roomId, { winner, reason: 'timeout' });
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

// Which stat to bump for a given score: 1 = win, 0 = loss, 0.5 = draw.
const fieldFor = (score) =>
  score === 1 ? 'wins' : score === 0 ? 'losses' : 'draws';

// ----- Elo rating -----
const DEFAULT_RATING = 1200;
const ELO_K = Number(process.env.ELO_K) || 32; // points at stake per game
const RATING_FLOOR = 100; // a rating never drops below this

// Standard Elo: the probability `rating` scores against `oppRating` (0..1).
const expectedScore = (rating, oppRating) =>
  1 / (1 + 10 ** ((oppRating - rating) / 400));

// New rating after scoring `score` (1 win / 0.5 draw / 0 loss) vs `oppRating`.
const nextRating = (rating, oppRating, score) =>
  Math.max(
    RATING_FLOOR,
    Math.round(rating + ELO_K * (score - expectedScore(rating, oppRating))),
  );

// Credit a finished game to the players' accounts and tell the room each side's
// updated record. Only logged-in seats are recorded; guests have no account.
// Ratings only move in account-vs-account games — playing a guest still counts
// toward W/L/D but leaves your rating untouched (so guests can't be farmed).
// Best-effort: if the DB is down we just skip it (the game still ends normally).
// `outcome` is undefined for games that shouldn't count (e.g. aborts).
async function recordResult(io, roomId, room, outcome) {
  if (!outcome || !isDBConnected()) return;

  const whiteId = room.white?.userId ?? null;
  const blackId = room.black?.userId ?? null;
  if (!whiteId && !blackId) return; // both guests — nothing to record
  if (whiteId && whiteId === blackId) return; // same account on both seats

  const [whiteUser, blackUser] = await Promise.all([
    whiteId ? User.findById(whiteId) : null,
    blackId ? User.findById(blackId) : null,
  ]);

  const [whiteScore, blackScore] = scoresFor(outcome.winner);
  const rated = Boolean(whiteUser && blackUser);
  const whiteBefore = whiteUser?.rating ?? DEFAULT_RATING;
  const blackBefore = blackUser?.rating ?? DEFAULT_RATING;

  // Bump the record, move the rating (rated games only), and build the payload
  // line this side's client will read.
  const apply = (user, score, before, oppBefore) => {
    if (!user) return null;
    user.stats[fieldFor(score)] += 1;
    let delta = 0;
    if (rated) {
      const after = nextRating(before, oppBefore, score);
      delta = after - before;
      user.rating = after;
    }
    const { wins, losses, draws } = user.stats;
    return { wins, losses, draws, rating: user.rating, delta, rated };
  };

  const white = apply(whiteUser, whiteScore, whiteBefore, blackBefore);
  const black = apply(blackUser, blackScore, blackBefore, whiteBefore);

  await Promise.all([whiteUser?.save(), blackUser?.save()].filter(Boolean));

  // Persist the game for both players' match history. Guest seats store a name
  // but no account id / ratings.
  const side = (seat, user, before) => ({
    userId: user?._id ?? null,
    name: seat?.name ?? null,
    ratingBefore: user ? before : null,
    ratingAfter: user ? user.rating : null,
  });
  await Game.create({
    white: side(room.white, whiteUser, whiteBefore),
    black: side(room.black, blackUser, blackBefore),
    winner: outcome.winner ?? null,
    reason: outcome.reason ?? null,
    rated,
    timeControl: room.timeControl ?? undefined,
  });

  // Each client reads the entry for its own colour; null means a guest seat.
  io.to(roomId).emit('stats_update', { white, black });
}

// Mark the game as over: freeze the clock, cancel its flag timer, flag the room
// so reconnects don't drag the player back into a finished match, and record the
// result to the players' accounts. The room.over guard makes this idempotent so
// the result is recorded exactly once even though several paths (and both
// clients) can signal the same ending.
function endGame(io, roomId, outcome) {
  clearTimeout(flagTimers[roomId]);
  delete flagTimers[roomId];
  const room = rooms[roomId];
  if (!room) return;
  if (room.over) return;
  if (room.clock) room.clock.turn = null;
  room.over = true;
  recordResult(io, roomId, room, outcome).catch((err) =>
    console.error('[stats] failed to record result:', err.message),
  );
}

// Build a started room for two matched players and drop them both straight into
// the game. Colours are randomised for fairness.
function startMatch(io, a, b) {
  const [whiteEntry, blackEntry] = Math.random() < 0.5 ? [a, b] : [b, a];
  const roomId = uuidv4().slice(0, 6).toUpperCase();
  const tc = a.timeControl; // a and b share the same control (matched on key)

  const seatFromEntry = (e) => ({
    playerId: e.playerId,
    socketId: e.socketId,
    name: e.name,
    userId: e.userId,
  });

  rooms[roomId] = {
    white: seatFromEntry(whiteEntry),
    black: seatFromEntry(blackEntry),
    fen: 'start',
    timeControl: tc,
    startedAt: Date.now(), // for the abort-only-in-the-opening window
    clock: {
      white: tc.initialMs,
      black: tc.initialMs,
      increment: tc.incrementMs,
      turn: 'white',
      turnStartedAt: Date.now(),
    },
  };
  scheduleFlagFall(io, roomId);

  const clock = clockSnapshot(rooms[roomId]);
  const names = namesOf(rooms[roomId]);

  for (const [entry, color] of [
    [whiteEntry, 'white'],
    [blackEntry, 'black'],
  ]) {
    const s = io.sockets.sockets.get(entry.socketId);
    if (!s) continue;
    s.join(roomId);
    s.emit('match_found', { roomId, color, clock, names });
  }
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
          // Back within the grace window — restart the clock that was frozen
          // when we dropped.
          resumeClock(io, existingRoomId);
          socket.emit('rejoined', {
            roomId: existingRoomId,
            color: seat,
            fen: room.fen,
            clock: clockSnapshot(room),
            names: namesOf(room),
          });
          // Tell the opponent we're back, and unfreeze their clock too.
          socket.to(existingRoomId).emit('opponent_joined', {
            names: namesOf(room),
          });
          socket.to(existingRoomId).emit('clock_update', clockSnapshot(room));
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
        room.startedAt = Date.now(); // for the abort-only-in-the-opening window
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

    // LEAVE GAME — explicitly abandon an in-progress game (logging out mid-game).
    // Unlike leave_room (which just frees a seat in a waiting/finished room),
    // this counts as a forfeit: a live opponent is awarded the win. The room is
    // resolved from the player id so no roomId is needed. Acks once done so the
    // client can wait for the forfeit before disconnecting (logout), making it a
    // reliable, immediate loss rather than racing the disconnect grace.
    socket.on('leave_game', (ack) => {
      const roomId = roomIdOfPlayer(playerId);
      const room = roomId ? rooms[roomId] : null;
      const seat = room ? seatOf(room, playerId) : null;

      if (seat) {
        const opponentSeat = seat === 'white' ? 'black' : 'white';
        // Live game with an opponent present → forfeit, opponent wins.
        if (!room.over && room[opponentSeat]) {
          socket.to(roomId).emit('opponent_resigned');
          endGame(io, roomId, { winner: opponentSeat, reason: 'resignation' });
        }
        releaseSeat(roomId, playerId);
        socket.leave(roomId);
      }

      if (typeof ack === 'function') ack();
    });

    // FIND MATCH — join the matchmaking queue for the chosen time control, or
    // get paired right away if a compatible opponent is already waiting.
    socket.on('find_match', (payload) => {
      // Already seated somewhere? If the game is still live, ignore the click.
      // If it's a finished game they never formally left, free that seat first
      // so they can queue again instead of being stuck in a dead room.
      const currentRoomId = roomIdOfPlayer(playerId);
      if (currentRoomId) {
        if (!rooms[currentRoomId].over) return;
        releaseSeat(currentRoomId, playerId);
      }

      const timeControl = sanitizeTimeControl(payload);
      const key = tcKey(timeControl);

      // Drop any prior entry for this player (double-click / re-search).
      removeFromQueue(playerId);

      // Take the oldest compatible opponent whose socket is still connected,
      // discarding any stale entries we run into on the way.
      let opponent = null;
      while (matchQueue.length) {
        const idx = matchQueue.findIndex(
          (e) => e.key === key && e.playerId !== playerId,
        );
        if (idx === -1) break;
        const candidate = matchQueue.splice(idx, 1)[0];
        if (io.sockets.sockets.get(candidate.socketId)?.connected) {
          opponent = candidate;
          break;
        }
      }

      const me = {
        playerId,
        socketId: socket.id,
        name: nameFromSocket(socket),
        userId: userIdFromSocket(socket),
        timeControl,
        key,
      };

      if (!opponent) {
        matchQueue.push(me);
        socket.emit('match_searching');
        return;
      }

      startMatch(io, opponent, me);
    });

    // CANCEL MATCH — leave the matchmaking queue (the "Cancel" on the searching
    // screen). No-op if not queued.
    socket.on('cancel_match', () => removeFromQueue(playerId));

    socket.on('resign', ({ roomId }) => {
      const room = rooms[roomId];
      const seat = room && seatOf(room, playerId);
      // The resigning side loses; their opponent is credited the win.
      const winner = seat ? (seat === 'white' ? 'black' : 'white') : null;
      endGame(io, roomId, winner ? { winner, reason: 'resignation' } : undefined);
      socket.to(roomId).emit('opponent_resigned');
    });

    // ABORT — cancel the game with no result, but only in the opening: within
    // ABORT_WINDOW_MS of the start. Enforced here so it can't be used to wriggle
    // out of a losing position later. Aborts don't count, so no outcome.
    socket.on('abort', ({ roomId }) => {
      const room = rooms[roomId];
      if (!room || room.over) return;
      if (!seatOf(room, playerId)) return; // not your game

      const tooLate =
        !room.startedAt || Date.now() - room.startedAt > ABORT_WINDOW_MS;
      if (tooLate) return socket.emit('abort_rejected');

      endGame(io, roomId);
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
      endGame(io, roomId, { winner, reason: winner ? 'checkmate' : 'draw' });
    });

    // MAKE MOVE — broadcast to the other player; keep the authoritative FEN and
    // charge the mover's clock, then start the opponent's.
    socket.on('make_move', ({ roomId, move, fen }) => {
      const room = rooms[roomId];
      if (!room) return;
      if (fen) room.fen = fen;

      const c = room.clock;
      if (c?.turn && !c.paused) {
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
      // A searching player who drops should leave the queue so nobody gets
      // paired with a ghost.
      removeFromQueue(playerId);
      const roomId = roomIdOfPlayer(playerId);
      if (!roomId) return;

      // On a reload the new socket can connect BEFORE this old one disconnects.
      // If the seat already points at a newer socket, this is a stale disconnect
      // for an already-reconnected player — ignore it (otherwise we'd schedule a
      // cleanup timer that evicts an active player 30s later).
      const room = rooms[roomId];
      const seat = seatOf(room, playerId);
      if (room[seat]?.socketId !== socket.id) return;

      // Freeze the clock so the disconnected player's time doesn't bleed away
      // during the reconnect window, and tell the opponent (with the countdown
      // length) so their UI can show "reconnecting…" instead of a running clock.
      if (!room.over) {
        pauseClock(roomId);
        io.to(roomId).emit('clock_update', clockSnapshot(room));
      }
      socket.to(roomId).emit('opponent_left', { graceMs: GRACE_MS });

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
              endGame(io, roomId, {
                winner: opponentSeat,
                reason: 'abandonment',
              });
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
