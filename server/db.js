const mongoose = require('mongoose');

let connected = false;

// Connect to MongoDB if a connection string is configured. This is intentionally
// non-fatal: accounts are an *optional* layer on top of guest play, so if the DB
// is unreachable (or MONGO_URI isn't set), the server still boots and people can
// keep playing as guests — only the /api/auth endpoints go unavailable.
async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.warn(
      '[db] MONGO_URI not set — accounts/auth disabled; guest play still works.',
    );
    return false;
  }

  try {
    await mongoose.connect(uri);
    connected = true;
    console.log('[db] connected to MongoDB');
  } catch (err) {
    console.error('[db] connection failed:', err.message);
    connected = false;
  }

  // Keep our flag in sync if the connection later drops or recovers.
  mongoose.connection.on('disconnected', () => {
    connected = false;
    console.warn('[db] disconnected');
  });
  mongoose.connection.on('connected', () => {
    connected = true;
  });

  return connected;
}

const isDBConnected = () =>
  connected && mongoose.connection.readyState === 1;

module.exports = { connectDB, isDBConnected };
