import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../src/server.js';
import { SpotifyError } from '../src/spotify.js';
import { joinUrl, qrSvg } from '../src/qr.js';

const spotify = {
  exchangeCode: async ({ code }) => {
    if (code === 'bad') throw new SpotifyError(403, 'nope');
    return 'tok-' + code;
  },
  fetchProfile: async (token) => ({ id: token.slice(4), name: token.slice(4) }),
  fetchPool: async (token) =>
    token === 'tok-empty' ? [] : Array.from({ length: 20 }, (_, i) => ({ id: `${token}-${i}`, uri: `spotify:track:${token}-${i}`, title: 't' + i, artist: 'a' })),
};

const tmp = mkdtempSync(join(tmpdir(), 'gs-'));
const publicDir = join(tmp, 'pub');
mkdirSync(publicDir);
writeFileSync(join(publicDir, 'play.html'), '<p>hi</p>');
writeFileSync(join(tmp, 'secret.txt'), 'SENTINEL-SECRET');

async function boot(durationMs = 300, extra = {}) {
  const server = createServer({ clientId: 'cid', publicUrl: 'http://x.test', spotify: extra.spotify ?? spotify, durationMs, publicDir, ...extra.opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  const login = async (room, code) => {
    const r = await fetch(`${base}/login?room=${room}`, { redirect: 'manual' });
    if (r.status !== 302) return { res: r };
    const state = new URL(r.headers.get('location')).searchParams.get('state');
    const res = await fetch(`${base}/callback?code=${code}&state=${state}`, { redirect: 'manual' });
    const loc = res.headers.get('location');
    return { res, state, key: loc && loc.split('key=')[1] };
  };
  const loginState = async (room) => {
    const r = await fetch(`${base}/login?room=${room}`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    return new URL(r.headers.get('location')).searchParams.get('state');
  };
  const callback = (code, state) => fetch(`${base}/callback?code=${code}&state=${state}`, { redirect: 'manual' });
  const snap = (code) => { const g = server.rooms.get(code).game; return JSON.stringify([g.phase, g.settings, g.round]); };
  const waitStarting = async (room) => {
    for (let i = 0; i < 200 && !room.starting; i++) await new Promise((r) => setTimeout(r, 5));
    if (!room.starting) throw new Error('start never began');
  };
  const connect = async (key) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
    sockets.push(ws);
    const c = { ws, msgs: [], waiters: [] };
    ws.on('message', (d) => { c.msgs.push(JSON.parse(d)); c.waiters.forEach((w) => w()); });
    await new Promise((r) => ws.on('open', r));
    c.send = (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m));
    c.until = (pred, ms = 3000) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting for message')), ms);
      const check = () => {
        while (c.msgs.length) {
          const m = c.msgs.shift();
          if (pred(m)) { clearTimeout(t); c.waiters = c.waiters.filter((w) => w !== check); return res(m); }
        }
      };
      c.waiters.push(check);
      check();
    });
    c.phase = (p) => c.until((m) => m.type === 'state' && m.view.phase === p);
    c.err = () => c.until((m) => m.type === 'error');
    if (key) c.send({ type: 'hello', key });
    return c;
  };
  const close = () => new Promise((r) => { sockets.forEach((s) => s.terminate()); server.close(r); });
  return { server, base, login, loginState, callback, waitStarting, sockets, snap, connect, close };
}

