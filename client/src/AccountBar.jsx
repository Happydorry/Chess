import { useState } from 'react';
import { useAuth } from './auth';
import AuthModal from './AuthModal';
import Profile from './Profile';

// Fixed top-right account controls. Shown on every screen (lobby + game).
// Logged out: Log in / Sign up. Logged in: username + Log out. Guest play is
// unaffected either way.
export default function AccountBar() {
  const { user, loading, logout } = useAuth();
  const [modal, setModal] = useState(null); // 'login' | 'register' | null
  const [profileOpen, setProfileOpen] = useState(false);

  if (loading) return null;

  const stats = user?.stats;

  return (
    <>
      <div className="account-bar">
        {user ? (
          <>
            <button
              type="button"
              className="account-card"
              onClick={() => setProfileOpen(true)}
              title="View your profile"
            >
              <span className="account-name">♟ {user.username}</span>
              {typeof user.rating === 'number' && (
                <span className="account-rating">☆ {user.rating}</span>
              )}
              {stats && (
                <span className="account-stats">
                  {stats.wins}W {stats.losses}L {stats.draws}D
                </span>
              )}
            </button>
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

      {profileOpen && user && (
        <Profile
          username={user.username}
          onClose={() => setProfileOpen(false)}
        />
      )}
    </>
  );
}
