const express = require('express');
const mongoose = require('mongoose');
const Game = require('./models/Game');
const { requireDB } = require('./auth');

const router = express.Router();

// Public shape of a single game — enough to replay it move by move.
function publicGame(g) {
  const side = (s) => ({
    name: s?.name ?? null,
    rating: s?.ratingAfter ?? s?.ratingBefore ?? null,
  });
  return {
    id: g._id,
    white: side(g.white),
    black: side(g.black),
    winner: g.winner ?? null,
    reason: g.reason ?? null,
    rated: g.rated,
    timeControl: g.timeControl,
    moves: g.moves ?? [],
    date: g.createdAt,
  };
}

// GET /api/games/:id — one finished game, including its move list, so anyone
// can replay it.
router.get('/:id', requireDB, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid game id.' });
    }

    const game = await Game.findById(id).lean().exec();
    if (!game) return res.status(404).json({ error: 'Game not found.' });

    res.json({ game: publicGame(game) });
  } catch (err) {
    console.error('[games] fetch error:', err.message);
    res.status(500).json({ error: 'Could not load that game.' });
  }
});

module.exports = { router };
