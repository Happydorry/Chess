const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 20,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },
    // Lifetime record, updated at the end of every game.
    stats: {
      wins: { type: Number, default: 0 },
      losses: { type: Number, default: 0 },
      draws: { type: Number, default: 0 },
    },
    // Elo rating. Everyone starts at 1200; it only moves in account-vs-account
    // games (see the rating logic in server.js).
    rating: { type: Number, default: 1200 },
  },
  { timestamps: true },
);

module.exports = mongoose.model('User', userSchema);
