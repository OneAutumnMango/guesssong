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
  assert.equal(g.view('a').myTracks.length, 4);
  assert.equal(g.view('b').myTracks.length, 4);
  assert.equal(g.view('a').keep, 3);
  assert.equal(g.view('a').removalsLeft, 1);
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
  assert.equal(g.view('b').myTracks.length, 4);
});

test('removals limited by buffer; everyone ends with keep songs', () => {
  const g = mk();
  g.start({ a: pool('a'), b: pool('b') });
  const [t0, t1] = g.view('a').myTracks;
  g.removeTrack('a', t0.id);
  assert.throws(() => g.removeTrack('a', t1.id), /No removals left/);
  assert.equal(g.view('a').removalsLeft, 0);
  g.setReady('a');
  assert.equal(g.setReady('b'), true);
  assert.equal(g.phase, 'between');
  assert.equal(g.view('a').round.total, 6);
  assert.deepEqual([g.tracks.a.length, g.tracks.b.length], [3, 3]); // b dropped one at random
});

test('mandatory removals: nobody removes anything -> keep each; queue is exact and duplicate free', () => {
  const g = mk();
  g.addPlayer('c', 'Cy');
  g.start({ a: pool('a'), b: pool('b'), c: pool('c') });
  for (const id of g.participants()) g.setReady(id);
  assert.equal(g.phase, 'between');
  assert.equal(g.queue.length, 9);
  assert.equal(new Set(g.queue.map((q) => q.track.id)).size, 9);
  for (const id of ['a', 'b', 'c']) assert.equal(g.queue.filter((q) => q.ownerId === id).length, 3);
});

test('perPerson larger than the pool: per is the pool size, keep follows the formula', () => {
  const g = mk();
  g.configure({ perPerson: 3, buffer: 1 });
  g.start({ a: pool('a', 2), b: pool('b') }); // per = 2, effBuffer = min(1, 1) = 1, keep = 1
  assert.equal(g.view('a').myTracks.length, 2);
  assert.equal(g.view('a').keep, 1);
  assert.equal(g.view('a').removalsLeft, 1);
  g.setReady('a');
  g.setReady('b');
  assert.deepEqual([g.tracks.a.length, g.tracks.b.length], [1, 1]);
});

test('buffer 0: no removals, nothing dropped', () => {
  const g = mk();
  g.configure({ perPerson: 4, buffer: 0 });
  g.start({ a: pool('a'), b: pool('b') });
  assert.equal(g.view('a').keep, 4);
  assert.equal(g.view('a').removalsLeft, 0);
  assert.throws(() => g.removeTrack('a', g.view('a').myTracks[0].id), /No removals left/);
  g.setReady('a');
  g.setReady('b');
  assert.deepEqual([g.tracks.a.length, g.tracks.b.length], [4, 4]);
});

