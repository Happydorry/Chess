import { useState } from 'react';
import './App.css';
import Lobby from './Lobby';
import Game from './Game';

export default function App() {
  const [gameStatus, setGameStatus] = useState('waiting');
  const [roomId, setRoomId] = useState('');
  const [myColor, setMyColor] = useState('');

  if (gameStatus === 'started') {
    return <Game roomId={roomId} myColor={myColor} />;
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
