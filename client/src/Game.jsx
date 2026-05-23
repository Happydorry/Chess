import { useEffect, useState } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import { socket } from './socket';

export default function Game({ roomId, myColor }) {
  const [game, setGame] = useState(new Chess());
  const [fen, setFen] = useState('start');

  useEffect(() => {
    // Opponent made a move — update our board
    socket.on('move_made', ({ move }) => {
      setGame((prev) => {
        const updated = new Chess(prev.fen());
        updated.move(move);
        setFen(updated.fen());
        return updated;
      });
    });

    return () => {
      socket.off('move_made');
    };
  }, []);

  function onDrop(sourceSquare, targetSquare) {
    // Only move on your turn
    if (game.turn() !== myColor[0]) return false; // 'w' or 'b'

    const move = game.move({
      from: sourceSquare,
      to: targetSquare,
      promotion: 'q', // auto-promote to queen
    });

    // Illegal move
    if (!move) return false;

    setFen(game.fen());
    socket.emit('make_move', { roomId, move });
    return true;
  }

  return (
    <div style={{ width: '500px', margin: '0 auto' }}>
      <p>You are: {myColor}</p>
      <Chessboard
        position={fen}
        onPieceDrop={onDrop}
        boardOrientation={myColor === 'white' ? 'white' : 'black'}
      />
    </div>
  );
}
