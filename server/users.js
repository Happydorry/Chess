const express = require('express');
const User = require('./models/User');
const Game = require('./models/Game');
const { requireDB } = require('./auth');

const router = express.Router();

const HISTORY_LIMIT = 20; // most recent games returned per profile

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

// GET /api/users/:username/games — that player's recent games, newest first,
// each flattened to *their* perspective (opponent, result, rating change).
router.get('/:username/games', requireDB, async (req, res) => {
  try {
    const username = (req.params.username || '').trim();
    if (!username) return res.status(400).json({ error: 'Username required.' });

    const user = await User.findOne({ username })
      .collation({ locale: 'en', strength: 2 })
      .exec();
    if (!user) return res.status(404).json({ error: 'Player not found.' });

    const id = user._id;
    const games = await Game.find({
      $or: [{ 'white.userId': id }, { 'black.userId': id }],
    })
      .sort({ createdAt: -1 })
      .limit(HISTORY_LIMIT)
      .lean()
      .exec();

    const history = games.map((g) => {
      const iAmWhite = String(g.white.userId) === String(id);
      const me = iAmWhite ? g.white : g.black;
      const opp = iAmWhite ? g.black : g.white;
      const myColor = iAmWhite ? 'white' : 'black';
      const result =
        g.winner == null ? 'draw' : g.winner === myColor ? 'win' : 'loss';
      const ratingDelta =
        me.ratingAfter != null && me.ratingBefore != null
          ? me.ratingAfter - me.ratingBefore
          : null;
      return {
        id: g._id,
        color: myColor,
        opponent: opp.name || 'Guest',
        result,
        reason: g.reason,
        rated: g.rated,
        ratingDelta,
        timeControl: g.timeControl,
        date: g.createdAt,
      };
    });

    res.json({ games: history });
  } catch (err) {
    console.error('[users] history error:', err.message);
    res.status(500).json({ error: 'Could not load match history.' });
  }
});

module.exports = { router };
