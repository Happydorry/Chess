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
  const [initialClock, setInitialClock] = useState(null);

  useEffect(() => {
    const handleRejoined = ({ roomId, color, fen, clock }) => {
      setRoomId(roomId);
      setMyColor(color);
      setInitialFen(fen || 'start');
      setInitialClock(clock || null);
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
        initialClock={initialClock}
        onLeave={() => {
          setGameStatus('waiting');
          setRoomId('');
          setMyColor('');
          setInitialFen('start');
          setInitialClock(null);
        }}
      />
    );
  }

  return (
    <Lobby
      onGameStart={(roomId, color, clock) => {
        setRoomId(roomId);
        setMyColor(color);
        setInitialClock(clock || null);
        setGameStatus('started');
      }}
    />
  );
}