test('full game flow, permissions, reconnect, cleanup', async () => {
  const t = await boot(300);
  try {
    const h = await t.login('new', 'H');
    assert.equal(h.res.status, 302);
    assert.match(h.res.headers.get('location'), /^\/play\.html#key=[0-9a-f]{32}$/);
    const hc = await t.connect(h.key);
    const first = await hc.until((m) => m.type === 'state');
    assert.equal(first.view.phase, 'lobby');
    const code = first.view.code;
    assert.match(code, /^[A-Z]{4}$/);

    const j = await t.login(code, 'J');
    const jc = await t.connect(j.key);
    assert.equal((await jc.phase('lobby')).view.code, code);

    // non-host is rejected in lobby (settings/start)
    const lobbySnap = t.snap(code);
    for (const type of ['start', 'settings']) {
      jc.send({ type, settings: { perPerson: 2, buffer: 0 } });
      assert.match((await jc.err()).message, /host/i);
      assert.equal(t.snap(code), lobbySnap, type + ' changed state');
    }
    jc.send('not json');
    await jc.err();
    jc.send({ type: 'bogus' });
    await jc.err();
    hc.send({ type: 'settings', settings: 'x' });
    await hc.err();
    hc.send({ type: 'settings', settings: { perPerson: -1 } });
    assert.match((await hc.err()).message, /Invalid setting/);

    hc.send({ type: 'settings', settings: { perPerson: 2, buffer: 1 } });
    hc.send({ type: 'start' });
    const hr = await hc.phase('review');
    const jr = await jc.phase('review');
    hc.send({ type: 'remove', trackId: hr.view.myTracks[0].id });
    jc.send({ type: 'remove', trackId: jr.view.myTracks[0].id });
    hc.send({ type: 'ready' });
    jc.send({ type: 'ready' });
    await hc.phase('between');
    await jc.phase('between');

    const betweenSnap = t.snap(code);
    jc.send({ type: 'play' });
    assert.match((await jc.err()).message, /host/i);
    assert.equal(t.snap(code), betweenSnap, 'play changed state');

    // round 1: everyone guesses -> reveal well before the timer
    hc.send({ type: 'play' });
    await hc.phase('playing');
    jc.send({ type: 'guess', playerId: 'nobody' });
    assert.match((await jc.err()).message, /player/i);
    const t0 = performance.now();
    hc.send({ type: 'guess', playerId: 'J' });
    jc.send({ type: 'guess', playerId: 'H' });
    await hc.phase('reveal');
    assert.ok(performance.now() - t0 < 250);
    hc.send({ type: 'guess', playerId: 'J' });
    await hc.until((m) => m.type === 'error' && /Not accepting guesses right now/.test(m.message));
    const revealSnap = t.snap(code);
    jc.send({ type: 'next' });
    assert.match((await jc.until((m) => m.type === 'error' && /host/i.test(m.message))).message, /host/i);
    assert.equal(t.snap(code), revealSnap, 'next changed state');
    hc.send({ type: 'next' });
    await hc.phase('between');

    // reconnect: new socket with same key gets state
    const hc2 = await t.connect(h.key);
    assert.equal((await hc2.until((m) => m.type === 'state')).view.phase, 'between');

    // round 2: nobody guesses -> reveal after the timer
    const t1 = performance.now();
    hc2.send({ type: 'play' });
    await hc2.phase('reveal');
    const dt = performance.now() - t1;
    assert.ok(dt >= 250 && dt <= 1700, `reveal after ${dt}ms`); // 300 + 1100 grace
    hc2.send({ type: 'next' });
    await hc2.phase('finished');
    await jc.phase('finished');

    const gone = await t.login(code, 'J');
    assert.notEqual(gone.res.status, 302);
  } finally {
    await t.close();
  }
});

test('failed start (empty pool) names the player and stays in lobby', async () => {
  const t = await boot();
  try {
    const h = await t.login('new', 'H');
    const hc = await t.connect(h.key);
    const code = (await hc.until((m) => m.type === 'state')).view.code;
    const e = await t.login(code, 'empty');
    await t.connect(e.key);
    hc.send({ type: 'start' });
    assert.match((await hc.err()).message, /empty/);
    const hc2 = await t.connect(h.key);
    assert.equal((await hc2.until((m) => m.type === 'state')).view.phase, 'lobby');
  } finally {
    await t.close();
  }
});

test('oauth: 403 page, bad/reused state', async () => {
  const t = await boot();
  try {
    const r = await t.login('new', 'bad');
    assert.equal(r.res.status, 403);
    assert.match(await r.res.text(), /allowlist/);
    const ok = await t.login('new', 'H');
    const again = await fetch(`${t.base}/callback?code=H&state=${ok.state}`, { redirect: 'manual' });
    assert.equal(again.status, 400);
    const unknown = await fetch(`${t.base}/callback?code=H&state=zzz`, { redirect: 'manual' });
    assert.equal(unknown.status, 400);
  } finally {
    await t.close();
  }
});

test('static serving stays inside publicDir', async () => {
  const t = await boot();
  const port = t.server.address().port;
  const get = (path) => new Promise((res, rej) => http.get({ port, host: '127.0.0.1', path }, (r) => {
    let b = '';
    r.on('data', (d) => (b += d));
    r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b }));
  }).on('error', rej));
  try {
    const ok = await get('/play.html');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.match(ok.headers['content-type'], /text\/html/);
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/%00', '//etc/passwd']) {
      const r = await get(p);
      assert.notEqual(r.status, 200, p);
      assert.ok(!r.body.includes('SENTINEL'), p);
    }
  } finally {
    await t.close();
  }
});

