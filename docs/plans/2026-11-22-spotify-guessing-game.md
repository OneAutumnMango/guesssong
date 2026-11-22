# Spotify Guessing Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-optimized:subagent-driven-development (recommended) or superpowers-optimized:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A multiplayer web game where players guess whose Spotify song is playing, scored by correctness and speed.
**Architecture:** One Node process serves static files, Spotify OAuth (PKCE) routes and a WebSocket. All game state lives in memory per room. A pure `Game` class owns the rules, and the server only wires sockets and timers to it. The host's browser plays songs through the Spotify iFrame Embed.
**Tech Stack:** Node >= 20 (ES modules, built-in `fetch`, `node:test`), one dependency (`ws`), vanilla HTML/JS/CSS with no build step.
**Spec:** `docs/specs/2026-11-22-spotify-guessing-game-design.md`
**Assumptions:**
- Assumes the Spotify app stays in development mode with every friend allowlisted. Login will NOT work for anyone else.
- Assumes a player's Spotify token is held in memory from login until the game starts, then deleted. This is a refinement of the spec's "fetch once, then discard", because the song source is chosen after players join.
- Assumes liked songs are sampled from up to 5 random pages of 50. This is a bounded approximation, not a uniform sample of the whole library.
- Assumes one room per code, 8 players max, and the host is always logged in. The "host plays" toggle only controls whether the host contributes songs and guesses.
- Assumes a song's owner does not guess on their own song and scores 0 that round.
- Assumes the iFrame Embed can play after a host tap on mobile. This is unverified on iOS Safari (Task 6 tests it).

## Global Constraints

- Web app only, PC and mobile browsers, one device per player.
- Max 8 players per room. Round timer 20s. Defaults: 12 songs, song source `recents` or `liked`.
- Songs per player = `min(floor(total / playerCount), smallest pool size)`. Removed songs are NOT replaced.
- Score for a correct guess = `round(1000 - 500 * min(elapsed / 20000, 1))`. Wrong or no guess = 0.
- A round ends when the timer runs out or every eligible guesser has guessed. After each round, show the reveal and scoreboard.
- Spotify scopes: `user-library-read user-read-recently-played`. Recents returns at most 50 tracks.
- Server is authoritative for timing. Guesses after the deadline are ignored.
- Low RAM: in-memory state only, no database, delete a room when its game ends.
- Must run as a Docker container, configured only by env vars. No secrets or `.env` inside the image.
- Pushing a git tag matching `v*` builds the image and pushes it to `ghcr.io` via GitHub Actions.

## Review Focus

- A player with an empty pool (no recents or likes): the game doesn't start, and the host sees an error naming that player (Task 3, 4).
- The same track appears in two players' pools: it is assigned to only one player (Task 1).
- Duplicate guess, guess after the deadline, or the owner guessing their own song: ignored, with the first valid guess kept (Task 3).
- A friend not on the Spotify allowlist gets a 403: the login page shows a readable message instead of crashing (Task 2, 4).
- A player disconnects and reopens the page with the same key: they get their state back, and the round timer is unaffected (Task 4).

## File Structure

- `package.json`: module type, `ws` dep, `npm test` = `node --test`.
- `src/logic.js`: pure helpers (scoring, split, track picking).
- `src/spotify.js`: PKCE, token exchange, profile, song pool fetching.
- `src/game.js`: `Game` class, the room state machine.
- `src/server.js`: HTTP (static, `/login`, `/callback`), WebSocket, round timers, room registry.
- `public/index.html`, `public/play.html`, `public/app.js`, `public/style.css`: client.
- `test/*.test.js`: one file per `src` module, plus `test/integration.test.js`.
- `README.md`: setup (Spotify dashboard, allowlist, tunnel).

---

### Task 1: Scaffold and pure logic

**Files:**
- Create: `package.json`, `src/logic.js`, `test/logic.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type Track = { id: string, uri: string, title: string, artist: string }`
  - `scoreFor(correct: boolean, elapsedMs: number, durationMs?: number = 20000): number`
  - `perPlayerCount(total: number, playerCount: number, poolSizes: number[]): number`
  - `pickTracks(pools: Record<string, Track[]>, perPlayer: number, rng?: () => number = Math.random): Record<string, Track[]>`

**Security flag:** `none`
**Does NOT cover:** nothing beyond the three functions above.

