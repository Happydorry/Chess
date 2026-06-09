import axios from 'axios';
import { SERVER_URL } from './socket';

// All auth calls go to the same server that hosts the sockets.
const api = axios.create({ baseURL: `${SERVER_URL}/api` });

// Attach the stored JWT (if any) to every request.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('chess_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Fetch a player's public profile by username.
export async function getProfile(username) {
  const res = await api.get(`/users/${encodeURIComponent(username)}`);
  return res.data.profile;
}

// Pull a human-readable message out of an axios error.
export function errMsg(err) {
  return (
    err?.response?.data?.error ||
    (err?.message === 'Network Error'
      ? 'Cannot reach the server. Try again in a moment.'
      : 'Something went wrong.')
  );
}

export default api;
