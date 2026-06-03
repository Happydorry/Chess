import { useEffect, useRef, useState } from 'react';
import { socket } from './socket';

// Game-length presets the room creator can choose from.
const TIME_PRESETS = [
  { label: '1 min', sub: 'Bullet', timeMs: 60_000, incrementMs: 0 },
  { label: '3 min', sub: 'Blitz', timeMs: 180_000, incrementMs: 0 },
  { label: '5 min', sub: 'Blitz', timeMs: 300_000, incrementMs: 0 },
  { label: '10 min', sub: 'Rapid', timeMs: 600_000, incrementMs: 0 },
];
const DEFAULT_PRESET = 2; // 5 min

export default function Lobby({ onGameStart }) {
  const [roomId, setRoomId] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [myColor, setMyColor] = useState(null);
  const [presetIndex, setPresetIndex] = useState(DEFAULT_PRESET);
  const [errorMsg, setErrorMsg] = useState(null);
  const [copied, setCopied] = useState(null); // 'link' | 'code' | null
  const copyTimer = useRef(null);

  // Holds the latest room info so socket callbacks never read stale state.
  const roomInfo = useRef({ roomId: '', color: null });

  useEffect(() => {
    const handleRoomCreated = ({ roomId, color }) => {
      roomInfo.current = { roomId, color };
      setRoomId(roomId);
      setMyColor(color);
    };

    const handleRoomJoined = ({ roomId, color, clock, names }) => {
      roomInfo.current = { roomId, color };
      setRoomId(roomId);
      setMyColor(color);
      // Black just filled the room — the game can start right away.
      onGameStart(roomId, color, clock, names);
    };

    const handleOpponentJoined = ({ clock, names } = {}) => {
      // White's opponent arrived — start with the stored room info.
      const { roomId, color } = roomInfo.current;
      onGameStart(roomId, color, clock, names);
    };

    const handleError = ({ msg }) => setErrorMsg(msg || 'Something went wrong');

    socket.on('room_created', handleRoomCreated);
    socket.on('room_joined', handleRoomJoined);
    socket.on('opponent_joined', handleOpponentJoined);
    socket.on('error', handleError);

    // Cleanup: a useEffect must return a function (or nothing).
    return () => {
      socket.off('room_created', handleRoomCreated);
      socket.off('room_joined', handleRoomJoined);
      socket.off('opponent_joined', handleOpponentJoined);
      socket.off('error', handleError);
    };
  }, [onGameStart]);

  // If the page was opened via an invite link (?join=ABCDEF), auto-join the
  // room and strip the query so a refresh doesn't loop. Runs once on mount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('join');
    if (code) {
      socket.emit('join_room', { roomId: code.trim().toUpperCase() });
      window.history.replaceState({}, '', window.location.pathname);
    }
    return () => clearTimeout(copyTimer.current);
  }, []);

  // ✅ Emits go inside button handlers, not loose in the component.
  const handleCreateRoom = () => {
    setErrorMsg(null);
    const { timeMs, incrementMs } = TIME_PRESETS[presetIndex];
    socket.emit('create_room', { timeMs, incrementMs });
  };

  const handleJoinRoom = () => {
    if (!inputValue.trim()) return;
    setErrorMsg(null);
    socket.emit('join_room', { roomId: inputValue.trim().toUpperCase() });
  };

  // Clipboard helpers — show a transient "Copied!" state on the button.
  const flashCopied = (kind) => {
    setCopied(kind);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 2000);
  };

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/?join=${roomId}`;
    try {
      await navigator.clipboard.writeText(url);
      flashCopied('link');
    } catch (err) {
      console.error('Copy failed', err);
    }
  };

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(roomId);
      flashCopied('code');
    } catch (err) {
      console.error('Copy failed', err);
    }
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

        {errorMsg && <div className="banner banner-error">{errorMsg}</div>}

        {!inRoom && (
          <>
            <div className="time-control">
              <div className="time-control-label">Game length</div>
              <div className="time-options">
                {TIME_PRESETS.map((preset, i) => (
                  <button
                    key={preset.label}
                    type="button"
                    className="time-option"
                    data-selected={i === presetIndex}
                    onClick={() => setPresetIndex(i)}
                  >
                    <span className="time-option-main">{preset.label}</span>
                    <span className="time-option-sub">{preset.sub}</span>
                  </button>
                ))}
              </div>
            </div>

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

            <div className="share-row">
              <button
                className="btn btn-share"
                data-copied={copied === 'link'}
                onClick={handleCopyLink}
              >
                {copied === 'link' ? '✓ Link copied' : 'Copy invite link'}
              </button>
              <button
                className="btn btn-share-ghost"
                data-copied={copied === 'code'}
                onClick={handleCopyCode}
              >
                {copied === 'code' ? '✓ Code copied' : 'Copy code'}
              </button>
            </div>

            <div className="color-badge" data-color={myColor}>
              You play <strong>{myColor}</strong>
            </div>

            <div className="color-badge">
              {TIME_PRESETS[presetIndex].label} · {TIME_PRESETS[presetIndex].sub}
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