- [x] **Step 1: Write failing tests** in `test/logic.test.js`
  - `scoreFor(true, 0) === 1000`, `scoreFor(true, 10000) === 750`, `scoreFor(true, 20000) === 500`, `scoreFor(true, 99999) === 500`, `scoreFor(false, 0) === 0`
  - `perPlayerCount(12, 3, [50, 50, 50]) === 4`, `perPlayerCount(12, 5, [50,50,50,50,50]) === 2`, `perPlayerCount(12, 3, [50, 2, 50]) === 2`, `perPlayerCount(12, 3, [50, 0, 50]) === 0`
  - `pickTracks`: each player gets exactly `perPlayer` tracks, all from their own pool, and no track id is repeated across players even when two pools share a track.
  - `pickTracks` with a pool smaller than `perPlayer` (after de-duplication) returns the shorter list for that player and does not throw.
- [x] **Step 2:** Run `npm test`. Expected: FAIL (module not found).
- [x] **Step 3: Implement** the three functions in `src/logic.js`. Create `package.json` (`"type": "module"`, `"scripts": {"test": "node --test"}`, dependency `ws`), then run `npm install`. For `pickTracks`, shuffle each pool with `rng` (Fisher-Yates), then take tracks per player in order, skipping any id already taken.
- [x] **Step 4:** Run `npm test`. Expected: PASS.
- [x] **Step 5: Commit** `git add package.json package-lock.json src/logic.js test/logic.test.js .gitignore && git commit -m "Add scoring, split and pick logic"` (confirm `.gitignore` contains `node_modules`).

---

### Task 2: Spotify client

**Files:**
- Create: `src/spotify.js`, `test/spotify.test.js`

**Interfaces:**
- Consumes: `Track` from Task 1.
- Produces:
  - `class SpotifyError extends Error { status: number }`
  - `makePkce(): { verifier: string, challenge: string }` (S256, base64url)
  - `authUrl(o: { clientId: string, redirectUri: string, state: string, challenge: string }): string`
  - `exchangeCode(o: { clientId: string, redirectUri: string, code: string, verifier: string }, fetchFn?: typeof fetch): Promise<string>` (access token)
  - `fetchProfile(token: string, fetchFn?): Promise<{ id: string, name: string }>` (name = `display_name`, falling back to `id`)
  - `fetchPool(token: string, source: 'recents' | 'liked', fetchFn?, rng?: () => number): Promise<Track[]>`

**Security flag:** `security`
**Does NOT cover:** refreshing expired tokens (a token lasts 1h, longer than a game lobby), and a true uniform sample of liked songs (see Assumptions).

- [x] **Step 1: Write failing tests** with a fake `fetchFn`
  - `makePkce()`: `challenge` equals base64url(SHA-256(`verifier`)), and `verifier` is 43+ characters.
  - `authUrl(...)` contains `code_challenge_method=S256`, the `state`, and both scopes.
  - `exchangeCode` POSTs form-encoded `grant_type=authorization_code`, `code_verifier` and no client secret to `https://accounts.spotify.com/api/token`, and returns `access_token`.
  - `fetchPool(t, 'recents', ...)` calls `/v1/me/player/recently-played?limit=50` and maps items to `Track` (`uri` = `spotify:track:<id>`).
  - `fetchPool(t, 'liked', ...)` with `total: 400` first calls `/v1/me/tracks?limit=1`, then fetches at most 5 distinct random 50-item pages, and returns the union.
  - A 403 response makes `exchangeCode`/`fetchProfile`/`fetchPool` throw `SpotifyError` with `status 403`.
- [x] **Step 2:** Run `npm test`. Expected: FAIL.
- [x] **Step 3: Implement** in `src/spotify.js` using global `fetch` (injectable via the `fetchFn` parameter) and `node:crypto`. Throw `SpotifyError(response.status, <body text>)` on any non-2xx response. Liked page offsets are chosen from `ceil(total / 50)` pages without repeats.
- [x] **Step 4:** Run `npm test`. Expected: PASS.
- [x] **Step 5: Commit** `git add src/spotify.js test/spotify.test.js && git commit -m "Add Spotify client"`

---

### Task 3: Game state machine

**Files:**
- Create: `src/game.js`, `test/game.test.js`

