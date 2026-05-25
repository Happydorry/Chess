import { useEffect, useRef, useState } from 'react';
import { socket } from './socket';

export default function Lobby({ onGameStart }) {
  const [roomId, setRoomId] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [myColor, setMyColor] = useState(null);

  // Holds the latest room info so socket callbacks never read stale state.
  const roomInfo = useRef({ roomId: '', color: null });

  useEffect(() => {
    const handleRoomCreated = ({ roomId, color }) => {
      roomInfo.current = { roomId, color };
      setRoomId(roomId);
      setMyColor(color);
    };

    const handleRoomJoined = ({ roomId, color, clock }) => {
      roomInfo.current = { roomId, color };
      setRoomId(roomId);
      setMyColor(color);
      // Black just filled the room — the game can start right away.
      onGameStart(roomId, color, clock);
    };

    const handleOpponentJoined = ({ clock } = {}) => {
      // White's opponent arrived — start with the stored room info.
      const { roomId, color } = roomInfo.current;
      onGameStart(roomId, color, clock);
    };

    socket.on('room_created', handleRoomCreated);
    socket.on('room_joined', handleRoomJoined);
    socket.on('opponent_joined', handleOpponentJoined);

    // Cleanup: a useEffect must return a function (or nothing).
    return () => {
      socket.off('room_created', handleRoomCreated);
      socket.off('room_joined', handleRoomJoined);
      socket.off('opponent_joined', handleOpponentJoined);
    };
  }, [onGameStart]);

  // ✅ Emits go inside button handlers, not loose in the component.
  const handleCreateRoom = () => {
    socket.emit('create_room');
  };

  const handleJoinRoom = () => {
    if (!inputValue.trim()) return;
    socket.emit('join_room', { roomId: inputValue.trim().toUpperCase() });
  };

  const inRoom = Boolean(roomId);

  return (
    <div className="lobby">
      <div className="lobby-card">
        <div className="lobby-logo" aria-hidden="true">
          ♞
        </div>
        <h1 className="lobby-title">Chess</h1>
        <p className="lobby-subtitle">
          Create a room or join with a code to play.
        </p>

        {!inRoom && (
          <>
            <button className="btn btn-primary" onClick={handleCreateRoom}>
              Create Room
            </button>

            <div className="divider">
              <span>or</span>
            </div>

            <div className="join-row">
              <input
                className="room-input"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && handleJoinRoom()}
                placeholder="ENTER CODE"
                maxLength={6}
              />
              <button className="btn btn-ghost" onClick={handleJoinRoom}>
                Join
              </button>
            </div>
          </>
        )}

        {inRoom && (
          <div className="room-status">
            <div className="room-code-label">Room code</div>
            <div className="room-code">{roomId}</div>

            <div className="color-badge" data-color={myColor}>
              You play <strong>{myColor}</strong>
            </div>

            <div className="banner banner-waiting">
              <span className="spinner" /> Waiting for opponent…
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
