import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';

const tr = (p, i) => ({ id: `${p}${i}`, uri: `spotify:track:${p}${i}`, title: `${p}${i}`, artist: 'x' });
const pool = (p, n = 50) => Array.from({ length: n }, (_, i) => tr(p, i));
let clock;
const mk = (opts = {}) => {
  clock = 0;
  const g = new Game({ now: () => clock, rng: () => 0.5, ...opts });
  g.addPlayer('a', 'Ann', true);
  g.addPlayer('b', 'Bob');
  return g;
};
const toBetween = (g) => {
  g.start({ a: pool('a'), b: pool('b') });
  for (const id of g.participants()) g.setReady(id);
};

test('9th player throws; join after lobby throws', () => {
  const g = mk();
  for (let i = 2; i < 8; i++) g.addPlayer('p' + i, 'P' + i);
  assert.throws(() => g.addPlayer('x', 'X'));
  const h = mk();
  h.start({ a: pool('a'), b: pool('b') });
  assert.throws(() => h.addPlayer('c', 'C'));
});

test('start splits songs and enters review', () => {
  const g = mk();
  g.start({ a: pool('a'), b: pool('b') });
  assert.equal(g.phase, 'review');
  assert.equal(g.view('a').myTracks.length, 6);
  assert.equal(g.view('b').myTracks.length, 6);
});

test('start throws on empty pool or <2 participants', () => {
  const g = mk();
  assert.throws(() => g.start({ a: pool('a'), b: [] }), /Bob has no songs/);
  const h = mk({});
  h.configure({ hostPlays: false });
  assert.throws(() => h.start({ a: pool('a'), b: pool('b') }));
});

test('hostPlays false ignores host pool', () => {
  const g = mk();
  g.addPlayer('c', 'Cy');
  g.configure({ hostPlays: false });
  g.start({ a: pool('a'), b: pool('b'), c: pool('c') });
  assert.equal(g.view('a').myTracks, undefined);
  assert.equal(g.view('b').myTracks.length, 6);
});

test('removals limited by buffer; 10 songs remain', () => {
  const g = mk();
  g.start({ a: pool('a'), b: pool('b') });
  const [t0, t1, t2] = g.view('a').myTracks;
  g.removeTrack('a', t0.id);
  g.removeTrack('a', t1.id);
  assert.throws(() => g.removeTrack('a', t2.id));
  assert.equal(g.view('a').removalsLeft, 0);
  g.setReady('a');
  assert.equal(g.setReady('b'), true);
  assert.equal(g.phase, 'between');
  assert.equal(g.view('a').round.total, 10);
});

test('setReady true only when all ready', () => {
  const g = mk();
  g.start({ a: pool('a'), b: pool('b') });
  assert.equal(g.setReady('a'), false);
  assert.equal(g.setReady('b'), true);
  assert.equal(g.phase, 'between');
});

test('round flow, scoring and rejections', () => {
  const g = mk();
  toBetween(g);
  assert.equal(g.guess('b', 'a'), false); // not playing
  g.beginRound();
  assert.equal(g.phase, 'playing');
  assert.equal(g.deadline, 20000);
  const v = g.view('b');
  assert.equal(v.reveal, undefined);
  assert.equal(JSON.stringify(g.view('a')).includes('ownerId'), false);
  assert.equal(JSON.stringify(v).includes('ownerId'), false);
  // find owner: the one who can't guess
  clock = 5000;
  const ownerId = ['a', 'b'].find((p) => g.guess(p, 'zz') === false);
  const guesser = ownerId === 'a' ? 'b' : 'a';
  assert.equal(g.allGuessed(), false);
  assert.equal(g.guess(guesser, ownerId), true);
  assert.equal(g.guess(guesser, ownerId), false); // duplicate
  assert.equal(g.allGuessed(), true);
  g.endRound();
  assert.equal(g.phase, 'reveal');
  const r = g.view('a').reveal;
  assert.equal(r.ownerId, ownerId);
  assert.equal(r.deltas[guesser], 875);
  assert.equal(r.deltas[ownerId], 0);
  assert.equal(g.view(guesser).players.find((p) => p.id === guesser).score, 875);
});

test('late guess rejected; wrong guess scores 0', () => {
  const g = mk();
  toBetween(g);
  g.beginRound();
  clock = 20001;
  assert.equal(g.guess('a', 'b'), false);
  assert.equal(g.guess('b', 'a'), false);
});

test('next after last round finishes', () => {
  const g = mk();
  toBetween(g);
  for (let i = 0; i < 12; i++) {
    assert.equal(g.phase, 'between');
    g.beginRound();
    g.endRound();
    g.next();
  }
  assert.equal(g.phase, 'finished');
});

test('host with hostPlays false cannot guess', () => {
  const g = mk();
  g.addPlayer('c', 'Cy');
  g.configure({ hostPlays: false });
  g.start({ a: pool('a'), b: pool('b'), c: pool('c') });
  for (const id of g.participants()) g.setReady(id);
  g.beginRound();
  assert.equal(g.guess('a', 'b'), false);
});

test('configure validates input atomically', () => {
  const g = mk();
  const before = JSON.stringify(g.settings);
  for (const bad of [
    { total: NaN }, { total: 0 }, { total: 101 }, { total: 1.5 }, { total: '12' },
    { buffer: -1 }, { buffer: 21 }, { buffer: 1.5 }, { hostPlays: 'false' },
    { source: 'x' }, { total: 10, buffer: -1 },
  ]) {
    assert.throws(() => g.configure(bad), Error, JSON.stringify(bad));
    assert.equal(JSON.stringify(g.settings), before);
  }
  g.configure({ total: 10, buffer: 0, hostPlays: false, source: 'liked', evil: 1 });
  assert.deepEqual(g.settings, { source: 'liked', total: 10, buffer: 0, hostPlays: false });
  const h = mk();
  h.start({ a: pool('a'), b: pool('b') });
  assert.throws(() => h.configure({ total: 5 }));
});