**Interfaces:**
- Consumes: `Track`, `scoreFor`, `perPlayerCount`, `pickTracks` from Task 1.
- Produces: `class Game` with
  - `constructor(o?: { now?: () => number, rng?: () => number, durationMs?: number })`
  - `phase: 'lobby' | 'review' | 'between' | 'playing' | 'reveal' | 'finished'`
  - `settings: { source: 'recents' | 'liked', total: number, buffer: number, hostPlays: boolean }` (defaults `recents`, 12, 2, true)
  - `hostId: string | null`, `deadline: number | null`
  - `addPlayer(id: string, name: string, isHost?: boolean): void`: throws when the room already has 8 players, and throws once `phase !== 'lobby'`.
  - `setConnected(id: string, connected: boolean): void`
  - `configure(s: Partial<Settings>): void`: lobby only.
  - `participants(): string[]`: player ids that contribute songs (everyone, minus the host when `hostPlays` is false).
  - `start(pools: Record<string, Track[]>): void`: throws `Error('<name> has no songs')` when any participant's pool is empty, and throws with fewer than 2 participants. Picks songs and enters `review`.
  - `removeTrack(playerId: string, trackId: string): void`: review only, throws after `settings.buffer` removals.
  - `setReady(playerId: string): boolean`: true when all participants are ready. The phase then becomes `between`, with a shuffled queue of the remaining tracks and `round = 0`. If every track was removed, throw.
  - `beginRound(): void`: `between` → `playing`, with `deadline = now() + durationMs`.
  - `guess(playerId: string, guessedId: string): boolean`: true if accepted. Rejected when the phase isn't `playing`, the deadline has passed, the player already guessed, the player is the song's owner, or the player isn't a guesser (the host with `hostPlays` false).
  - `allGuessed(): boolean`
  - `endRound(): void`: `playing` → `reveal`, scoring each guess with `scoreFor(guessedId === owner, guessTime - roundStart, durationMs)`.
  - `next(): void`: `reveal` → `between`, or `finished` after the last song.
  - `view(playerId: string): object` (the per-player JSON the server sends):
    `{ phase, hostId, you: playerId, settings, players: [{id, name, connected, score, ready}], myTracks?: Track[] (review only), removalsLeft?: number (review only), round?: { index, total, deadline, guessedCount }, myGuess?: string, reveal?: { ownerId, track: Track, deltas: Record<string, number> } (reveal only), nextUri?: string (host only, between/playing/reveal: the current or upcoming track's `uri`) }`. While `playing`, the owner is NOT included anywhere.

**Security flag:** `none`
**Does NOT cover:** reconnect timeouts, host migration if the host never returns, or replacement of removed songs (spec says none).

- [x] **Step 1: Write failing tests** (fake `now`, deterministic `rng`)
  - Adding a 9th player throws.
  - `start` with pools `{a: 50 tracks, b: 50 tracks}`, total 12 gives each player 6 tracks, and `phase === 'review'`.
  - `start` with `b: []` throws `'<b's name> has no songs'`.
  - `start` with `hostPlays: false` ignores the host's pool, and the host's `view` has no `myTracks`.
  - `removeTrack` ×3 with `buffer: 2` throws on the third. After 2 removals the game plays 10 songs from 12.
  - `setReady` by every participant returns true and the phase becomes `between`.
  - Round flow with 2 players: after `beginRound`, `guess` at 5000 ms by the non-owner, with the right owner, is accepted. `endRound` yields `deltas[guesser] === 875`. The owner's delta is 0.
  - `guess` rejected for: a duplicate, after the deadline, by the owner, and when `phase !== 'playing'`.
  - `allGuessed()` is true once every non-owner guesser has guessed.
  - `view(x).reveal` is undefined while `playing`, and `view` never contains `ownerId` before `reveal`.
  - `next()` after the last round gives `phase === 'finished'`.
- [x] **Step 2:** Run `npm test`. Expected: FAIL.
- [x] **Step 3: Implement** `Game` in `src/game.js`, with no I/O and no timers. Keep each guess's elapsed time at `now() - roundStart`.
- [x] **Step 4:** Run `npm test`. Expected: PASS.
- [x] **Step 5: Commit** `git add src/game.js test/game.test.js && git commit -m "Add game state machine"`

---

### Task 4: Server (HTTP, OAuth, WebSocket, timers)