test('mandatory drops also apply when a disconnected player never readied', () => {
  const g = mk();
  g.start({ a: pool('a'), b: pool('b') });
  g.setConnected('b', false);
  assert.equal(g.setReady('a'), true);
  assert.deepEqual([g.tracks.a.length, g.tracks.b.length], [3, 3]);
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
  for (let i = 0; i < 6; i++) {
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
    { perPerson: NaN }, { perPerson: 0 }, { perPerson: 26 }, { perPerson: 1.5 }, { perPerson: '4' },
    { buffer: -1 }, { buffer: 21 }, { buffer: 1.5 }, { hostPlays: 'false' },
    { source: 'x' }, { perPerson: 10, buffer: -1 }, { perPerson: 3, buffer: 3 }, { buffer: 4 },
  ]) {
    assert.throws(() => g.configure(bad), Error, JSON.stringify(bad));
    assert.equal(JSON.stringify(g.settings), before);
  }
  g.configure({ perPerson: 10, buffer: 0, hostPlays: false, source: 'liked', evil: 1, total: 99 });
  assert.deepEqual(g.settings, { source: 'liked', perPerson: 10, buffer: 0, hostPlays: false, timer: true });
  g.configure({ buffer: 3 });
  g.configure({ perPerson: 2, buffer: 1 }); // valid together although the old buffer was 3
  assert.deepEqual([g.settings.perPerson, g.settings.buffer], [2, 1]);
  const h = mk();
  h.start({ a: pool('a'), b: pool('b') });
  assert.throws(() => h.configure({ perPerson: 5 }));
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

test('equal split after de-duplication of shared tracks', () => {
  const g = mk();
  g.start({ a: pool('s', 8), b: pool('s', 8) });
  assert.equal(g.view('a').myTracks.length, g.view('b').myTracks.length);
  assert.ok(g.view('a').myTracks.length >= 1);
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

test('round timing does not depend on the wall clock', async () => {
  const g = new Game({ durationMs: 400 }); // default (monotonic) clock
  g.addPlayer('a', 'Ann', true);
  g.addPlayer('b', 'Bob');
  g.start({ a: pool('a'), b: pool('b') });
  for (const id of g.participants()) g.setReady(id);
  g.beginRound();
  const owner = ['a', 'b'].find((p) => g.guessProblem(p) === 'This is your song, sit this round out');
  const guesser = owner === 'a' ? 'b' : 'a';
  assert.equal(g.view(guesser).round.deadline, undefined);
  await new Promise((r) => setTimeout(r, 200));
  const real = Date.now;
  Date.now = () => real() + 5000; // a wall-clock step forward
  try {
    assert.ok(g.view(guesser).round.remainingMs > 100);
    assert.equal(g.guess(guesser, owner), true);
    g.endRound();
  } finally {
    Date.now = real;
  }
  const d = g.view(owner).reveal.deltas[guesser];
  assert.ok(d >= 700 && d <= 800, `scored ${d}`); // about 200 of 400 ms elapsed
});

// streaks: display only
const game3 = (hostPlays = true) => {
  clock = 0;
  const g = new Game({ now: () => clock, rng: () => 0.5 });
  g.addPlayer('a', 'Ann', true);
  g.addPlayer('b', 'Bob');
  g.addPlayer('c', 'Cy');
  g.configure({ perPerson: 4, buffer: 0, hostPlays });
  g.start({ a: pool('a'), b: pool('b'), c: pool('c') });
  for (const id of g.participants()) g.setReady(id);
  return g;
};
const playRound = (g, answer, pre = {}) => { // answer: 'right' | 'wrong' | 'none' for every guesser
  g.beginRound();
  const owner = g.queue[g.round].ownerId;
  for (const [id, v] of Object.entries(pre)) g.players.get(id).streak = v;
  const before = Object.fromEntries([...g.players].map(([id, p]) => [id, p.streak]));
  const guessers = [...g.players.keys()].filter((id) => g.guessProblem(id) === null);
  for (const id of guessers) if (answer !== 'none') g.guess(id, answer === 'right' ? owner : 'zz');
  g.endRound();
  const after = Object.fromEntries([...g.players].map(([id, p]) => [id, p.streak]));
  g.next();
  return { owner, guessers, before, after, g };
};

test('streaks: correct increments, wrong and no guess reset, owner unchanged', () => {
  const g = game3();
  let r = playRound(g, 'right');
  for (const id of r.guessers) assert.equal(r.after[id], r.before[id] + 1);
  assert.equal(r.after[r.owner], r.before[r.owner]);
  r = playRound(g, 'right');
  for (const id of r.guessers) assert.equal(r.after[id], r.before[id] + 1);
  r = playRound(g, 'wrong');
  for (const id of r.guessers) assert.equal(r.after[id], 0);
  r = playRound(g, 'right');
  r = playRound(g, 'none');
  for (const id of r.guessers) assert.equal(r.after[id], 0);
  assert.equal(r.after[r.owner], r.before[r.owner]);
});

test('streaks: two correct in a row gives 2', () => {
  const g = game3();
  playRound(g, 'right');
  const r = playRound(g, 'right');
  assert.ok(Object.values(r.after).includes(2));
});

test('streaks: owner keeps an old streak of 0 or 3', () => {
  for (const old of [0, 3]) {
    const g = game3();
    g.beginRound();
    const owner = g.queue[g.round].ownerId;
    g.endRound();
    g.next();
    for (let i = 0; i < 12; i++) { // advance to another round of the same owner
      g.beginRound();
      const mine = g.queue[g.round].ownerId === owner;
      if (mine) g.players.get(owner).streak = old;
      g.endRound();
      if (mine) { assert.equal(g.players.get(owner).streak, old); break; }
      g.next();
    }
  }
});

test('streaks: non-playing host never gets one; disconnected non-guesser resets', () => {
  const g = game3(false);
  g.players.get('a').streak = 2;
  let r = playRound(g, 'right');
  assert.equal(r.after.a, 2);
  assert.ok(!r.guessers.includes('a'));
  const h = game3();
  h.setConnected('b', false);
  r = playRound(h, 'none', { b: 3 });
  if (r.guessers.includes('b')) assert.equal(r.after.b, 0);
  else assert.equal(r.after.b, 3);
});

test('streak is in every player view and scoring is unchanged', () => {
  const g = game3();
  assert.ok(g.view('a').players.every((p) => Number.isInteger(p.streak) && p.streak >= 0));
  g.beginRound();
  const owner = g.queue[g.round].ownerId;
  const [x, y] = [...g.players.keys()].filter((id) => id !== owner);
  clock = 5000;
  g.guess(x, owner);
  clock = 10000;
  g.guess(y, 'zz');
  assert.equal(g.view(x).players.find((p) => p.id === x).streak, 0); // nothing leaks before endRound
  g.endRound();
  const d = g.view(x).reveal.deltas;
  assert.equal(d[x], 875);
  assert.equal(d[y], 0);
  assert.equal(d[owner], 0);
  assert.equal(g.view(x).players.find((p) => p.id === x).streak, 1);
});

// timer / pause / no timer
const timedRound = (opts = {}) => {
  const g = mk();
  if (opts.untimed) g.configure({ timer: false });
  toBetween(g);
  g.beginRound();
  const owner = g.queue[g.round].ownerId;
  return { g, owner, guesser: owner === 'a' ? 'b' : 'a' };
};

test('timer setting validates and defaults to true', () => {
  const g = mk();
  assert.equal(g.settings.timer, true);
  assert.throws(() => g.configure({ timer: 'no' }), /Invalid setting: timer/);
  assert.throws(() => g.configure({ timer: 0 }), /Invalid setting: timer/);
  g.configure({ timer: false, perPerson: 3, buffer: 1 });
  assert.equal(g.view('a').settings.timer, false);
  const h = mk();
  h.start({ a: pool('a'), b: pool('b') });
  assert.throws(() => h.configure({ timer: false }));
});

test('round view has timed/paused and remainingMs', () => {
  const { g, guesser } = timedRound();
  let r = g.view(guesser).round;
  assert.deepEqual([r.timed, r.paused, r.remainingMs], [true, false, 20000]);
  const u = timedRound({ untimed: true });
  r = u.g.view(u.guesser).round;
  assert.deepEqual([r.timed, r.paused, r.remainingMs], [false, false, null]);
});

test('pause freezes remaining time and elapsed; resume excludes the paused time', () => {
  const { g, owner, guesser } = timedRound();
  clock = 5000;
  g.pauseRound();
  clock = 15000;
  const r = g.view(guesser).round;
  assert.deepEqual([r.paused, r.remainingMs], [true, 15000]);
  assert.equal(g.guessProblem(guesser), null);
  g.resumeRound();
  assert.equal(g.view(guesser).round.remainingMs, 15000);
  assert.equal(g.view(guesser).round.paused, false);
  assert.equal(g.guess(guesser, owner), true); // at the same moment: elapsed 5000
  g.endRound();
  assert.equal(g.view(owner).reveal.deltas[guesser], 875);
});

test('a guess while paused is scored from the frozen time and paused time is not "Time is up"', () => {
  const { g, owner, guesser } = timedRound();
  clock = 5000;
  g.pauseRound();
  clock = 90000;
  assert.equal(g.guessProblem(guesser), null);
  assert.equal(g.guess(guesser, owner), true);
  g.endRound();
  assert.equal(g.view(owner).reveal.deltas[guesser], 875);
  assert.equal(g.view(owner).round.paused, false); // ended while paused: state cleaned up
});

test('pause still rejects a guess whose frozen elapsed already exceeds the duration', () => {
  const { g, guesser } = timedRound();
  clock = 20001;
  g.pauseRound();
  assert.equal(g.guessProblem(guesser), 'Time is up');
});

test('several pause/resume cycles accumulate', () => {
  const { g, owner, guesser } = timedRound();
  clock = 5000; g.pauseRound();
  clock = 10000; g.resumeRound(); // 5 s paused
  clock = 12000; g.pauseRound();
  clock = 20000; g.resumeRound(); // 8 s paused
  assert.equal(g.view(guesser).round.remainingMs, 13000);
  assert.equal(g.guess(guesser, owner), true); // elapsed 20000 - 13000 = 7000
  g.endRound();
  assert.equal(g.view(owner).reveal.deltas[guesser], Math.round(1000 - 500 * (7000 / 20000)));
});

test('pause/resume errors and a new round starts unpaused', () => {
  const { g } = timedRound();
  assert.throws(() => g.resumeRound(), /Not paused/);
  g.pauseRound();
  assert.throws(() => g.pauseRound(), /Already paused/);
  g.endRound();
  assert.throws(() => g.pauseRound(), /Not playing/);
  g.next();
  g.beginRound();
  assert.equal(g.view('a').round.paused, false);
  const u = timedRound({ untimed: true }).g;
  assert.throws(() => u.pauseRound(), /This round has no timer/);
  assert.throws(() => u.resumeRound(), /This round has no timer/);
});

test('no timer: never "Time is up", flat 1000 for correct, 0 for wrong', () => {
  const { g, owner, guesser } = timedRound({ untimed: true });
  clock = 10 * 60 * 1000;
  assert.equal(g.guessProblem(guesser), null);
  assert.equal(g.guess(guesser, owner), true);
  assert.equal(g.allGuessed(), true);
  g.endRound();
  assert.equal(g.view(owner).reveal.deltas[guesser], 1000);
  g.next();
  g.beginRound();
  const o2 = g.queue[g.round].ownerId;
  const x = o2 === 'a' ? 'b' : 'a';
  clock += 123456;
  g.guess(x, 'zz');
  g.endRound();
  assert.equal(g.view(o2).reveal.deltas[x], 0);
});