test('disconnected participant does not block readiness', () => {
  const g = mk();
  g.start({ a: pool('a'), b: pool('b') });
  g.setConnected('b', false);
  assert.equal(g.setReady('a'), true);
  assert.equal(g.phase, 'between');
});

test('checkReady starts game when remaining player disconnects last', () => {
  const g = mk();
  g.start({ a: pool('a'), b: pool('b') });
  assert.equal(g.setReady('a'), false);
  assert.equal(g.checkReady(), false);
  g.setConnected('b', false);
  assert.equal(g.checkReady(), true);
  assert.equal(g.phase, 'between');
});

test('nobody connected and ready does not advance', () => {
  const g = mk();
  g.start({ a: pool('a'), b: pool('b') });
  g.setConnected('a', false);
  g.setConnected('b', false);
  assert.equal(g.checkReady(), false);
});

test('cannot remove the last song', () => {
  const g = mk();
  g.configure({ total: 2, buffer: 5 });
  g.start({ a: pool('a'), b: pool('b') });
  assert.throws(() => g.removeTrack('a', g.view('a').myTracks[0].id), /Keep at least one song/);
});

test('equal split after de-duplication of shared tracks', () => {
  const g = mk();
  g.start({ a: pool('s', 8), b: pool('s', 8) });
  assert.equal(g.view('a').myTracks.length, g.view('b').myTracks.length);
  assert.ok(g.view('a').myTracks.length >= 1);
});

test('total too small for participants throws clear error', () => {
  const g = mk();
  g.addPlayer('c', 'Cy');
  g.addPlayer('d', 'Di');
  g.configure({ total: 3 });
  assert.throws(() => g.start({ a: pool('a'), b: pool('b'), c: pool('c'), d: pool('d') }), /Need at least 1 song per player; raise Total songs/);
});

test('addPlayer rejects a duplicate id', () => {
  const g = mk();
  assert.throws(() => g.addPlayer('a', 'Again'), /already/i);
});

const playing = (extra = (g) => {}) => {
  const g = mk();
  extra(g);
  toBetween(g);
  g.beginRound();
  const owner = ['a', 'b'].find((p) => g.guessProblem(p) === 'This is your song, sit this round out');
  return { g, owner, guesser: owner === 'a' ? 'b' : 'a' };
};

test('iOwnThisSong is only set for the owner while playing', () => {
  const { g, owner, guesser } = playing();
  assert.equal(g.view(owner).iOwnThisSong, true);
  assert.ok(!g.view(guesser).iOwnThisSong);
  assert.ok(!/iOwnThisSong|ownerId/.test(JSON.stringify(g.view(guesser))));
  g.guess(guesser, owner);
  g.endRound();
  assert.ok(!g.view(owner).iOwnThisSong);
});

test('view.round has remainingMs', () => {
  const { g, guesser } = playing();
  assert.equal(g.view(guesser).round.remainingMs, 20000);
  clock = 5000;
  assert.equal(g.view(guesser).round.remainingMs, 15000);
  clock = 99999;
  assert.equal(g.view(guesser).round.remainingMs, 0);
});

test('specific rejection messages', () => {
  const { g, owner, guesser } = playing();
  assert.equal(g.guessProblem(owner), 'This is your song, sit this round out');
  assert.equal(g.guessProblem('nobody'), 'You are not guessing this round');
  assert.equal(g.guessProblem(guesser), null);
  g.guess(guesser, owner);
  assert.equal(g.guessProblem(guesser), 'You already locked in a guess');
  const h = playing().g;
  clock = 20001;
  assert.equal(h.guessProblem(['a', 'b'].find((p) => h.guessProblem(p) === 'Time is up')), 'Time is up');
  g.endRound();
  assert.equal(g.guessProblem(guesser), 'Not accepting guesses right now');
});

test('non-playing host gets "not guessing" message', () => {
  const g = mk();
  g.addPlayer('c', 'Cy');
  g.configure({ hostPlays: false });
  g.start({ a: pool('a'), b: pool('b'), c: pool('c') });
  for (const id of g.participants()) g.setReady(id);
  g.beginRound();
  assert.equal(g.guessProblem('a'), 'You are not guessing this round');
});

test('latency compensation accepts in-flight guesses and clamps', () => {
  let { g, owner, guesser } = playing();
  clock = 20400;
  assert.equal(g.guessProblem(guesser, 0), 'Time is up');
  assert.equal(g.guess(guesser, owner, 500), true);
  g.endRound();
  assert.equal(g.view('a').reveal.deltas[guesser], Math.round(1000 - 500 * (19900 / 20000)));

  ({ g, owner, guesser } = playing());
  clock = 21500;
  assert.equal(g.guess(guesser, owner, 5000), false); // clamped to 1000
  for (const bad of [-50, NaN, 'x', undefined]) {
    ({ g, owner, guesser } = playing());
    clock = 20001;
    assert.equal(g.guess(guesser, owner, bad), false, String(bad)); // treated as 0
  }
});

test('elapsed never drops below zero', () => {
  const { g, owner, guesser } = playing();
  clock = 100;
  assert.equal(g.guess(guesser, owner, 500), true);
  g.endRound();
  assert.equal(g.view('a').reveal.deltas[guesser], 1000);
});