**Files:**
- Create: `src/server.js`, `test/integration.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1-3 (`Game`, `makePkce`, `authUrl`, `exchangeCode`, `fetchProfile`, `fetchPool`, `SpotifyError`).
- Produces:
  - `createServer(o: { clientId: string, publicUrl: string, spotify?: { exchangeCode, fetchProfile, fetchPool }, durationMs?: number }): http.Server` with `server.listen(port)` usable by tests. `spotify` defaults to the real module, and the test injects stubs.
  - HTTP: `GET /login?room=new|<CODE>`: creates a PKCE state, redirects to `authUrl`. `GET /callback?code&state`: exchanges the code, fetches the profile, creates or joins the room (a 4-letter code, uppercase) and a random `key`, and redirects to `/play.html#key=<key>`. On a `SpotifyError`, or if the room is full or not in the lobby, responds with a readable HTML page (403 → "Your Spotify account isn't on the allowlist; ask the host to add it."). Everything else is served from `public/` (reject path traversal).
  - WebSocket protocol, JSON. Client→server: `{type:'hello', key}`, `{type:'settings', settings}`, `{type:'start'}`, `{type:'remove', trackId}`, `{type:'ready'}`, `{type:'play'}`, `{type:'guess', playerId}`, `{type:'next'}`. Server→client: `{type:'state', view}` (the result of `game.view(playerId)`, sent to each player after every change) and `{type:'error', message}`.

**Security flag:** `security`
**Does NOT cover:** persistence across restarts, rate limiting, and HTTPS (terminated by the Cloudflare Tunnel).

- [ ] **Step 1: Write failing integration test** `test/integration.test.js`: start `createServer` on an ephemeral port with stub `spotify` functions (pools of 20 distinct tracks per player) and `durationMs: 300`. Using the real `ws` client:
  - Host `/callback` creates room `X`; a second player joins with `/login?room=X`. Both then say `hello` with their `key` and receive a `state` in the `lobby` phase.
  - Non-host `start` / `settings` / `next` / `play` messages are rejected with an `error`.
  - Host `settings {total: 4, buffer: 1}`, `start`, then each player removes ≤ 1 track and sends `ready`. The phase becomes `between`.
  - Host `play`: the non-owner's `guess` is accepted. When all have guessed, the round moves to `reveal` before the 300 ms timer fires.
  - A round where nobody guesses moves to `reveal` after about 300 ms.
  - Stub `fetchPool` returning `[]` for one player makes `start` send the host an `error` naming that player, and the phase stays `lobby`.
  - A stub `exchangeCode` throwing `SpotifyError(403)` makes `/callback` return a page containing "allowlist".
  - A second socket for an existing `key` gets the current `state` (reconnect).
  - After the `finished` phase the room is removed (a `/login?room=<CODE>` for that code then fails).
  - A `/../` path request does not read files outside `public/`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `createServer` in `src/server.js` using `node:http` and `ws`. Keep these structures in memory: `pending: Map<state, {verifier, room, createdAt}>` (swept after 10 minutes), `rooms: Map<code, {game, players: Map<key, {id, token, socket}>, timer}>`. Only the host can send `settings`, `start`, `play`, `next`. On `start`, call `fetchPool(token, settings.source)` for each participant, run `game.start(pools)`, and delete every stored `token`. On `play`, call `beginRound()` and set a `setTimeout` for `durationMs` to `endRound()`. Also call `endRound()` and clear the timer as soon as `allGuessed()` is true. Broadcast the state after each change. Delete the room when `phase` becomes `finished` and the clients have been sent the final state.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/server.js test/integration.test.js && git commit -m "Add server with OAuth and websocket game flow"`

---

### Task 5: Client UI

**Files:**
- Create: `public/index.html`, `public/play.html`, `public/app.js`, `public/style.css`

**Interfaces:**
- Consumes: the Task 4 WebSocket protocol and the `view` JSON shape from Task 3.
- Produces: nothing

**Security flag:** `none`
**Does NOT cover:** automated browser tests (verified by hand in Task 6), offline use.

- [ ] **Step 1: `index.html`**: two actions, "Create room" (→ `/login?room=new`) and "Join" (a code field → `/login?room=<CODE>`).
- [ ] **Step 2: `play.html` + `app.js`**: read `key` from the URL hash and store it in `sessionStorage` so a reload reconnects. Open the WebSocket, send `hello`, then re-render on every `state`. Show errors from `{type:'error'}` in a banner. One render function per phase:
  - `lobby`: room code, player list, and for the host the settings form (source, total, buffer, host-plays) and a Start button.
  - `review`: the player's own songs, each with a Remove button until `removalsLeft` is 0, then a Ready button.
  - `between`: the host sees a large Play button, and others see "Get ready".
  - `playing`: for guessers, one large button per other player (tap targets ≥ 48px), with a visible countdown from `deadline`. After guessing, show "Locked in". The host sees the embed.
  - `reveal`: the owner and song title/artist, this round's points, and the scoreboard. The host also sees a Next button.
  - `finished`: the final scoreboard.
- [ ] **Step 3: Host playback.** The host's page loads `https://open.spotify.com/embed/iframe-api/v1` and creates one `IFrameAPI` controller. Whenever `nextUri` changes, call `controller.loadUri(nextUri)`. The Play button's click handler calls `controller.play()` and then sends `{type:'play'}` (it must be the same user-gesture handler, so mobile browsers allow audio).
- [ ] **Step 4: `style.css`**: mobile-first, single column, readable at 360px width, no horizontal scroll, and light/dark via `prefers-color-scheme`. Use `textContent` (never `innerHTML`) for any player-supplied text such as names and song titles.
- [ ] **Step 5: Commit** `git add public && git commit -m "Add client UI"`