test('bad upgrade URL does not crash the server', async () => {
  const t = await boot();
  const port = t.server.address().port;
  try {
    await new Promise((res) => {
      const s = net.connect(port, '127.0.0.1', () => s.write('GET http://[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
      s.on('error', () => {});
      s.on('close', res);
      setTimeout(() => { s.destroy(); res(); }, 500);
    });
    assert.equal((await fetch(`http://127.0.0.1:${port}/play.html`)).status, 200);
  } finally {
    await t.close();
  }
});

test('key rotation after start stores no token', async () => {
  const t = await boot();
  try {
    const h = await t.login('new', 'H');
    const hc = await t.connect(h.key);
    const code = (await hc.until((m) => m.type === 'state')).view.code;
    await t.connect((await t.login(code, 'J')).key);
    const state = await t.loginState(code); // taken while still in the lobby
    hc.send({ type: 'start' });
    await hc.phase('review');
    const r = await t.callback('J', state); // reaches the rotation branch
    assert.equal(r.status, 302);
    const players = [...t.server.rooms.get(code).players.values()];
    assert.equal(players.length, 2);
    for (const p of players) assert.equal(p.token, null);
  } finally {
    await t.close();
  }
});

test('key rotation during start stores no token', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const sp = { ...spotify, fetchPool: async (token, src) => { if (token === 'tok-H') await gate; return spotify.fetchPool(token, src); } };
  const t = await boot(300, { spotify: sp });
  try {
    const h = await t.login('new', 'H');
    const hc = await t.connect(h.key);
    const code = (await hc.until((m) => m.type === 'state')).view.code;
    await t.connect((await t.login(code, 'J')).key);
    const state = await t.loginState(code);
    hc.send({ type: 'start' });
    const room = t.server.rooms.get(code);
    await t.waitStarting(room);
    assert.equal((await t.callback('J', state)).status, 302); // rotation while start awaits pools
    release();
    await hc.phase('review');
    for (const p of room.players.values()) assert.equal(p.token, null);
  } finally {
    release();
    await t.close();
  }
});

test('hung pool fetch times out, names the player, and start can be retried', async () => {
  let hang = true;
  const sp = { ...spotify, fetchPool: (token, src) => (hang && token === 'tok-slow' ? new Promise(() => {}) : spotify.fetchPool(token, src)) };
  const t = await boot(300, { spotify: sp, opts: { fetchTimeoutMs: 100 } });
  try {
    const h = await t.login('new', 'H');
    const hc = await t.connect(h.key);
    const code = (await hc.until((m) => m.type === 'state')).view.code;
    await t.connect((await t.login(code, 'slow')).key);
    hc.send({ type: 'start' });
    assert.match((await hc.err()).message, /Could not load songs for slow/);
    hang = false;
    hc.send({ type: 'start' });
    await hc.phase('review');
  } finally {
    await t.close();
  }
});

// helper: host + joiner in a room, both connected, in lobby
async function pair(t, joiner = 'J') {
  const h = await t.login('new', 'H');
  const hc = await t.connect(h.key);
  const code = (await hc.until((m) => m.type === 'state')).view.code;
  const j = await t.login(code, joiner);
  const jc = await t.connect(j.key);
  await jc.phase('lobby');
  return { h, hc, j, jc, code };
}

test('client websocket path matches the server', async () => {
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const m = /location\.host\s*\+\s*'([^']*)'/.exec(src);
  assert.ok(m, 'client ws url not found');
  assert.equal(m[1], '/ws');
  const t = await boot();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${t.server.address().port}${m[1]}`);
    t.sockets.push(ws);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  } finally {
    await t.close();
  }
});

test('rejoin a started game by room code; strangers are refused; no token kept', async () => {
  const t = await boot();
  try {
    const { hc, code } = await pair(t);
    hc.send({ type: 'start' });
    await hc.phase('review');
    const j2 = await t.login(code, 'J'); // J lost their key
    assert.equal(j2.res.status, 302);
    const jc2 = await t.connect(j2.key);
    assert.equal((await jc2.phase('review')).view.phase, 'review');
    const stranger = await t.login(code, 'S');
    assert.equal(stranger.res.status, 403);
    assert.match(await stranger.res.text(), /already started/);
    for (const p of t.server.rooms.get(code).players.values()) assert.equal(p.token, null);
  } finally {
    await t.close();
  }
});

test('disconnected participant does not block review', async () => {
  const t = await boot();
  try {
    const { hc, jc } = await pair(t);
    hc.send({ type: 'start' });
    await hc.phase('review');
    jc.ws.terminate();
    await hc.until((m) => m.type === 'state' && m.view.players.some((p) => !p.connected));
    hc.send({ type: 'ready' });
    await hc.phase('between');
  } finally {
    await t.close();
  }
});

test('socket closing while everyone else is ready starts the game', async () => {
  const t = await boot();
  try {
    const { hc, jc } = await pair(t);
    hc.send({ type: 'start' });
    await hc.phase('review');
    hc.send({ type: 'ready' });
    await hc.until((m) => m.type === 'state' && m.view.players.find((p) => p.id === 'H').ready);
    jc.ws.terminate();
    await hc.phase('between');
  } finally {
    await t.close();
  }
});

test('server pings websockets', async () => {
  const t = await boot(300, { opts: { pingMs: 50 } });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${t.server.address().port}/ws`);
    t.sockets.push(ws);
    await new Promise((res, rej) => { ws.on('ping', res); ws.on('error', rej); setTimeout(() => rej(new Error('no ping')), 1000); });
  } finally {
    await t.close();
  }
});

