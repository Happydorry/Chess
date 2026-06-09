import { useEffect, useState } from 'react';
import { getProfile, errMsg } from './api';

// A modal showing a player's public profile (rating, record, join date).
// Self-contained: give it a username and it fetches and renders.
export default function Profile({ username, onClose }) {
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    getProfile(username)
      .then((p) => alive && setProfile(p))
      .catch((err) => alive && setError(errMsg(err)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [username]);

  const s = profile?.stats;
  const games = s ? s.wins + s.losses + s.draws : 0;
  const winRate = games ? Math.round((s.wins / games) * 100) : 0;
  const joined = profile?.joined
    ? new Date(profile.joined).toLocaleDateString(undefined, {
        month: 'long',
        year: 'numeric',
      })
    : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <button className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>

        {loading && <p className="modal-subtitle">Loading profile…</p>}
        {error && <div className="banner banner-error">{error}</div>}

        {profile && (
          <>
            <div className="profile-head">
              <div className="profile-avatar" aria-hidden="true">
                {profile.username[0].toUpperCase()}
              </div>
              <h2 className="modal-title">{profile.username}</h2>
              {joined && (
                <p className="modal-subtitle">Member since {joined}</p>
              )}
            </div>

            <div className="profile-rating">
              <span className="profile-rating-value">☆ {profile.rating}</span>
              <span className="profile-rating-label">rating</span>
            </div>

            <div className="profile-stats">
              <div className="profile-stat">
                <span className="profile-stat-num">{s.wins}</span>
                <span className="profile-stat-key">Wins</span>
              </div>
              <div className="profile-stat">
                <span className="profile-stat-num">{s.losses}</span>
                <span className="profile-stat-key">Losses</span>
              </div>
              <div className="profile-stat">
                <span className="profile-stat-num">{s.draws}</span>
                <span className="profile-stat-key">Draws</span>
              </div>
            </div>

            <div className="profile-meta">
              {games} game{games === 1 ? '' : 's'} · {winRate}% win rate
            </div>
          </>
        )}
      </div>
    </div>
  );
}