---

### Task 6: README and manual end-to-end check

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: the running server (`node src/server.js` reads `SPOTIFY_CLIENT_ID`, `PUBLIC_URL`, `PORT` (default 3000)).
- Produces: nothing

**Security flag:** `none`

- [ ] **Step 1: Add a `src/main.js`** (or an `if main` block in `server.js`) that reads those env vars and calls `createServer(...).listen(PORT)`, and a `"start"` script in `package.json`. It exits with a clear message if `SPOTIFY_CLIENT_ID` or `PUBLIC_URL` is missing.
- [ ] **Step 2: Write `README.md`** with these steps:
  1. Create a Spotify app and add `<PUBLIC_URL>/callback` as the redirect URI.
  2. Add each friend's Spotify email under User Management (development mode, 25 user cap).
  3. Run `cloudflared tunnel --url http://localhost:3000`, then `SPOTIFY_CLIENT_ID=... PUBLIC_URL=https://<tunnel>.trycloudflare.com npm start`.
  4. Share the room code.
- [ ] **Step 3: Manual check, two real devices** (PC host + phone player, both on allowlisted accounts):
  - Lobby → settings → start → remove a song → ready.
  - Host taps Play on the phone and audio starts. Test the phone as host as well, including iOS Safari if available. This verifies the embed Assumption.
  - Guess, reveal and scoreboard are correct, and scoring is faster-higher.
  - Reload the player's page mid-game and the state restores.
  - Watch `ps`/`top` during the game: the node process stays well under 100 MB.
  - Record any failures as issues. If the embed can't play on a phone-host, report it to the user before continuing.
- [ ] **Step 4: Commit** `git add README.md package.json src && git commit -m "Add start script and README"`

---

### Task 7: Docker image and release workflow

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `npm start` / `src/main.js` from Task 6, which reads `SPOTIFY_CLIENT_ID`, `PUBLIC_URL`, `PORT` from the environment.
- Produces: image `ghcr.io/<owner>/guesssong:<tag>` (and `latest`).

**Security flag:** `none`
**Does NOT cover:** multi-arch builds (linux/amd64 only, add arm64 if the host is ARM), image signing, and deploy/restart automation.

- [ ] **Step 1: `.dockerignore`** lists `node_modules`, `.env`, `.git`, `docs`, `test`.
- [ ] **Step 2: `Dockerfile`**: `FROM node:22-alpine`, `WORKDIR /app`, copy `package*.json`, `RUN npm ci --omit=dev`, copy `src` and `public`, `ENV PORT=3000`, `EXPOSE 3000`, `USER node`, `CMD ["node", "src/main.js"]` (it must NOT use `--env-file`, since there is no `.env` in the image).
- [ ] **Step 3: `.github/workflows/release.yml`**: trigger `on: push: tags: ['v*']`; permissions `contents: read`, `packages: write`; steps: `actions/checkout`, `docker/login-action` (registry `ghcr.io`, username `${{ github.actor }}`, password `${{ secrets.GITHUB_TOKEN }}`), `docker/metadata-action` (images `ghcr.io/${{ github.repository }}`, tags from the git tag plus `latest`), `docker/build-push-action` (`push: true`). The image name must be lowercase.
- [ ] **Step 4: Verify locally**: `docker build -t guesssong .`, then `docker run --rm -p 3000:3000 -e SPOTIFY_CLIENT_ID=x -e PUBLIC_URL=http://localhost:3000 guesssong`. Expected: `curl -s localhost:3000/` returns the index page, and `docker image ls guesssong` shows a small image. Also run it with no env vars. Expected: exits with the missing-variable message.
- [ ] **Step 5: Verify release**: push a tag (`git tag v0.1.0 && git push origin v0.1.0`) once the repo is on GitHub. Expected: the Actions run succeeds and the package appears under the repo's Packages. (The user pushes this tag. Do not push without asking.)
- [ ] **Step 6: Commit** `git add Dockerfile .dockerignore .github && git commit -m "Add Docker image and ghcr release workflow"`
