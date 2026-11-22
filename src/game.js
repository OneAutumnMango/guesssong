import { scoreFor, perPlayerCount, pickTracks } from './logic.js';

const MAX_PLAYERS = 8;

export class Game {
  constructor({ now = Date.now, rng = Math.random, durationMs = 20000 } = {}) {
    this.now = now;
    this.rng = rng;
    this.durationMs = durationMs;
    this.phase = 'lobby';
    this.settings = { source: 'recents', total: 12, buffer: 2, hostPlays: true };
    this.hostId = null;
    this.deadline = null;
    this.players = new Map(); // id -> { id, name, connected, score }
    this.round = 0;
    this.queue = [];
    this.tracks = {}; // review: playerId -> Track[]
    this.removals = {};
    this.ready = new Set();
    this.guesses = new Map(); // playerId -> { id, at }
    this.roundStart = null;
    this.deltas = {};
  }

  addPlayer(id, name, isHost = false) {
    if (this.phase !== 'lobby') throw new Error('Game already started');
    if (this.players.size >= MAX_PLAYERS) throw new Error('Room is full');
    this.players.set(id, { id, name, connected: true, score: 0 });
    if (isHost) this.hostId = id;
  }

  setConnected(id, connected) {
    const p = this.players.get(id);
    if (p) p.connected = connected;
  }

  configure(s) {
    if (this.phase !== 'lobby') throw new Error('Settings are locked');
    Object.assign(this.settings, s);
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
    const per = perPlayerCount(this.settings.total, ids.length, ids.map((id) => own[id].length));
    this.tracks = pickTracks(own, per, this.rng);
    for (const id of ids) {
      if (!this.tracks[id].length) throw new Error(`${this.players.get(id).name} has no songs`);
      this.removals[id] = 0;
    }
    this.phase = 'review';
  }

  removeTrack(playerId, trackId) {
    if (this.phase !== 'review') throw new Error('Not in review');
    const mine = this.tracks[playerId];
    if (!mine) throw new Error('Not a participant');
    if (this.removals[playerId] >= this.settings.buffer) throw new Error('No removals left');
    const i = mine.findIndex((t) => t.id === trackId);
    if (i < 0) throw new Error('Unknown track');
    mine.splice(i, 1);
    this.removals[playerId]++;
  }

  setReady(playerId) {
    if (this.phase !== 'review' || !this.tracks[playerId]) return false;
    this.ready.add(playerId);
    if (!this.participants().every((id) => this.ready.has(id))) return false;
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
    this.deadline = this.roundStart + this.durationMs;
    this.phase = 'playing';
  }

  #guessers() {
    const owner = this.queue[this.round].ownerId;
    return [...this.players.keys()].filter(
      (id) => id !== owner && (this.settings.hostPlays || id !== this.hostId),
    );
  }

  guess(playerId, guessedId) {
    if (this.phase !== 'playing') return false;
    const at = this.now();
    if (at > this.deadline || this.guesses.has(playerId) || !this.#guessers().includes(playerId)) return false;
    this.guesses.set(playerId, { id: guessedId, at });
    return true;
  }

  allGuessed() {
    return this.phase === 'playing' && this.#guessers().every((id) => this.guesses.has(id));
  }

  endRound() {
    if (this.phase !== 'playing') throw new Error('Not playing');
    const { ownerId } = this.queue[this.round];
    for (const id of this.players.keys()) this.deltas[id] = 0;
    for (const [id, g] of this.guesses) {
      const d = scoreFor(g.id === ownerId, g.at - this.roundStart, this.durationMs);
      this.deltas[id] = d;
      this.players.get(id).score += d;
    }
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
      v.removalsLeft = this.settings.buffer - this.removals[playerId];
    }
    if (['between', 'playing', 'reveal'].includes(this.phase)) {
      v.round = { index: this.round, total: this.queue.length, deadline: this.deadline, guessedCount: this.guesses.size };
      if (playerId === this.hostId) v.nextUri = this.queue[this.round].track.uri;
    }
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
