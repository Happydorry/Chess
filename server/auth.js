const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('./models/User');
const { signToken, verifyToken } = require('./token');
const { isDBConnected } = require('./db');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 12;

// Shape we send to the client — never expose the password hash.
function publicUser(user) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    stats: user.stats,
    rating: user.rating,
  };
}

// Express middleware: require a valid Bearer token; sets req.userId.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Not authenticated.' });
  req.userId = payload.sub;
  next();
}

// Guard: accounts need the database. If it's down, fail clearly (503) rather
// than hanging — guest play is unaffected because it never hits these routes.
function requireDB(req, res, next) {
  if (!isDBConnected()) {
    return res
      .status(503)
      .json({ error: 'Accounts are temporarily unavailable. Try again soon.' });
  }
  next();
}

// POST /api/auth/register
router.post('/register', requireDB, async (req, res) => {
  try {
    let { username, email, password } = req.body || {};
    username = (username || '').trim();
    email = (email || '').trim().toLowerCase();

    if (username.length < 3 || username.length > 20) {
      return res
        .status(400)
        .json({ error: 'Username must be 3–20 characters.' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email.' });
    }
    if (!password || password.length < 8) {
      return res
        .status(400)
        .json({ error: 'Password must be at least 8 characters.' });
    }

    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) {
      const field = existing.email === email ? 'email' : 'username';
      return res.status(409).json({ error: `That ${field} is already taken.` });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await User.create({ username, email, passwordHash });
    const token = signToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('[auth] register error:', err.message);
    res.status(500).json({ error: 'Could not create your account.' });
  }
});

// POST /api/auth/login
router.post('/login', requireDB, async (req, res) => {
  try {
    let { email, password } = req.body || {};
    email = (email || '').trim().toLowerCase();
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await User.findOne({ email });
    // Same generic message whether the email or the password is wrong, so we
    // don't leak which accounts exist.
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    res.status(500).json({ error: 'Could not log you in.' });
  }
});

// GET /api/auth/me — used on app load to restore a session from a stored token.
router.get('/me', requireDB, requireAuth, async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: publicUser(user) });
});

module.exports = { router };
