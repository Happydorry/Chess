const mongoose = require('mongoose');

// One finished game, saved for the players' match history. Each side stores the
// account id (null for a guest), the display name, and the rating before/after
// (null when that side was a guest or the game was unrated).
const sideSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    name: { type: String, default: null },
    ratingBefore: { type: Number, default: null },
    ratingAfter: { type: Number, default: null },
  },
  { _id: false },
);

const gameSchema = new mongoose.Schema(
  {
    white: { type: sideSchema, required: true },
    black: { type: sideSchema, required: true },
    // 'white' | 'black' | null (null = draw).
    winner: { type: String, default: null },
    // How it ended: checkmate / resignation / timeout / abandonment / draw.
    reason: { type: String, default: null },
    // True only for account-vs-account games (the ones that moved ratings).
    rated: { type: Boolean, default: false },
    timeControl: {
      initialMs: { type: Number },
      incrementMs: { type: Number },
    },
    // Full move list in SAN, from the starting position — lets the game be
    // replayed move by move. Empty for games saved before this was tracked.
    moves: { type: [String], default: [] },
  },
  { timestamps: true },
);

// Fast "this user's recent games, newest first" lookups for either colour.
gameSchema.index({ 'white.userId': 1, createdAt: -1 });
gameSchema.index({ 'black.userId': 1, createdAt: -1 });

module.exports = mongoose.model('Game', gameSchema);
