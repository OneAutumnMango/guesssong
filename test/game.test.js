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
