const jwt = require('jsonwebtoken');

// In production JWT_SECRET MUST be set (see server/.env.example). The dev
// fallback keeps local runs working but is intentionally insecure.
const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const JWT_EXPIRES_IN = '7d';

if (!process.env.JWT_SECRET) {
  console.warn(
    '[auth] JWT_SECRET not set — using an insecure dev secret. Set JWT_SECRET in production.',
  );
}

// Token payload: `sub` = user id, plus username for convenience (e.g. sockets
// can show who you are without a DB round-trip).
function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

// Returns the decoded payload, or null if the token is missing/invalid/expired.
function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

module.exports = { signToken, verifyToken };
