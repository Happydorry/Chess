import { useEffect, useMemo, useState } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import { getGame, errMsg } from './api';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Modal that replays a finished game move by move. Give it a game id; it fetches
// the game, rebuilds each position from the SAN move list, and offers step
// controls (buttons + arrow keys).
export default function Replay({ gameId, onClose }) {
  const [game, setGame] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [index, setIndex] = useState(0);

  // The parent remounts this per game (keyed by id), so initial state already
  // covers each open — no need to reset synchronously here.
  useEffect(() => {
    let alive = true;
    getGame(gameId)
      .then((g) => alive && setGame(g))
      .catch((err) => alive && setError(errMsg(err)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [gameId]);

  // Positions[0] is the start; positions[i] is the board after i moves.
  const positions = useMemo(() => {
    const chess = new Chess();
    const fens = [chess.fen()];
    for (const san of game?.moves ?? []) {
      try {
        chess.move(san);
        fens.push(chess.fen());
      } catch {
        break; // stop at the first move that won't apply (shouldn't happen)
      }
    }
    return fens;
  }, [game]);

  const last = positions.length - 1;
  const i = Math.min(index, last);

  // Arrow keys (and Home/End) step through; Escape closes.
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'ArrowLeft') setIndex((n) => Math.max(0, n - 1));
      else if (e.key === 'ArrowRight') setIndex((n) => Math.min(last, n + 1));
      else if (e.key === 'Home') setIndex(0);
      else if (e.key === 'End') setIndex(last);
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [last, onClose]);

  const moves = game?.moves ?? [];
  const sanAt = i > 0 ? moves[i - 1] : null;
  const resultText = game
    ? game.winner == null
      ? 'Draw'
      : `${cap(game.winner)} won${game.reason ? ` by ${game.reason}` : ''}`
    : '';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card replay-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <button className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>

        {loading && <p className="modal-subtitle">Loading game…</p>}
        {error && <div className="banner banner-error">{error}</div>}

        {game && (
          <>
            <div className="replay-head">
              <span className="replay-players">
                {game.white.name || 'White'} vs {game.black.name || 'Black'}
              </span>
              <span className="replay-result">{resultText}</span>
            </div>

            <div className="board-wrap">
              <Chessboard
                options={{
                  id: 'replay-board',
                  position: positions[i],
                  onPieceDrop: () => false,
                  arePiecesDraggable: false,
                }}
              />
            </div>

            <div className="review-counter">
              {i === 0 ? 'Start position' : `Move ${i} of ${last} · ${sanAt}`}
            </div>

            <div className="review-nav">
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => setIndex(0)}
                disabled={i === 0}
                aria-label="First move"
              >
                ⏮
              </button>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => setIndex((n) => Math.max(0, n - 1))}
                disabled={i === 0}
                aria-label="Previous move"
              >
                ◀
              </button>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => setIndex((n) => Math.min(last, n + 1))}
                disabled={i === last}
                aria-label="Next move"
              >
                ▶
              </button>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => setIndex(last)}
                disabled={i === last}
                aria-label="Last move"
              >
                ⏭
              </button>
            </div>

            {last === 0 && (
              <p className="history-empty">
                No moves were recorded for this game.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
