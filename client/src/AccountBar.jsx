import { useState } from 'react';
import { useAuth } from './auth';
import AuthModal from './AuthModal';

// Fixed top-right account controls. Shown on every screen (lobby + game).
// Logged out: Log in / Sign up. Logged in: username + Log out. Guest play is
// unaffected either way.
export default function AccountBar() {
  const { user, loading, logout } = useAuth();
  const [modal, setModal] = useState(null); // 'login' | 'register' | null

  if (loading) return null;

  const stats = user?.stats;

  return (
    <>
      <div className="account-bar">
        {user ? (
          <>
            <div className="account-card">
              <span className="account-name" title={user.email}>
                ♟ {user.username}
              </span>
              {typeof user.rating === 'number' && (
                <span className="account-rating" title="Elo rating">
                  {user.rating}
                </span>
              )}
              {stats && (
                <span
                  className="account-stats"
                  title={`${stats.wins} wins · ${stats.losses} losses · ${stats.draws} draws`}
                >
                  {stats.wins}W {stats.losses}L {stats.draws}D
                </span>
              )}
            </div>
            <button className="btn btn-ghost btn-sm" onClick={logout}>
              Log out
            </button>
          </>
        ) : (
          <>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setModal('login')}
            >
              Log in
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setModal('register')}
            >
              Sign up
            </button>
          </>
        )}
      </div>

      {modal && (
        <AuthModal initialMode={modal} onClose={() => setModal(null)} />
      )}
    </>
  );
}