test('login state cap evicts oldest instead of refusing', async () => {
  const t = await boot();
  try {
    for (let i = 0; i < 1005; i++) await fetch(`${t.base}/login?room=new`, { redirect: 'manual' });
    assert.equal((await fetch(`${t.base}/login?room=new`, { redirect: 'manual' })).status, 302);
  } finally {
    await t.close();
  }
});

test('settings and joins are refused while starting', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const sp = { ...spotify, fetchPool: async (token, src) => { if (token === 'tok-H') await gate; return spotify.fetchPool(token, src); } };
  const t = await boot(300, { spotify: sp });
  try {
    const { hc, code } = await pair(t);
    const state = await t.loginState(code);
    hc.send({ type: 'start' });
    await t.waitStarting(t.server.rooms.get(code));
    hc.send({ type: 'settings', settings: { perPerson: 3, buffer: 0 } });
    assert.match((await hc.err()).message, /starting/);
    const r = await t.callback('X', state);
    assert.equal(r.status, 409);
    assert.match(await r.text(), /starting/);
    release();
    await hc.phase('review');
  } finally {
    release();
    await t.close();
  }
});

test('security headers on static and error responses', async () => {
  const t = await boot();
  try {
    for (const path of ['/play.html', '/nope.txt', '/callback?state=x']) {
      const r = await fetch(t.base + path);
      assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'none'", path);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
    }
  } finally {
    await t.close();
  }
});

test('review starts when the only ready player reconnects after the other dropped', async () => {
  const t = await boot();
  try {
    const { h, hc, jc } = await pair(t);
    hc.send({ type: 'start' });
    await hc.phase('review');
    hc.send({ type: 'ready' });
    await jc.until((m) => m.type === 'state' && m.view.players.find((p) => p.id === 'H').ready);
    hc.ws.terminate();
    await jc.until((m) => m.type === 'state' && !m.view.players.find((p) => p.id === 'H').connected);
    jc.ws.terminate();
    await new Promise((r) => setTimeout(r, 100));
    const hc2 = await t.connect(h.key);
    await hc2.phase('between');
  } finally {
    await t.close();
  }
});

test('peer that never answers pings is terminated and marked disconnected', async () => {
  const t = await boot(300, { opts: { pingMs: 50 } });
  try {
    const h = await t.login('new', 'H');
    const ws = new WebSocket(`ws://127.0.0.1:${t.server.address().port}/ws`, { autoPong: false });
    t.sockets.push(ws);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', key: h.key }));
    const room = [...t.server.rooms.values()][0];
    const closed = new Promise((r) => ws.on('close', r));
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('not terminated')), 1500))]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(room.game.players.get('H').connected, false);
  } finally {
    await t.close();
  }
});

test('unknown key gets an error then a clean close', async () => {
  const t = await boot();
  try {
    const c = await t.connect();
    const closed = new Promise((r) => c.ws.on('close', (code) => r(code)));
    c.send({ type: 'hello', key: 'nope' });
    assert.match((await c.err()).message, /Unknown key/);
    const code = await Promise.race([closed, new Promise((r) => setTimeout(() => r('timeout'), 1000))]);
    assert.equal(code, 1000);
  } finally {
    await t.close();
  }
});

test('key rotation re-checks readiness', async () => {
  const t = await boot();
  try {
    const { hc, code } = await pair(t);
    hc.send({ type: 'start' });
    await hc.phase('review');
    hc.send({ type: 'ready' });
    await hc.until((m) => m.type === 'state' && m.view.players.find((p) => p.id === 'H').ready);
    await t.login(code, 'J'); // J logs in again; its old socket closes under a deleted key
    await hc.phase('between');
  } finally {
    await t.close();
  }
});

test('dev mode off: addBot is refused', async () => {
  const t = await boot();
  try {
    const h = await t.login('new', 'H');
    const hc = await t.connect(h.key);
    const first = await hc.until((m) => m.type === 'state');
    assert.ok(!first.view.dev);
    hc.send({ type: 'addBot' });
    assert.match((await hc.err()).message, /Dev mode is off/);
    hc.send({ type: 'removeBot' });
    assert.match((await hc.err()).message, /Dev mode is off/);
    assert.equal(t.server.rooms.values().next().value.game.players.size, 1);
  } finally {
    await t.close();
  }
});

