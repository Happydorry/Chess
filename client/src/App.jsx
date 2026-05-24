import { useEffect, useState } from 'react';
import './App.css';
import { socket } from './socket';
import Lobby from './Lobby';
import Game from './Game';

export default function App() {
  const [gameStatus, setGameStatus] = useState('waiting');
  const [roomId, setRoomId] = useState('');
  const [myColor, setMyColor] = useState('');
  const [initialFen, setInitialFen] = useState('start');

  useEffect(() => {
    const handleRejoined = ({ roomId, color, fen }) => {
      setRoomId(roomId);
      setMyColor(color);
      setInitialFen(fen || 'start');
      setGameStatus('started');
    };
    socket.on('rejoined', handleRejoined);
    return () => socket.off('rejoined', handleRejoined);
  }, []);

  if (gameStatus === 'started') {
    return (
      <Game
        roomId={roomId}
        myColor={myColor}
        initialFen={initialFen}
        onLeave={() => {
          setGameStatus('waiting');
          setRoomId('');
          setMyColor('');
          setInitialFen('start');
        }}
      />
    );
  }

  return (
    <Lobby
      onGameStart={(roomId, color) => {
        setRoomId(roomId);
        setMyColor(color);
        setGameStatus('started');
      }}
    />
  );
}
