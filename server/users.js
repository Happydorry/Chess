const express = require('express');
const User = require('./models/User');
const { requireDB } = require('./auth');

const router = express.Router();

// Public-facing shape of a profile — never includes email or anything private.
function publicProfile(user) {
  return {
    username: user.username,
    rating: user.rating,
    stats: {
      wins: user.stats.wins,
      losses: user.stats.losses,
      draws: user.stats.draws,
    },
    joined: user.createdAt,
  };
}

// GET /api/users/:username — anyone (including guests) can view a player's
// public profile. Lookup is case-insensitive so "alice" finds "Alice".
router.get('/:username', requireDB, async (req, res) => {
  try {
    const username = (req.params.username || '').trim();
    if (!username) return res.status(400).json({ error: 'Username required.' });

    const user = await User.findOne({ username })
      .collation({ locale: 'en', strength: 2 })
      .exec();

    if (!user) return res.status(404).json({ error: 'Player not found.' });
    res.json({ profile: publicProfile(user) });
  } catch (err) {
    console.error('[users] profile error:', err.message);
    res.status(500).json({ error: 'Could not load that profile.' });
  }
});

module.exports = { router };
