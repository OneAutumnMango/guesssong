import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreFor, perPlayerCount, pickTracks } from '../src/logic.js';

test('scoreFor', () => {
  assert.equal(scoreFor(true, 0), 1000);
  assert.equal(scoreFor(true, 10000), 750);
  assert.equal(scoreFor(true, 20000), 500);
  assert.equal(scoreFor(true, 99999), 500);
  assert.equal(scoreFor(false, 0), 0);
});

test('perPlayerCount', () => {
  assert.equal(perPlayerCount(4, [50, 50, 50]), 4);
  assert.equal(perPlayerCount(4, [50, 2, 50]), 2);
  assert.equal(perPlayerCount(25, [50, 30]), 25);
  assert.equal(perPlayerCount(4, [50, 0, 50]), 0);
});

const t = (id) => ({ id, uri: 'spotify:track:' + id, title: id, artist: 'a' });

test('pickTracks: own pool, no duplicates across players', () => {
  const pools = { a: ['1', '2', '3', '4'].map(t), b: ['4', '5', '6', '7'].map(t) };
  const r = pickTracks(pools, 3);
  assert.equal(r.a.length, 3);
  assert.equal(r.b.length, 3);
  for (const p of ['a', 'b']) for (const x of r[p]) assert.ok(pools[p].some((y) => y.id === x.id));
  const ids = [...r.a, ...r.b].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('pickTracks: short pool returns fewer, no throw', () => {
  const pools = { a: ['1', '2', '3'].map(t), b: ['1', '2', '3'].map(t) };
  const r = pickTracks(pools, 3);
  assert.equal(r.a.length + r.b.length, 3);
  assert.ok(r.b.length < 3);
});

test('scoreFor clamps negative elapsed', () => {
  assert.equal(scoreFor(true, -2000), 1000);
});
