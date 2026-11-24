import { scoreFor, perPlayerCount, pickTracks } from './logic.js';

const MAX_PLAYERS = 8;

export class Game {
  // now defaults to the monotonic clock: wall-clock steps must not change round timing
  constructor({ now = () => performance.now(), rng = Math.random, durationMs = 20000 } = {}) {
    this.now = now;
    this.rng = rng;
    this.durationMs = durationMs;
    this.phase = 'lobby';
    this.settings = { source: 'top', topRange: 'short_term', topLimit: 50, perPerson: 4, buffer: 1, hostPlays: true, timer: true };
    this.hostId = null;
    this.deadline = null;
    this.players = new Map(); // id -> { id, name, connected, score }
    this.round = 0;
    this.queue = [];
    this.tracks = {}; // review: playerId -> Track[]
    this.removals = {};
    this.effBuffer = 0; // removals allowed after capping to the pool
    this.keep = 0; // songs every participant ends with
    this.ready = new Set();
    this.guesses = new Map(); // playerId -> { id, elapsed }
    this.roundStart = null;
    this.pausedAt = null; // monotonic moment the round clock was paused, or null
    this.deltas = {};
  }

  addPlayer(id, name, isHost = false, bot = false) {
    if (this.phase !== 'lobby') throw new Error('Game already started');
    if (this.players.has(id)) throw new Error('Player already in room');
    if (this.players.size >= MAX_PLAYERS) throw new Error('Room is full');
    this.players.set(id, { id, name, connected: true, score: 0, streak: 0, bot });
    if (isHost) this.hostId = id;
  }

  removePlayer(id) {
    if (this.phase !== 'lobby') throw new Error('Game already started');
    this.players.delete(id);
  }

  setConnected(id, connected) {
    const p = this.players.get(id);
    if (p) p.connected = connected;
  }

  configure(s) {
    if (this.phase !== 'lobby') throw new Error('Settings are locked');
    const ok = {
      source: (v) => v === 'top' || v === 'recents' || v === 'liked',
      topRange: (v) => ['short_term', 'medium_term', 'long_term'].includes(v),
      topLimit: (v) => v === 10 || v === 25 || v === 50,
      perPerson: (v) => Number.isInteger(v) && v >= 1 && v <= 25,
      buffer: (v) => Number.isInteger(v) && v >= 0 && v <= 20,
      hostPlays: (v) => typeof v === 'boolean',
      timer: (v) => typeof v === 'boolean',
    };
    const next = {};
    for (const k of Object.keys(ok)) {
      if (!s || !(k in s)) continue;
      if (!ok[k](s[k])) throw new Error(`Invalid setting: ${k}`);
      next[k] = s[k];
    }
    const merged = { ...this.settings, ...next }; // validate the merged result so perPerson and buffer can change together
    if (merged.buffer >= merged.perPerson) throw new Error('Invalid setting: buffer');
    Object.assign(this.settings, next);
  }

  participants() {
    return [...this.players.keys()].filter((id) => this.settings.hostPlays || id !== this.hostId);
  }

  start(pools) {
    if (this.phase !== 'lobby') throw new Error('Game already started');
    const ids = this.participants();
    if (ids.length < 2) throw new Error('Need at least 2 players');
    const own = {};
    for (const id of ids) {
      if (!pools[id]?.length) throw new Error(`${this.players.get(id).name} has no songs`);
      own[id] = pools[id];
    }
    const per = perPlayerCount(this.settings.perPerson, ids.map((id) => own[id].length));
    const picked = pickTracks(own, per, this.rng);
    for (const id of ids) {
      if (!picked[id].length) throw new Error(`${this.players.get(id).name} has no songs`);
    }
    const least = Math.min(...ids.map((id) => picked[id].length)); // de-duplication can leave lists uneven
    for (const id of ids) {
      picked[id] = picked[id].slice(0, least);
      this.removals[id] = 0;
    }
    this.effBuffer = Math.min(this.settings.buffer, least - 1);
    this.keep = least - this.effBuffer; // everyone ends with exactly this many songs
    this.tracks = picked;
    this.phase = 'review';
  }

  removeTrack(playerId, trackId) {
    if (this.phase !== 'review') throw new Error('Not in review');
    const mine = this.tracks[playerId];
    if (!mine) throw new Error('Not a participant');
    if (this.removals[playerId] >= this.effBuffer) throw new Error('No removals left');
    const i = mine.findIndex((t) => t.id === trackId);
    if (i < 0) throw new Error('Unknown track');
    if (mine.length <= 1) throw new Error('Keep at least one song');
    mine.splice(i, 1);
    this.removals[playerId]++;
  }

  setReady(playerId) {
    if (this.phase !== 'review' || !this.tracks[playerId]) return false;
    this.ready.add(playerId);
    return this.checkReady();
  }

  // Disconnected participants do not block readiness; needs at least one connected, ready player.
  checkReady() {
    if (this.phase !== 'review') return false;
    const ids = this.participants();
    if (!ids.every((id) => this.ready.has(id) || !this.players.get(id).connected)) return false;
    const humans = ids.filter((id) => !this.players.get(id).bot); // test players must not start review on their own
    if (!(humans.length ? humans : ids).some((id) => this.ready.has(id) && this.players.get(id).connected)) return false;
    for (const id of this.participants()) { // mandatory removals: drop random extras down to `keep`
      const mine = this.tracks[id];
      while (mine.length > this.keep) mine.splice(Math.floor(this.rng() * mine.length), 1);
    }
    const q = Object.entries(this.tracks).flatMap(([ownerId, ts]) => ts.map((track) => ({ ownerId, track })));
    if (!q.length) throw new Error('No songs left');
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
    this.queue = q;
    this.round = 0;
    this.phase = 'between';
    return true;
  }

