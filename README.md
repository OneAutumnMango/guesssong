# Guess the Song

A small web game for friends. Each player logs in with Spotify, and the game picks songs from everyone's recent or liked tracks.
Each round one song plays and everyone guesses whose it is, within 20 seconds.
Faster correct guesses score more. Works in PC and mobile browsers, one device per player.

## Spotify setup

1. Create an app at <https://developer.spotify.com/dashboard>. Choose only **Web API**.
2. Add the redirect URI exactly: `https://guesssong.mang0.uk/callback` (no trailing slash; it is `<PUBLIC_URL>/callback`).
3. The app starts in development mode: only allowlisted accounts can log in, max 25. Add each friend's Spotify account email under **User Management**.
4. Only the **client ID** is needed (PKCE login). There is no client secret.

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `SPOTIFY_CLIENT_ID` | yes | | Client ID of your Spotify app |
| `PUBLIC_URL` | yes | | Public https URL, e.g. `https://guesssong.mang0.uk` |
| `PORT` | no | `3000` | Port to listen on |

The server exits with an error if the first two are missing.

## Run locally

```sh
npm install
export SPOTIFY_CLIENT_ID=...
export PUBLIC_URL=https://guesssong.mang0.uk
npm start
```

`npm start` is plain `node src/server.js` and reads env vars only. Node 18 has no `--env-file`; on Node 20.6+ you can run `node --env-file=.env src/server.js` instead.

## Local testing

Dev mode lets you play a whole game alone with your own Spotify account. The host can add "test players" in the lobby; they borrow songs from your library and guess randomly.

```sh
npm run dev      # or: bash scripts/dev.sh
```

- Open http://127.0.0.1:3000 (not `localhost`).
- Add `http://127.0.0.1:3000/callback` as a redirect URI in the Spotify app. Spotify allows plain http for the `127.0.0.1` loopback literal, but not for `localhost`.
- `scripts/dev.sh` loads your env file if present, sets `PUBLIC_URL` to `http://127.0.0.1:${PORT:-3000}` and `DEV_MODE=1`.
- In the lobby the host can add and remove test players (up to 8 players in total). Test players take their songs from your own library and guess randomly 2-15 seconds after Play.
- The server refuses to start with `DEV_MODE=1` on any public URL, and the Docker image never sets it.
- Testing the audio embed on a phone needs a tunnel and is out of scope for dev mode.

## Run with Docker

```sh
docker run -p 3000:3000 \
  -e SPOTIFY_CLIENT_ID=... -e PUBLIC_URL=https://guesssong.mang0.uk \
  ghcr.io/<owner>/guesssong:latest
```

Replace `<owner>` with the GitHub user or org that publishes the image.

## HTTPS with a Cloudflare Tunnel

Spotify requires https for the redirect URI. Quick test (the URL is random, so set `PUBLIC_URL` and the Spotify redirect URI to it):

```sh
cloudflared tunnel --url http://localhost:3000
```

Permanent: create a named tunnel and route `guesssong.mang0.uk` to `http://localhost:3000`
(`cloudflared tunnel route dns <tunnel> guesssong.mang0.uk`, with `service: http://localhost:3000` in the tunnel config).

## How to play

1. One person creates a room and shares the 4-letter room code. Everyone logs in with Spotify and joins.
2. The host sets: song source (recents or liked), total songs (1-100), removals per player (0-20), and whether the host plays (guesses) too.
3. Start the game. Players may remove some of their own songs (up to the removal limit, not replaced) and then ready up.
4. Each round lasts 20 seconds. The host's device plays the song; everyone else guesses whose it is. The song's owner does not guess their own song.
5. A correct guess scores 1000 down to 500 by speed; wrong or no guess scores 0. After each round you see the reveal and scoreboard.

Songs per player = min(floor(total / players), smallest player pool).

## Releasing

Pushes to `main` and pull requests run the tests. Pushing a `v*` git tag runs the tests first and publishes the image to ghcr.io only if they pass.

```sh
git tag v0.1.0 && git push origin v0.1.0
```

To also block merging on failing tests, enable branch protection on `main` and require the `Test / test` status check. This is a GitHub repo setting and cannot be done from the repo files.

## Tests

```sh
npm test
```

## Known limits

- State is in memory only. A server restart ends all games.
- Max 8 players per room.
- Liked songs are sampled from up to 5 random pages of 50. Recents is at most 50 tracks.
- The host's embed shows the song title to the host.
- The Spotify embed plays the full track only if the host's browser is logged in to Spotify; otherwise a 30 s preview.

## Manual test checklist

Not automated; run with a PC host and a phone player, both on allowlisted accounts.

- [ ] Lobby, settings, start, remove a song, ready.
- [ ] Host taps Play on a phone and audio starts. Also test a phone as host, and iOS Safari if available.
- [ ] Guess, reveal and scoreboard are correct, and faster guesses score higher.
- [ ] Reload a player's page mid-game and the state restores.
- [ ] The node process stays well under 100 MB in `top`/`ps`.
