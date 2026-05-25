import { useEffect, useRef, useState } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import { socket } from './socket';

const RESULT_ICON = { win: '🏆', loss: '🏳️', draw: '🤝', neutral: '⚠️' };
const RESULT_DELAY_MS = 4000; // how long the "Checkmate!" banner shows first
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
  onLeave,
}) {
  // One Chess instance for the life of the component (it mutates in place, so
  // it must NOT live in useState). Seed from the server's FEN on rejoin.
  const gameRef = useRef(null);
  if (gameRef.current === null) {
    gameRef.current =
      initialFen && initialFen !== 'start' ? new Chess(initialFen) : new Chess();
  }
  const [fen, setFen] = useState(gameRef.current.fen());
  const [announcement, setAnnouncement] = useState(null); // transient banner text
  const [result, setResult] = useState(null); // final card { kind, title, detail }
  const endTimer = useRef(null);

  // Authoritative clock from the server: { white, black, turn, syncedAt }.
  // We tick down locally from syncedAt for a smooth display, but every server
  // message resnaps us to the truth.
  const [clock, setClock] = useState(() =>
    initialClock ? { ...initialClock, syncedAt: Date.now() } : null,
  );
  const frozen = Boolean(result || announcement); // stop ticking once the game ends

  // Clear any pending result timer if we unmount (e.g. Back to Lobby).
  useEffect(() => () => clearTimeout(endTimer.current), []);

  // Re-render a few times a second while a clock is running so it counts down.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!clock?.turn || frozen) return;
    const id = setInterval(() => forceTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [clock?.turn, frozen]);

  // Live remaining ms for a side: subtract elapsed if it's their turn.
  const liveMs = (side) => {
    if (!clock) return null;
    if (clock.turn === side && !frozen) {
      return Math.max(0, clock[side] - (Date.now() - clock.syncedAt));
    }
    return clock[side];
  };

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
        setFen(gameRef.current.fen());
        checkGameOver();
      } catch (err) {
        console.error('Bad move/fen from opponent:', move, fen, err);
      }
    };

    const handleResigned = () =>
      setResult({ kind: 'win', title: 'You win!', detail: 'Opponent resigned' });
    const handleAborted = () =>
      setResult({ kind: 'neutral', title: 'Game aborted', detail: null });

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

    socket.on('move_made', handleMoveMade);
    socket.on('opponent_resigned', handleResigned);
    socket.on('opponent_aborted', handleAborted);
    socket.on('clock_update', handleClockUpdate);
    socket.on('time_up', handleTimeUp);

    return () => {
      socket.off('move_made', handleMoveMade);
      socket.off('opponent_resigned', handleResigned);
      socket.off('opponent_aborted', handleAborted);
      socket.off('clock_update', handleClockUpdate);
      socket.off('time_up', handleTimeUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function checkGameOver() {
    const g = gameRef.current;
    if (g.isGameOver()) socket.emit('game_ended', { roomId }); // stop the clock
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

  if (result) {
    return (
      <div className="game">
        <div className="game-over" data-kind={result.kind}>
          <div className="game-over-icon" aria-hidden="true">
            {RESULT_ICON[result.kind]}
          </div>
          <h2 className="game-over-title">{result.title}</h2>
          {result.detail && <p className="game-over-detail">{result.detail}</p>}
          <button className="btn btn-primary" onClick={onLeave}>
            Back to Lobby
          </button>
        </div>
      </div>
    );
  }

  const opponentColor = myColor === 'white' ? 'black' : 'white';

  const renderClock = (color, who) => {
    const ms = liveMs(color);
    const active = clock?.turn === color && !frozen;
    return (
      <div
        className="clock"
        data-active={active}
        data-low={ms != null && ms <= LOW_TIME_MS}
      >
        <span className="clock-who">
          {who}
          <span className="clock-dot" data-color={color} />
        </span>
        <span className="clock-time">{formatClock(ms)}</span>
      </div>
    );
  };

  return (
    <div className="game">
      {clock && renderClock(opponentColor, 'Opponent')}

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

      {clock && renderClock(myColor, 'You')}

      {!announcement && (
        <div className="game-actions">
          <button className="btn btn-ghost" onClick={handleAbort}>
            Abort
          </button>
          <button className="btn btn-danger" onClick={handleResign}>
            Resign
          </button>
        </div>
      )}
    </div>
  );
}
