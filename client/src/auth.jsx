import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import api from './api';
import { setSocketAuthToken } from './socket';

const AuthContext = createContext(null);
const TOKEN_KEY = 'chess_token';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Persist the token (or clear it) and keep the live socket's handshake in
  // sync so the server sees the right identity after login/logout.
  const applyToken = useCallback((token) => {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    setSocketAuthToken(token || null);
  }, []);

  // On first load, restore a session from a stored token (if still valid).
  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setLoading(false);
      return;
    }
    api
      .get('/auth/me')
      .then((res) => setUser(res.data.user))
      .catch(() => {
        // Token expired / invalid / server unavailable — fall back to guest.
        applyToken(null);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, [applyToken]);

  const register = useCallback(
    async (username, email, password) => {
      const res = await api.post('/auth/register', {
        username,
        email,
        password,
      });
      applyToken(res.data.token);
      setUser(res.data.user);
    },
    [applyToken],
  );

  const login = useCallback(
    async (email, password) => {
      const res = await api.post('/auth/login', { email, password });
      applyToken(res.data.token);
      setUser(res.data.user);
    },
    [applyToken],
  );

  const logout = useCallback(() => {
    applyToken(null);
    setUser(null);
  }, [applyToken]);

  return (
    <AuthContext.Provider value={{ user, loading, register, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