test('dev mode: solo host plays a full game with test players', async () => {
  const t = await boot(5000, { opts: { devMode: true, botDelayMs: [10, 40] } });
  try {
    const h = await t.login('new', 'H');
    const hc = await t.connect(h.key);
    const first = await hc.until((m) => m.type === 'state');
    assert.equal(first.view.dev, true);
    const code = first.view.code;
    const room = t.server.rooms.get(code);
    hc.send({ type: 'addBot' });
    hc.send({ type: 'addBot' });
    const s3 = await hc.until((m) => m.type === 'state' && m.view.players.length === 3);
    assert.deepEqual(s3.view.players.map((p) => p.bot), [false, true, true]);
    assert.ok(s3.view.players.every((p) => p.connected));
    hc.send({ type: 'removeBot' });
    await hc.until((m) => m.type === 'state' && m.view.players.length === 2);
    assert.ok(!room.game.players.has('bot:2'));
    hc.send({ type: 'addBot' });
    for (let i = 0; i < 5; i++) hc.send({ type: 'addBot' }); // reaches 8, the 9th is refused
    await hc.until((m) => m.type === 'state' && m.view.players.length === 8);
    hc.send({ type: 'addBot' });
    assert.match((await hc.err()).message, /full/i);
    for (let i = 0; i < 5; i++) hc.send({ type: 'removeBot' });
    await hc.until((m) => m.type === 'state' && m.view.players.length === 3);

    hc.send({ type: 'settings', settings: { perPerson: 2, buffer: 0 } });
    hc.send({ type: 'start' });
    const rv = await hc.phase('review'); // only the host's pool was fetched
    assert.equal(rv.view.myTracks.length, 2);
    hc.send({ type: 'ready' }); // bots are already ready
    await hc.phase('between');

    let rounds = 0;
    for (;;) {
      const t0 = performance.now();
      hc.send({ type: 'play' });
      hc.send({ type: 'guess', playerId: 'bot:1' }); // rejected when the host owns the song
      const rev = await hc.phase('reveal');
      assert.ok(performance.now() - t0 < 2000, 'round should end early once everyone guessed');
      assert.ok(rev.view.reveal.deltas);
      rounds++;
      hc.send({ type: 'next' });
      const nx = await hc.until((m) => m.type === 'state' && (m.view.phase === 'between' || m.view.phase === 'finished'));
      if (nx.view.phase === 'finished') break;
    }
    assert.equal(rounds, 6);
    assert.equal(t.server.rooms.size, 0);
    assert.equal(room.botTimers.size, 0);
  } finally {
    await t.close();
  }
});

test('DEV_MODE entry point refuses public URLs and accepts loopback', async () => {
  const run = (url, port = '0') => spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { PATH: process.env.PATH, DEV_MODE: '1', PUBLIC_URL: url, SPOTIFY_CLIENT_ID: 'x', PORT: port },
  });
  const bad = run('https://example.com');
  let err = '';
  bad.stderr.on('data', (d) => (err += d));
  const code = await new Promise((r) => bad.on('close', r));
  assert.notEqual(code, 0);
  assert.match(err, /dev mode/i);

  const good = run('http://127.0.0.1:0');
  let gerr = '';
  good.stderr.on('data', (d) => (gerr += d));
  const exited = await Promise.race([new Promise((r) => good.on('close', () => r(true))), new Promise((r) => setTimeout(() => r(false), 700))]);
  good.kill();
  assert.equal(exited, false, gerr);
  assert.match(gerr, /DEV MODE ON/);
});

const devOpts = { devMode: true, botDelayMs: [10, 40] };
async function devHost(t, hostPlays = true) {
  const h = await t.login('new', 'H');
  const hc = await t.connect(h.key);
  const code = (await hc.until((m) => m.type === 'state')).view.code;
  if (!hostPlays) { hc.send({ type: 'settings', settings: { hostPlays: false } }); }
  return { h, hc, code, room: t.server.rooms.get(code) };
}
const players = (hc, n) => hc.until((m) => m.type === 'state' && m.view.players.length === n);

test('dev: removeBot after start is refused and keeps state consistent', async () => {
  const t = await boot(5000, { opts: devOpts });
  try {
    const { hc, room } = await devHost(t);
    hc.send({ type: 'addBot' });
    await players(hc, 2);
    hc.send({ type: 'settings', settings: { perPerson: 2, buffer: 0 } });
    hc.send({ type: 'start' });
    await hc.phase('review');
    hc.send({ type: 'ready' });
    await hc.phase('between');
    hc.send({ type: 'removeBot' });
    assert.ok((await hc.err()).message);
    assert.deepEqual(room.bots, ['bot:1']);
    assert.ok(room.game.players.has('bot:1'));
    const t0 = performance.now();
    hc.send({ type: 'play' });
    hc.send({ type: 'guess', playerId: 'bot:1' });
    await hc.until((m) => m.type === 'state' && m.view.phase === 'reveal', 2500);
    assert.ok(performance.now() - t0 < 2000);
  } finally {
    await t.close();
  }
});

