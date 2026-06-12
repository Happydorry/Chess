import { useEffect, useState } from 'react';
import { getProfile, getProfileGames, errMsg } from './api';

// Time control as a compact "5+0" (minutes + increment seconds).
const fmtTC = (tc) =>
  tc?.initialMs != null
    ? `${Math.round(tc.initialMs / 60000)}+${Math.round((tc.incrementMs || 0) / 1000)}`
    : '';

const RESULT_LETTER = { win: 'W', loss: 'L', draw: 'D' };

// A modal showing a player's public profile (rating, record, join date) plus
// their recent games. Self-contained: give it a username and it fetches.
export default function Profile({ username, onClose }) {
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [games, setGames] = useState(null); // null = still loading

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setGames(null);
    getProfile(username)
      .then((p) => alive && setProfile(p))
      .catch((err) => alive && setError(errMsg(err)))
      .finally(() => alive && setLoading(false));
    // History is secondary — if it fails, just show an empty list.
    getProfileGames(username)
      .then((g) => alive && setGames(g))
      .catch(() => alive && setGames([]));
    return () => {
      alive = false;
    };
  }, [username]);

  const s = profile?.stats;
  const totalGames = s ? s.wins + s.losses + s.draws : 0;
  const winRate = totalGames ? Math.round((s.wins / totalGames) * 100) : 0;
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
              {totalGames} game{totalGames === 1 ? '' : 's'} · {winRate}% win
              rate
            </div>

            <div className="history">
              <div className="history-title">Recent games</div>
              {games === null ? (
                <p className="history-empty">Loading…</p>
              ) : games.length === 0 ? (
                <p className="history-empty">No games yet.</p>
              ) : (
                <ul className="history-list">
                  {games.map((g) => (
                    <li className="history-row" key={g.id}>
                      <span className="history-badge" data-result={g.result}>
                        {RESULT_LETTER[g.result]}
                      </span>
                      <span className="history-opp">vs {g.opponent}</span>
                      <span className="history-tc">{fmtTC(g.timeControl)}</span>
                      {g.ratingDelta != null && (
                        <span
                          className="history-delta"
                          data-dir={g.ratingDelta >= 0 ? 'up' : 'down'}
                        >
                          {g.ratingDelta >= 0 ? '+' : ''}
                          {g.ratingDelta}
                        </span>
                      )}
                      <span className="history-date">
                        {new Date(g.date).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
