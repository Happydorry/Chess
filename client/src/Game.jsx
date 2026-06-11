import { useEffect, useRef, useState } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import { socket } from './socket';
import { useAuth } from './auth';
import Profile from './Profile';

const RESULT_ICON = { win: '🏆', loss: '🏳️', draw: '🤝', neutral: '⚠️' };
const RESULT_DELAY_MS = 4000; // how long the "Checkmate!" banner shows first
const ABORT_WINDOW_MS = 20_000; // abort is only offered this long after the start
const LOW_TIME_MS = 20_000; // turn the clock red below this

// mm:ss, but show tenths under 10s for the final scramble.
function formatClock(ms) {
  if (ms == null) return '–:––';
  if (ms < 10_000) return (ms / 1000).toFixed(1);
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function Game({
  roomId,
  myColor,
  initialFen = 'start',
  initialClock = null,
  names = null,
  onLeave,
}) {
  // One Chess instance for the life of the component (it mutates in place, so
  // it must NOT live in useState). Seed from the server's FEN on rejoin.
  const gameRef = useRef(null);
  if (gameRef.current === null) {
    gameRef.current =
      initialFen && initialFen !== 'start' ? new Chess(initialFen) : new Chess();
  }
  const { user, mergeUser } = useAuth();
  const [fen, setFen] = useState(gameRef.current.fen());
  const [announcement, setAnnouncement] = useState(null); // transient banner text
  const [result, setResult] = useState(null); // final card { kind, title, detail }
  const [record, setRecord] = useState(null); // my updated {wins,losses,draws}
  const [profileName, setProfileName] = useState(null); // open profile modal
  const [oppGone, setOppGone] = useState(null); // { until } while opponent is disconnected
  // Abort is only offered in the opening: for ~20s after the start, and not at
  // all if we joined mid-game (a rejoin starts with a non-initial position).
  const [canAbort, setCanAbort] = useState(!initialFen || initialFen === 'start');
  const endTimer = useRef(null);

  // Move log for in-game replay. Each entry is { fen, san }; the first entry is
  // the starting position (san: null). Recorded on both sides as moves happen.
  // Caveat: a player who rejoins mid-game only has the moves played from that
  // point onward — full-game history would need server-side persistence.
  const [moveLog, setMoveLog] = useState(() => [
    { fen: gameRef.current.fen(), san: null },
  ]);
  const [reviewing, setReviewing] = useState(false);
  const [reviewIndex, setReviewIndex] = useState(0);

  // Authoritative clock from the server: { white, black, turn, syncedAt }.
  // We tick down locally from syncedAt for a smooth display, but every server
  // message resnaps us to the truth.
  const [clock, setClock] = useState(() =>
    initialClock ? { ...initialClock, syncedAt: Date.now() } : null,
  );
  const frozen = Boolean(result || announcement); // stop ticking once the game ends

  // Clear any pending result timer if we unmount (e.g. Back to Lobby).
  useEffect(() => () => clearTimeout(endTimer.current), []);

  // Logging out mid-game forfeits it (auth.logout emits leave_game). Detect the
  // logged-in → logged-out transition and return to the lobby, so we don't sit
  // on a board the server has already torn down.
  const wasLoggedIn = useRef(Boolean(user));
  useEffect(() => {
    if (wasLoggedIn.current && !user) onLeave();
    wasLoggedIn.current = Boolean(user);
  }, [user, onLeave]);

  // Arrow keys (and Home/End) step through the replay when reviewing.
  useEffect(() => {
    if (!reviewing) return;
    const last = moveLog.length - 1;
    const handler = (e) => {
      if (e.key === 'ArrowLeft')
        setReviewIndex((i) => Math.max(0, i - 1));
      else if (e.key === 'ArrowRight')
        setReviewIndex((i) => Math.min(last, i + 1));
      else if (e.key === 'Home') setReviewIndex(0);
      else if (e.key === 'End') setReviewIndex(last);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [reviewing, moveLog.length]);

  // Re-render a few times a second while a clock is running so it counts down.
  // Paused (opponent disconnected) stops the tick too.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!clock?.turn || frozen || clock.paused) return;
    const id = setInterval(() => forceTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [clock?.turn, clock?.paused, frozen]);

  // Tick the "opponent reconnecting" countdown while it's showing.
  useEffect(() => {
    if (!oppGone) return;
    const id = setInterval(() => forceTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [oppGone]);

  // Close the abort window 20s after the game opens (server enforces it too).
  useEffect(() => {
    if (!canAbort) return;
    const id = setTimeout(() => setCanAbort(false), ABORT_WINDOW_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live remaining ms for a side: subtract elapsed if it's their turn (and the
  // clock isn't paused mid-disconnect).
  const liveMs = (side) => {
    if (!clock) return null;
    if (clock.turn === side && !frozen && !clock.paused) {
      return Math.max(0, clock[side] - (Date.now() - clock.syncedAt));
    }
    return clock[side];
  };

  // Returning to the lobby after a game: tell the server to free our seat so the
  // finished room is cleaned up and matchmaking won't think we're still in it.
  function handleLeave() {
    socket.emit('leave_room', { roomId });
    onLeave();
  }

  // End the game: optionally flash a banner first, then show the result card.
  function endGame(res, banner) {
    if (banner) {
      setAnnouncement(banner);
      endTimer.current = setTimeout(() => setResult(res), RESULT_DELAY_MS);
    } else {
      setResult(res);
    }
  }

  useEffect(() => {
    // Opponent moved — sync to the authoritative position the server sent.
    const handleMoveMade = ({ move, fen }) => {
      try {
        if (fen) {
          gameRef.current = new Chess(fen);
        } else {
          gameRef.current.move(move);
        }
        const newFen = gameRef.current.fen();
        setFen(newFen);
        setMoveLog((log) => [...log, { fen: newFen, san: move?.san ?? '?' }]);
        checkGameOver();
      } catch (err) {
        console.error('Bad move/fen from opponent:', move, fen, err);
      }
    };

    const handleResigned = () =>
      setResult({ kind: 'win', title: 'You win!', detail: 'Opponent resigned' });
    const handleAborted = () =>
      setResult({ kind: 'neutral', title: 'Game aborted', detail: null });

    // Server refused the abort (window has passed) — undo the optimistic card
    // and hide the button.
    const handleAbortRejected = () => {
      setCanAbort(false);
      setResult(null);
    };

    // Opponent dropped — show a reconnect countdown and freeze the board notice
    // (their clock is already paused server-side).
    const handleOpponentLeft = ({ graceMs } = {}) =>
      setOppGone({ until: Date.now() + (graceMs || 0) });

    // Opponent came back within the grace window — clear the notice.
    const handleOpponentBack = () => setOppGone(null);

    // Grace expired without the opponent reconnecting — forfeit.
    const handleForfeit = ({ winner }) => {
      setOppGone(null);
      setResult(
        winner === myColor
          ? {
              kind: 'win',
              title: 'You win!',
              detail: 'opponent disconnected',
            }
          : { kind: 'loss', title: 'You lose', detail: 'disconnected' },
      );
    };

    const handleClockUpdate = (c) =>
      setClock(c ? { ...c, syncedAt: Date.now() } : null);

    const handleTimeUp = ({ winner, clock: c }) => {
      if (c) setClock({ ...c, syncedAt: Date.now() });
      endGame(
        winner === myColor
          ? { kind: 'win', title: 'You win!', detail: 'opponent ran out of time' }
          : { kind: 'loss', title: 'You lose', detail: 'on time' },
        'Time!',
      );
    };

    // Server recorded the result — pick out my side's fresh record and apply it
    // to the account so the card and account bar both reflect it. null = a guest
    // seat (no account to update).
    const handleStatsUpdate = ({ white, black }) => {
      const mine = myColor === 'white' ? white : black;
      if (!mine) return;
      setRecord(mine);
      mergeUser({
        stats: { wins: mine.wins, losses: mine.losses, draws: mine.draws },
        rating: mine.rating,
      });
    };

    socket.on('move_made', handleMoveMade);
    socket.on('opponent_resigned', handleResigned);
    socket.on('opponent_aborted', handleAborted);
    socket.on('abort_rejected', handleAbortRejected);
    socket.on('opponent_left', handleOpponentLeft);
    socket.on('opponent_joined', handleOpponentBack);
    socket.on('clock_update', handleClockUpdate);
    socket.on('time_up', handleTimeUp);
    socket.on('opponent_forfeit', handleForfeit);
    socket.on('stats_update', handleStatsUpdate);

    return () => {
      socket.off('move_made', handleMoveMade);
      socket.off('opponent_resigned', handleResigned);
      socket.off('opponent_aborted', handleAborted);
      socket.off('abort_rejected', handleAbortRejected);
      socket.off('opponent_left', handleOpponentLeft);
      socket.off('opponent_joined', handleOpponentBack);
      socket.off('clock_update', handleClockUpdate);
      socket.off('time_up', handleTimeUp);
      socket.off('opponent_forfeit', handleForfeit);
      socket.off('stats_update', handleStatsUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function checkGameOver() {
    const g = gameRef.current;
    if (g.isGameOver()) {
      // The side to move is checkmated (if any) loses; everything else is a draw.
      const winner = g.isCheckmate()
        ? g.turn() === 'w'
          ? 'black'
          : 'white'
        : null;
      // Stop the clock and report the result so it's recorded to the accounts.
      socket.emit('game_ended', { roomId, result: { winner } });
    }
    if (g.isCheckmate()) {
      // The side to move is checkmated — so the other side won.
      const winner = g.turn() === 'w' ? 'black' : 'white';
      endGame(
        winner === myColor
          ? { kind: 'win', title: 'You win!', detail: 'by checkmate' }
          : { kind: 'loss', title: 'You lose', detail: 'by checkmate' },
        'Checkmate!',
      );
    } else if (g.isStalemate()) {
      endGame({ kind: 'draw', title: 'Draw', detail: 'by stalemate' }, 'Stalemate!');
    } else if (g.isDraw()) {
      endGame({ kind: 'draw', title: 'Draw', detail: null });
    }
  }

  // react-chessboard v5: onPieceDrop receives a single object and returns bool.
  function onPieceDrop({ sourceSquare, targetSquare }) {
    if (result || announcement) return false; // game over / ending
    if (!targetSquare) return false; // dropped off the board

    const game = gameRef.current;
    if (game.turn() !== myColor[0]) return false; // only on your turn

    let move;
    try {
      move = game.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: 'q',
      });
    } catch {
      return false; // chess.js v1 throws on an illegal move
    }

    if (!move) return false;

    const newFen = game.fen();
    setFen(newFen);
    setMoveLog((log) => [...log, { fen: newFen, san: move.san }]);
    socket.emit('make_move', { roomId, move, fen: newFen });
    checkGameOver();
    return true;
  }

  function handleResign() {
    socket.emit('resign', { roomId });
    setResult({ kind: 'loss', title: 'You resigned', detail: null });
  }

  function handleAbort() {
    socket.emit('abort', { roomId });
    setResult({ kind: 'neutral', title: 'Game aborted', detail: null });
  }

  // Review mode: replay the just-finished game move-by-move.
  if (result && reviewing) {
    const lastIndex = moveLog.length - 1;
    const current = moveLog[reviewIndex] ?? moveLog[0];
    return (
      <div className="game">
        <div className="review-header">
          <span className="review-title">Game review</span>
          <span className="review-counter">
            {reviewIndex === 0
              ? 'Start position'
              : `Move ${reviewIndex} of ${lastIndex} · ${current.san}`}
          </span>
        </div>

        <div className="board-wrap">
          <Chessboard
            options={{
              id: 'review-board',
              position: current.fen,
              onPieceDrop: () => false,
              arePiecesDraggable: false,
              boardOrientation: myColor === 'white' ? 'white' : 'black',
            }}
          />
        </div>

        <div className="review-nav">
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => setReviewIndex(0)}
            disabled={reviewIndex === 0}
            aria-label="First move"
          >
            ⏮
          </button>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => setReviewIndex((i) => Math.max(0, i - 1))}
            disabled={reviewIndex === 0}
            aria-label="Previous move"
          >
            ◀
          </button>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() =>
              setReviewIndex((i) => Math.min(lastIndex, i + 1))
            }
            disabled={reviewIndex === lastIndex}
            aria-label="Next move"
          >
            ▶
          </button>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => setReviewIndex(lastIndex)}
            disabled={reviewIndex === lastIndex}
            aria-label="Last move"
          >
            ⏭
          </button>
        </div>

        <div className="review-footer">
          <button
            className="btn btn-ghost"
            onClick={() => setReviewing(false)}
          >
            Done
          </button>
          <button className="btn btn-primary" onClick={handleLeave}>
            Back to Lobby
          </button>
        </div>
      </div>
    );
  }

  if (result) {
    const hasMoves = moveLog.length > 1;
    return (
      <div className="game">
        <div className="game-over" data-kind={result.kind}>
          <div className="game-over-icon" aria-hidden="true">
            {RESULT_ICON[result.kind]}
          </div>
          <h2 className="game-over-title">{result.title}</h2>
          {result.detail && <p className="game-over-detail">{result.detail}</p>}
          {record?.rated && (
            <p className="game-over-rating">
              Rating {record.rating}{' '}
              <span
                className="rating-delta"
                data-dir={record.delta >= 0 ? 'up' : 'down'}
              >
                {record.delta >= 0 ? '+' : ''}
                {record.delta}
              </span>
            </p>
          )}
          {record && (
            <p className="game-over-record">
              Your record: {record.wins}W · {record.losses}L · {record.draws}D
            </p>
          )}
          <div className="game-over-actions">
            {hasMoves && (
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setReviewIndex(moveLog.length - 1);
                  setReviewing(true);
                }}
              >
                Review game
              </button>
            )}
            <button className="btn btn-primary" onClick={handleLeave}>
              Back to Lobby
            </button>
          </div>
        </div>
      </div>
    );
  }

  const opponentColor = myColor === 'white' ? 'black' : 'white';

  // Show real usernames when available; fall back to You/Opponent for guests.
  // A real account name (not a guest) is also a link to that player's profile.
  const myName = names?.[myColor];
  const opponentName = names?.[opponentColor];
  const myUsername = myName && myName !== 'Guest' ? myName : null;
  const opponentUsername =
    opponentName && opponentName !== 'Guest' ? opponentName : null;
  const myLabel = myUsername ? `${myUsername} (you)` : 'You';
  const opponentLabel = opponentUsername || 'Opponent';

  const renderClock = (color, label, username) => {
    const ms = liveMs(color);
    const active = clock?.turn === color && !frozen;
    return (
      <div
        className="clock"
        data-active={active}
        data-low={ms != null && ms <= LOW_TIME_MS}
      >
        <span className="clock-who">
          {username ? (
            <button
              type="button"
              className="player-name-btn"
              onClick={() => setProfileName(username)}
              title={`View ${username}'s profile`}
            >
              {label}
            </button>
          ) : (
            label
          )}
          <span className="clock-dot" data-color={color} />
        </span>
        <span className="clock-time">{formatClock(ms)}</span>
      </div>
    );
  };

  return (
    <div className="game">
      {profileName && (
        <Profile
          username={profileName}
          onClose={() => setProfileName(null)}
        />
      )}

      {clock && renderClock(opponentColor, opponentLabel, opponentUsername)}

      {oppGone && !result && !announcement && (
        <div className="banner banner-waiting disconnect-notice">
          <span className="spinner" /> Opponent disconnected —{' '}
          {Math.max(0, Math.ceil((oppGone.until - Date.now()) / 1000))}s to
          reconnect…
        </div>
      )}

      <div className="board-wrap">
        <Chessboard
          options={{
            id: 'main-board',
            position: fen,
            onPieceDrop,
            boardOrientation: myColor === 'white' ? 'white' : 'black',
          }}
        />
        {announcement && (
          <div className="announcement-overlay">
            <span className="announcement-text">{announcement}</span>
          </div>
        )}
      </div>

      {clock && renderClock(myColor, myLabel, myUsername)}

      {!announcement && (
        <div className="game-actions">
          {canAbort && (
            <button className="btn btn-ghost" onClick={handleAbort}>
              Abort
            </button>
          )}
          <button className="btn btn-danger" onClick={handleResign}>
            Resign
          </button>
        </div>
      )}
    </div>
  );
}
