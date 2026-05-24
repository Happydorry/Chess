import { useEffect, useRef, useState } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import { socket } from './socket';

const RESULT_ICON = { win: '🏆', loss: '🏳️', draw: '🤝', neutral: '⚠️' };
const RESULT_DELAY_MS = 4000; // how long the "Checkmate!" banner shows first

export default function Game({ roomId, myColor, initialFen = 'start', onLeave }) {
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

  // Clear any pending result timer if we unmount (e.g. Back to Lobby).
  useEffect(() => () => clearTimeout(endTimer.current), []);

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

    socket.on('move_made', handleMoveMade);
    socket.on('opponent_resigned', handleResigned);
    socket.on('opponent_aborted', handleAborted);

    return () => {
      socket.off('move_made', handleMoveMade);
      socket.off('opponent_resigned', handleResigned);
      socket.off('opponent_aborted', handleAborted);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function checkGameOver() {
    const g = gameRef.current;
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

  return (
    <div className="game">
      <p className="game-color">
        You are <strong>{myColor}</strong>
      </p>

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
