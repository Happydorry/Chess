# TODO

## Player presence / leaving a game

Currently: a refresh keeps a player in their game (auto-rejoin via a stable
per-tab `playerId` + a 30s disconnect grace period). Rooms are in-memory, so a
server restart ends all active games. There is no auth/login yet.

Planned:

- [ ] **Logout / leave game** — explicit "leave" action. Client emits something
      like `leave_room`; server frees the seat and notifies the opponent.
- [ ] **Closing a tab = forfeit (loss)** — treat a real disconnect (after the
      grace window) as abandoning the game, awarding the win to the opponent.
- [ ] **Game result state** — track in-progress / white-wins / black-wins / draw
      on the server, so forfeit-on-disconnect and a real checkmate share one
      end-of-game path.
- [ ] **Refresh vs. deliberate close** — both currently look like a disconnect.
      For instant forfeit-on-close, emit a "leaving" signal on `beforeunload`
      (best-effort, not 100% reliable) and keep the grace timer as the fallback.
- [ ] **Grace period tuning** — `GRACE_MS` in `server/server.js` (currently 30s).

## Notes

- Hooks already in place to build on: the disconnect grace timer and the
  `opponent_left` event in `server/server.js`.
- For persistence across server restarts, the in-memory `rooms` store would need
  to move to something durable (e.g. Redis or a DB).

  /////////////////////////////////

-Your username is not shown to your opponent in a game
-Games are not saved to your account (no match history)
-Stats aren't tracked — there's a wins/losses/draws field on your user record, but it's always 0; nothing updates it after a game
-No rating/ELO, matchmaking, profiles, avatars, friends
-No password reset or email verification

- apponent matching
- scores
- when room is created how to stop it??