test('dev: a bot cannot start the game while the host is disconnected in review', async () => {
  const t = await boot(300, { opts: devOpts });
  try {
    const { h, hc, room } = await devHost(t);
    hc.send({ type: 'addBot' });
    await players(hc, 2);
    hc.send({ type: 'start' });
    await hc.phase('review');
    hc.ws.terminate();
    for (let i = 0; i < 100 && room.game.players.get('H').connected; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(room.game.phase, 'review');
    const hc2 = await t.connect(h.key);
    await hc2.phase('review');
    hc2.send({ type: 'ready' });
    await hc2.phase('between');
  } finally {
    await t.close();
  }
});

test('dev: host who does not play can play with test players to the end', async () => {
  const t = await boot(5000, { opts: devOpts });
  try {
    const { hc, room } = await devHost(t, false);
    hc.send({ type: 'addBot' });
    hc.send({ type: 'addBot' });
    await players(hc, 3);
    hc.send({ type: 'settings', settings: { perPerson: 3, buffer: 0 } });
    hc.send({ type: 'start' });
    await hc.phase('between');
    for (;;) {
      hc.send({ type: 'play' });
      await hc.until((m) => m.type === 'state' && m.view.phase === 'reveal', 2500);
      for (const [id, g] of room.game.guesses) assert.ok(g.id !== 'H' && g.id !== id, 'bot guessed a non-participant or itself');
      hc.send({ type: 'next' });
      const nx = await hc.until((m) => m.type === 'state' && ['between', 'finished'].includes(m.view.phase));
      if (nx.view.phase === 'finished') break;
    }
    assert.equal(t.server.rooms.size, 0);
    assert.equal(room.botTimers.size, 0);
  } finally {
    await t.close();
  }
});

test('dev: too few songs for the test players is a clear error', async () => {
  const sp = { ...spotify, fetchPool: async (token) => (await spotify.fetchPool(token)).slice(0, 3) };
  const t = await boot(300, { spotify: sp, opts: devOpts });
  try {
    const { hc, room } = await devHost(t);
    for (let i = 0; i < 3; i++) hc.send({ type: 'addBot' });
    await players(hc, 4);
    hc.send({ type: 'start' });
    assert.match((await hc.err()).message, /Not enough songs for 3 test players; lower Songs per person or add fewer test players/);
    assert.equal(room.game.phase, 'lobby');
  } finally {
    await t.close();
  }
});

test('join url and qr.svg come from the configured publicUrl, not the Host header', async () => {
  const pub = 'https://game.example.test';
  const t = await boot(300, { opts: { publicUrl: pub + '/' } });
  try {
    const h = await t.login('new', 'H');
    const hc = await t.connect(h.key);
    const view = (await hc.until((m) => m.type === 'state')).view;
    const code = view.code;
    assert.equal(view.joinUrl, `${pub}/login?room=${code}`);
    const getRaw = (path, host) => new Promise((res, rej) => http.get({ port: t.server.address().port, host: '127.0.0.1', path, headers: { Host: host } }, (r) => {
      let b = '';
      r.on('data', (d) => (b += d));
      r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b }));
    }).on('error', rej));
    const a = await getRaw(`/qr.svg?room=${code}`, '127.0.0.1');
    const b = await getRaw(`/qr.svg?room=${code}`, 'evil.example');
    assert.equal(a.status, 200);
    assert.match(a.headers['content-type'], /^image\/svg\+xml/);
    assert.equal(a.headers['cache-control'], 'no-store');
    assert.equal(a.headers['x-content-type-options'], 'nosniff');
    assert.equal(a.headers['set-cookie'], undefined);
    assert.equal(a.body, qrSvg(joinUrl(pub, code)));
    assert.equal(b.body, a.body);
    for (const q of ['room=ZZZZ', `room=${code.toLowerCase()}`, 'room=ABC', 'room=ABCDE', '', `room=${code}%26x%3D1`, `room=${code}&room=${code}x`]) {
      const r = await getRaw('/qr.svg?' + q, '127.0.0.1');
      assert.equal(r.status, 404, q);
    }
  } finally {
    await t.close();
  }
});

test('qr changes when publicUrl changes', async () => {
  const svgFor = async (pub) => {
    const t = await boot(300, { opts: { publicUrl: pub } });
    try {
      const h = await t.login('new', 'H');
      const code = [...t.server.rooms.keys()][0];
      assert.ok(h.key);
      return await (await fetch(`${t.base}/qr.svg?room=${code}`)).text();
    } finally {
      await t.close();
    }
  };
  assert.notEqual(await svgFor('https://a.example.test'), await svgFor('https://b.example.test'));
});

test('dev: shortage check uses the real per-player count', async () => {
  const sp = { ...spotify, fetchPool: async (token) => { const p = await spotify.fetchPool(token); return token === 'tok-low' ? p.slice(0, 3) : p; } };
  const t = await boot(300, { spotify: sp, opts: devOpts });
  try {
    const { hc, code } = await devHost(t);
    await t.connect((await t.login(code, 'low')).key);
    hc.send({ type: 'addBot' });
    hc.send({ type: 'addBot' });
    await players(hc, 4);
    hc.send({ type: 'settings', settings: { perPerson: 25, buffer: 0 } });
    hc.send({ type: 'start' });
    await hc.phase('review'); // per player is 3, so 3 sharers need 9 of the host's 20 songs
  } finally {
    await t.close();
  }
});

