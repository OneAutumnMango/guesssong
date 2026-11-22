import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../src/server.js';
import { SpotifyError } from '../src/spotify.js';

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
      jc.send({ type, settings: { total: 2 } });
      assert.match((await jc.err()).message, /host/i);
      assert.equal(t.snap(code), lobbySnap, type + ' changed state');
    }
    jc.send('not json');
    await jc.err();
    jc.send({ type: 'bogus' });
    await jc.err();
    hc.send({ type: 'settings', settings: 'x' });
    await hc.err();
    hc.send({ type: 'settings', settings: { total: -1 } });
    assert.match((await hc.err()).message, /Invalid setting/);

    hc.send({ type: 'settings', settings: { total: 4, buffer: 1 } });
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
    const t0 = Date.now();
    hc.send({ type: 'guess', playerId: 'J' });
    jc.send({ type: 'guess', playerId: 'H' });
    await hc.phase('reveal');
    assert.ok(Date.now() - t0 < 250);
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
    const t1 = Date.now();
    hc2.send({ type: 'play' });
    await hc2.phase('reveal');
    const dt = Date.now() - t1;
    assert.ok(dt >= 250 && dt <= 900, `reveal after ${dt}ms`);
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
    hc.send({ type: 'settings', settings: { total: 6 } });
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
