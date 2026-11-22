# Spotify Guessing Game: Spec

A web game for me and my friends (not for the app store). PC and mobile browsers. One device per player.

## Gameplay

1. Everyone logs in with their own Spotify account and joins the host's room (join code).
2. Host picks settings (below) and starts.
3. The app picks random songs from each player's chosen source and shuffles them into one game.
4. Per round, the host plays the song in an embedded Spotify player. Everyone guesses **whose song it is**.
5. The round ends when the 20s timer runs out or everyone has guessed. The app then reveals the owner and shows the scoreboard.
6. Scoring is Kahoot-style: a correct guess earns 1000 points scaled down linearly by response time (min 500 at the deadline). A wrong guess or no guess earns 0.
7. Streaks (display only, never change scoring): a player's streak is the number of correct guesses in a row. A wrong guess or no guess resets it to 0. A round on the player's own song, and rounds a non-playing host sits out, leave it unchanged. It is shown as a fire emoji and the number next to the name from a streak of 2.
8. After the answer is revealed everyone sees a Spotify player for the revealed song (instead of its title as text) with the player's normal controls; the host also gets pause/resume and a seek bar while the song plays (the round timer does not pause).
7. After the last song, the final scoreboard is shown.

## Host settings

- Song source: recents or liked songs (applies to all players).
- Songs per person (default 4, 1 to 25): every participant is dealt this many of their own songs (capped to what the smallest library allows, so everyone gets the same number).
- Removals (default 1, 0 up to songs per person minus 1): each player must end up contributing `songs per person - removals` songs (default 4 - 1 = 3). They choose which to remove while reviewing; if they remove fewer, random extra songs of theirs are dropped when the game starts, so everyone always contributes the same number. Removed songs are not replaced. While reviewing, each of a player's own songs is shown as a slim Spotify player so they can listen before removing.
- Host also plays: toggle (default on). If off, the host only controls the game and does not guess or contribute songs.

## Roles and devices

- Max 8 players per room.
- Host can be PC or mobile.
- Playback uses Spotify's iFrame Embed API in the host's browser. It plays the full track if the host's browser is logged into Spotify, otherwise a 30s preview. No Premium is required. Mobile browsers block autoplay, so the host taps Play each round (this also acts as "start the 20s timer").

## Architecture

- One Node server serving the web app plus a WebSocket channel. Game state is held in memory (per room). No database.
- Spotify login: Authorization Code with PKCE. The server fetches the player's song pool once (on source selection) and then discards the token. Only track id, title, artist and owner are kept.
- Fetching: recents returns at most 50 tracks. Liked songs are paged, and a random sample is taken. Duplicate tracks are removed, and the picks are capped to what a player actually has.
- The server is the authority on timing and scoring. Clients only render.
- Latency fairness: the server measures each player's round-trip time (RTT) from its own websocket pings (lowest of the last 5 samples, replies it did not ask for are ignored) and caps it at 1000 ms. A guess's elapsed time is `arrival - roundStart - rtt`, never below 0, and it is accepted while that is within the 20 s round. The round therefore stays open for a fixed 1100 ms after the nominal deadline whenever at least one connected human guesser exists (0 extra otherwise), so in-flight guesses are not lost even from players who connected after Play; it still ends immediately once everyone has guessed. All round timing uses a monotonic clock, never the wall clock, because the wall clock steps (WSL2, NTP) and would reject or over-reward guesses. The countdown shown to players is computed from the time remaining as sent by the server, never from the client's wall clock. Known limit: a player who deliberately delays their ping replies can claim up to the 1 s cap.
- The song's owner is told so (and only the owner), and sees "sit this round out" instead of guess buttons. Rejected guesses say why (time is up, already locked in, your own song, not guessing this round).
- Hosting: runs as a Docker container and is exposed over HTTPS with a Cloudflare Tunnel (`https://guesssong.mang0.uk`, redirect URI `https://guesssong.mang0.uk/callback`). Config comes from env vars (`SPOTIFY_CLIENT_ID`, `PUBLIC_URL`, `PORT` default 3000), never baked into the image.
- Release: pushing a git tag (`v*`) builds the image and pushes it to GitHub Container Registry (`ghcr.io/<owner>/guesssong`) through GitHub Actions. The image is only built if the test workflow passes for that tag.
- CI: a test workflow (`npm ci && npm test`) runs on every push to `main` and on pull requests, and is reused by the release workflow. Blocking merges on a failing check needs branch protection on `main` (a GitHub repo setting, done by hand).

## Constraints

- Low RAM use (WSL crashes if it fills): in-memory state only, no heavy dependencies, and rooms are deleted on game end.
- The Spotify app stays in development mode. Spotify allows only 25 users, and each friend must be added to the user allowlist in the Spotify developer dashboard by hand (their Spotify account email).

## Non-goals

- App store release, accounts or persistence, game history.
- Playback on non-host devices, Spotify Connect control, or the Web Playback SDK.
- Surviving a server restart (a restart ends the game).
- Reconnection handling beyond rejoining the same room with the same code.
- Cheating prevention beyond the server-side timing.

## Failure modes considered

- **Host's browser not logged into Spotify:** the embed falls back to a 30s preview. This is fine because the round lasts 20s. Minor.
- **A friend isn't on the allowlist:** their login fails. Setup step, documented above. Minor.
- **A player has too few songs:** the game uses what they have and equal-split is reduced to the smallest pool. Minor.
- **PC off or tunnel down:** no game. Accepted.

## Testing

- Unit tests for scoring, the song split and sampling, and the round state machine.
- A manual end-to-end test with two browsers (one PC, one phone) against the real Spotify login.