test('dev: one test player gets correct grammar in the shortage error', async () => {
  const sp = { ...spotify, fetchPool: async (token) => (await spotify.fetchPool(token)).slice(0, 3) };
  const t = await boot(300, { spotify: sp, opts: devOpts });
  try {
    const { hc } = await devHost(t);
    hc.send({ type: 'addBot' });
    await players(hc, 2);
    hc.send({ type: 'start' });
    assert.match((await hc.err()).message, /for 1 test player; lower/);
  } finally {
    await t.close();
  }
});

test('qr generation failure is a 500 and the server survives', async () => {
  const t = await boot(300, { opts: { publicUrl: 'https://' + 'a'.repeat(3500) + '.example' } });
  try {
    await t.login('new', 'H');
    const code = [...t.server.rooms.keys()][0];
    const r = await fetch(`${t.base}/qr.svg?room=${code}`);
    assert.equal(r.status, 500);
    assert.ok((await r.text()).length > 0);
    assert.equal((await fetch(`${t.base}/play.html`)).status, 200);
  } finally {
    await t.close();
  }
});

// raw client that answers pings itself, after delayMs, with the exact payload
async function slowClient(t, key, delayMs) {
  const ws = new WebSocket(`ws://127.0.0.1:${t.server.address().port}/ws`, { autoPong: false });
  t.sockets.push(ws);
  ws.pings = [];
  ws.on('ping', (d) => { ws.pings.push(d); setTimeout(() => { if (ws.readyState === 1) ws.pong(d); }, delayMs); });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'hello', key }));
  return ws;
}
const serverSocket = (t, code, id) => [...t.server.rooms.get(code).players.values()].find((p) => p.id === id).socket;
async function waitFor(fn, ms = 2000) {
  for (let i = 0; i < ms / 10; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('condition not met');
}

test('rtt is measured from our own ping nonce and cannot be forged', async () => {
  const t = await boot(300, { opts: { pingMs: 60000 } });
  try {
    const h = await t.login('new', 'H');
    const ws = await slowClient(t, h.key, 150);
    const code = [...t.server.rooms.keys()][0];
    await waitFor(() => serverSocket(t, code, 'H')?.rtt >= 140);
    const sock = serverSocket(t, code, 'H');
    const measured = sock.rtt;
    assert.ok(measured < 400, `rtt ${measured}`);
    ws.pong(Buffer.from('forged'));
    ws.pong();
    ws.pong(ws.pings[0]); // replay of an already-used payload
    ws.pong(Buffer.alloc(100, 1));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sock.rtt, measured);
    assert.equal(t.server.rooms.size, 1); // still alive
  } finally {
    await t.close();
  }
});

test('forged pongs alone give no rtt', async () => {
  const t = await boot(300, { opts: { pingMs: 60000 } });
  try {
    const h = await t.login('new', 'H');
    const ws = new WebSocket(`ws://127.0.0.1:${t.server.address().port}/ws`, { autoPong: false });
    t.sockets.push(ws);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', key: h.key }));
    ws.pong('made-up');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(serverSocket(t, [...t.server.rooms.keys()][0], 'H').rtt, 0);
  } finally {
    await t.close();
  }
});

// plays rounds (waiting out the others) until the song is owned by ownerId; returns with that round playing
async function roundOwnedBy(hc, game, ownerId) {
  for (let i = 0; i < 4; i++) {
    const t0 = performance.now();
    hc.send({ type: 'play' });
    await hc.phase('playing');
    if (game.queue[game.round].ownerId === ownerId) return t0;
    await hc.phase('reveal');
    hc.send({ type: 'next' });
    await hc.until((m) => m.type === 'state' && m.view.phase === 'between');
  }
  throw new Error('no such round');
}

test('round stays open a fixed 1100 ms past the nominal duration while a human can guess', async () => {
  const t = await boot(300, { opts: { pingMs: 60000 } });
  try {
    const { hc, jc, code } = await pair(t);
    hc.send({ type: 'settings', settings: { perPerson: 1, buffer: 0 } });
    hc.send({ type: 'start' });
    await hc.phase('review');
    hc.send({ type: 'ready' });
    jc.send({ type: 'ready' });
    await hc.phase('between');
    const game = t.server.rooms.get(code).game;
    for (let round = 0; round < 2; round++) { // each player owns one song, so both kinds of round run
      const t0 = performance.now();
      hc.send({ type: 'play' });
      const pl = await hc.phase('playing');
      assert.ok(pl.view.round.remainingMs <= 300 && pl.view.round.remainingMs > 100);
      assert.equal(pl.view.round.deadline, undefined);
      await hc.phase('reveal');
      const dt = performance.now() - t0;
      assert.ok(dt >= 1300 && dt <= 2000, `closed after ${dt}ms`); // 300 + 1100
      hc.send({ type: 'next' });
      await hc.until((m) => m.type === 'state' && ['between', 'finished'].includes(m.view.phase));
    }
  } finally {
    await t.close();
  }
});