  beginRound() {
    if (this.phase !== 'between') throw new Error('Not between rounds');
    this.guesses.clear();
    this.deltas = {};
    this.roundStart = this.now();
    this.pausedAt = null;
    this.deadline = this.settings.timer ? this.roundStart + this.durationMs : null;
    this.phase = 'playing';
  }

  #timedRound() {
    if (this.phase !== 'playing') throw new Error('Not playing');
    if (!this.settings.timer) throw new Error('This round has no timer');
  }

  pauseRound() {
    this.#timedRound();
    if (this.pausedAt !== null) throw new Error('Already paused');
    if (this.now() - this.roundStart > this.durationMs) throw new Error('Time is up'); // no pausing inside the grace window
    this.pausedAt = this.now();
  }

  // Returns the time left on the nominal deadline so the caller can reschedule its end-of-round timer.
  resumeRound() {
    this.#timedRound();
    if (this.pausedAt === null) throw new Error('Not paused');
    const paused = this.now() - this.pausedAt;
    this.roundStart += paused;
    this.deadline += paused;
    this.pausedAt = null;
    return Math.max(0, this.deadline - this.now());
  }

  #guessers() {
    const owner = this.queue[this.round].ownerId;
    return [...this.players.keys()].filter(
      (id) => id !== owner && (this.settings.hostPlays || id !== this.hostId),
    );
  }

  // Returns why a guess would be rejected, or null. latencyMs is the guesser's measured RTT (clamped to 0..1000).
  guessProblem(playerId, latencyMs = 0) {
    if (this.phase !== 'playing') return 'Not accepting guesses right now';
    if (this.queue[this.round].ownerId === playerId) return 'This is your song, sit this round out';
    if (!this.#guessers().includes(playerId)) return 'You are not guessing this round';
    if (this.guesses.has(playerId)) return 'You already locked in a guess';
    return this.settings.timer && this.#elapsed(latencyMs) > this.durationMs ? 'Time is up' : null;
  }

  #elapsed(latencyMs) {
    const lat = Number.isFinite(latencyMs) ? Math.min(1000, Math.max(0, latencyMs)) : 0;
    return (this.pausedAt ?? this.now()) - this.roundStart - lat; // frozen while paused
  }

  guess(playerId, guessedId, latencyMs = 0) {
    if (this.guessProblem(playerId, latencyMs) !== null) return false;
    this.guesses.set(playerId, { id: guessedId, elapsed: Math.max(0, this.#elapsed(latencyMs)) });
    return true;
  }

  allGuessed() {
    return this.phase === 'playing' && this.#guessers().every((id) => this.guesses.has(id));
  }

  endRound() {
    if (this.phase !== 'playing') throw new Error('Not playing');
    const { ownerId } = this.queue[this.round];
    for (const id of this.players.keys()) this.deltas[id] = 0;
    for (const id of this.#guessers()) { // display-only streaks; owner and non-playing host are left unchanged
      const g = this.guesses.get(id);
      const p = this.players.get(id);
      p.streak = g && g.id === ownerId ? p.streak + 1 : 0;
    }
    for (const [id, g] of this.guesses) {
      const d = scoreFor(g.id === ownerId, g.elapsed, this.settings.timer ? this.durationMs : Infinity) // no timer: flat 1000;
      this.deltas[id] = d;
      this.players.get(id).score += d;
    }
    this.pausedAt = null;
    this.phase = 'reveal';
  }

  next() {
    if (this.phase !== 'reveal') throw new Error('Not in reveal');
    this.round++;
    this.deadline = null;
    this.phase = this.round >= this.queue.length ? 'finished' : 'between';
  }

  view(playerId) {
    const v = {
      phase: this.phase,
      hostId: this.hostId,
      you: playerId,
      settings: { ...this.settings },
      players: [...this.players.values()].map((p) => ({ ...p, ready: this.ready.has(p.id) })),
    };
    if (this.phase === 'review' && this.tracks[playerId]) {
      v.myTracks = this.tracks[playerId];
      v.removalsLeft = this.effBuffer - this.removals[playerId];
      v.keep = this.keep;
    }
    if (['between', 'playing', 'reveal'].includes(this.phase)) {
      v.round = { index: this.round, total: this.queue.length, remainingMs: this.settings.timer && this.deadline != null ? Math.max(0, this.deadline - (this.pausedAt ?? this.now())) : null,
        guessedCount: this.guesses.size, paused: this.pausedAt !== null, timed: this.settings.timer };
      if (playerId === this.hostId) v.nextUri = this.queue[this.round].track.uri;
    }
    if (this.phase === 'playing' && this.queue[this.round].ownerId === playerId) v.iOwnThisSong = true;
    if (['playing', 'reveal'].includes(this.phase) && this.guesses.has(playerId)) {
      v.myGuess = this.guesses.get(playerId).id;
    }
    if (this.phase === 'reveal') {
      const { ownerId, track } = this.queue[this.round];
      v.reveal = { ownerId, track, deltas: { ...this.deltas } };
    }
    return v;
  }
}
