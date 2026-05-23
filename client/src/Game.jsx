import { useEffect, useRef, useState } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import { socket } from './socket';

export default function Game({ roomId, myColor, initialFen = 'start' }) {
  // One Chess instance for the life of the component (it mutates in place, so
  // it must NOT live in useState). Seed it from the server's FEN on rejoin.
  const gameRef = useRef(null);
  if (gameRef.current === null) {
    gameRef.current =
      initialFen && initialFen !== 'start' ? new Chess(initialFen) : new Chess();
  }
  const [fen, setFen] = useState(gameRef.current.fen());

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
      } catch (err) {
        console.error('Bad move/fen from opponent:', move, fen, err);
      }
    };

    socket.on('move_made', handleMoveMade);
    return () => socket.off('move_made', handleMoveMade);
  }, []);

  // react-chessboard v5: onPieceDrop receives a single object and returns bool.
  function onPieceDrop({ sourceSquare, targetSquare }) {
    if (!targetSquare) return false; // dropped off the board

    const game = gameRef.current;

    // Only let the player move on their own turn.
    if (game.turn() !== myColor[0]) return false; // 'w' or 'b'

    let move;
    try {
      move = game.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: 'q', // auto-promote to queen
      });
    } catch {
      return false; // chess.js v1 throws on an illegal move
    }

    if (!move) return false;

    const newFen = game.fen();
    setFen(newFen);
    socket.emit('make_move', { roomId, move, fen: newFen });
    return true;
  }

  return (
    <div style={{ width: '500px', margin: '0 auto' }}>
      <p>You are: {myColor}</p>
      <Chessboard
        options={{
          id: 'main-board',
          position: fen,
          onPieceDrop,
          boardOrientation: myColor === 'white' ? 'white' : 'black',
        }}
      />
    </div>
  );
}