test('dev: rounds with only test players stay short (no grace)', async () => {
  const t = await boot(300, { opts: { devMode: true, botDelayMs: [5000, 6000] } });
  try {
    const { hc } = await devHost(t, false);
    hc.send({ type: 'addBot' });
    hc.send({ type: 'addBot' });
    await players(hc, 3);
    hc.send({ type: 'settings', settings: { perPerson: 1, buffer: 0 } });
    hc.send({ type: 'start' });
    await hc.phase('between');
    const t0 = performance.now();
    hc.send({ type: 'play' });
    await hc.phase('reveal');
    const dt = performance.now() - t0;
    assert.ok(dt >= 280 && dt <= 900, `closed after ${dt}ms`);
  } finally {
    await t.close();
  }
});

test('guesser who connects after Play still gets the fixed grace', async () => {
  const t = await boot(800, { opts: { pingMs: 60000 } });
  try {
    const { hc, jc, j, code } = await pair(t);
    const kc = await t.connect((await t.login(code, 'K')).key);
    await kc.phase('lobby');
    hc.send({ type: 'settings', settings: { perPerson: 1, buffer: 0 } });
    hc.send({ type: 'start' });
    await hc.phase('review');
    hc.send({ type: 'ready' });
    jc.send({ type: 'ready' });
    kc.send({ type: 'ready' });
    await hc.phase('between');
    const game = t.server.rooms.get(code).game;
    jc.ws.terminate();
    await waitFor(() => !game.players.get('J').connected);
    const t0 = await roundOwnedBy(hc, game, 'H');
    const jw = await slowClient(t, j.key, 600);
    jw.msgs = [];
    jw.on('message', (d) => jw.msgs.push(JSON.parse(d)));
    await waitFor(() => serverSocket(t, code, 'J')?.rtt >= 580);
    await new Promise((r) => setTimeout(r, Math.max(0, 800 + 500 - (performance.now() - t0))));
    jw.send(JSON.stringify({ type: 'guess', playerId: 'H' }));
    const rev = await kc.until((m) => m.type === 'state' && m.view.phase === 'reveal' && m.view.reveal.ownerId === 'H'); // skip reveals of earlier rounds
    assert.ok(!jw.msgs.some((m) => m.type === 'error'), JSON.stringify(jw.msgs.filter((m) => m.type === 'error')));
    assert.ok(rev.view.reveal.deltas.J >= 520 && rev.view.reveal.deltas.J <= 600, `J scored ${rev.view.reveal.deltas.J}`); // about 700 of 800 ms compensated
  } finally {
    await t.close();
  }
});

test('high-rtt guess inside the grace window is accepted and scored from compensated elapsed', async () => {
  const t = await boot(600, { opts: { pingMs: 60000 } });
  try {
    const h = await t.login('new', 'H');
    const hc = await t.connect(h.key);
    const code = (await hc.until((m) => m.type === 'state')).view.code;
    const j = await t.login(code, 'J');
    const jw = await slowClient(t, j.key, 300);
    jw.msgs = [];
    jw.on('message', (d) => jw.msgs.push(JSON.parse(d)));
    await waitFor(() => serverSocket(t, code, 'J')?.rtt >= 290);
    hc.send({ type: 'settings', settings: { perPerson: 1, buffer: 0 } });
    hc.send({ type: 'start' });
    await hc.phase('review');
    hc.send({ type: 'ready' });
    jw.send(JSON.stringify({ type: 'ready' }));
    await hc.phase('between');
    const game = t.server.rooms.get(code).game;
    const t0 = await roundOwnedBy(hc, game, 'H');
    await new Promise((r) => setTimeout(r, Math.max(0, 800 - (performance.now() - t0)))); // 200 ms after the nominal end
    jw.send(JSON.stringify({ type: 'guess', playerId: 'H' }));
    const rev = await hc.phase('reveal');
    assert.ok(!jw.msgs.some((m) => m.type === 'error'), JSON.stringify(jw.msgs));
    const d = rev.view.reveal.deltas.J; // about 500 ms compensated of 600 -> about 583
    assert.ok(d >= 540 && d <= 610, `J scored ${d}`);
  } finally {
    await t.close();
  }
});

test('default settings: review view carries keep/removalsLeft and players carry streak', async () => {
  const t = await boot();
  try {
    const { hc } = await pair(t);
    hc.send({ type: 'start' });
    const v = (await hc.phase('review')).view;
    assert.deepEqual(v.settings, { source: 'recents', perPerson: 4, buffer: 1, hostPlays: true });
    assert.equal(v.myTracks.length, 4);
    assert.equal(v.keep, 3);
    assert.equal(v.removalsLeft, 1);
    assert.ok(v.players.every((p) => p.streak === 0));
  } finally {
    await t.close();
  }
});
