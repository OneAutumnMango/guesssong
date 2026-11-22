import http from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';
import * as realSpotify from './spotify.js';
import { SpotifyError, makePkce, authUrl } from './spotify.js';

const MAX_ROOMS = 20;
const MAX_PENDING = 1000;
const STATE_TTL = 10 * 60 * 1000;
const ABANDON_TTL = 30 * 60 * 1000;
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const HOST_ONLY = new Set(['settings', 'start', 'play', 'next']);
const defaultPublic = fileURLToPath(new URL('../public', import.meta.url));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function createServer({ clientId, publicUrl, spotify = realSpotify, durationMs = 20000, publicDir = defaultPublic, fetchTimeoutMs = 15000, pingMs = 30000 }) {
  const pending = new Map(); // state -> { verifier, room, createdAt }
  const rooms = new Map(); // code -> { game, players: Map<key,{id,token,socket}>, timer, starting, emptySince }
  const redirectUri = publicUrl + '/callback';
  const root = resolve(publicDir);

  const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

  function broadcast(code, room) {
    for (const p of room.players.values()) {
      if (p.socket) send(p.socket, { type: 'state', view: { ...room.game.view(p.id), code } });
    }
    if (room.game.phase === 'finished') { // final state already sent above
      clearTimeout(room.timer);
      rooms.delete(code);
      for (const p of room.players.values()) p.socket?.close(1000);
    }
  }

  function finishRound(code, room) {
    clearTimeout(room.timer);
    if (room.game.phase !== 'playing') return; // guards double endRound
    room.game.endRound();
    broadcast(code, room);
  }

  async function doStart(code, room) {
    if (room.starting) throw new Error('Start already in progress');
    room.starting = true;
    try {
      const { game } = room;
      const ids = game.participants();
      const withTimeout = (p) => {
        let t;
        const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), fetchTimeoutMs); });
        return Promise.race([p, timer]).finally(() => clearTimeout(t));
      };
      const results = await Promise.allSettled(ids.map((id) => {
        const e = [...room.players.values()].find((x) => x.id === id);
        return withTimeout(Promise.resolve().then(() => spotify.fetchPool(e?.token, game.settings.source)));
      }));
      const pools = {};
      for (const [i, id] of ids.entries()) {
        if (results[i].status === 'rejected') throw new Error(`Could not load songs for ${game.players.get(id).name}`);
        pools[id] = results[i].value;
      }
      game.start(pools);
      for (const p of room.players.values()) p.token = null; // tokens never outlive a successful start
    } finally {
      room.starting = false;
    }
  }

  async function onMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return send(ws, { type: 'error', message: 'Bad JSON' }); }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.type !== 'string') {
      return send(ws, { type: 'error', message: 'Bad message' });
    }
    try {
      if (m.type === 'hello') {
        if (typeof m.key !== 'string') throw new Error('Bad key');
        for (const [code, room] of rooms) {
          const p = room.players.get(m.key);
          if (!p) continue;
          const old = p.socket;
          p.socket = ws;
          ws.ctx = { code, room, key: m.key };
          if (old && old !== ws) old.close(1000);
          room.emptySince = null;
          room.game.setConnected(p.id, true);
          return broadcast(code, room);
        }
        throw new Error('Unknown key');
      }
      const ctx = ws.ctx;
      if (!ctx) throw new Error('Say hello first');
      const { code, room } = ctx;
      const { game } = room;
      const me = room.players.get(ctx.key).id;
      if (HOST_ONLY.has(m.type) && me !== game.hostId) throw new Error('Only the host can do that');
      switch (m.type) {
        case 'settings':
          if (room.starting) throw new Error('Game is starting; settings are locked');
          if (!m.settings || typeof m.settings !== 'object' || Array.isArray(m.settings)) throw new Error('Bad settings');
          game.configure(m.settings);
          break;
        case 'start':
          await doStart(code, room);
          break;
        case 'remove':
          if (typeof m.trackId !== 'string') throw new Error('Bad trackId');
          game.removeTrack(me, m.trackId);
          break;
        case 'ready':
          game.setReady(me);
          break;
        case 'play':
          game.beginRound();
          room.timer = setTimeout(() => finishRound(code, room), durationMs);
          break;
        case 'guess':
          if (typeof m.playerId !== 'string' || !game.players.has(m.playerId)) throw new Error('Unknown player');
          if (!game.guess(me, m.playerId)) throw new Error('Guess not accepted');
          if (game.allGuessed()) return finishRound(code, room);
          break;
        case 'next':
          game.next();
          break;
        default:
          throw new Error('Unknown message type');
      }
      broadcast(code, room);
    } catch (e) {
      send(ws, { type: 'error', message: e instanceof Error ? e.message : 'Error' });
    }
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  wss.on('connection', (ws) => {
    ws.on('message', (d) => { onMessage(ws, d.toString()).catch((e) => console.error('ws handler failed:', e?.message)); });
    ws.on('error', () => {});
    const ping = setInterval(() => { if (ws.readyState === 1) ws.ping(); }, pingMs); // keeps proxies from idling the socket out
    ping.unref();
    ws.on('close', () => {
      clearInterval(ping);
      const c = ws.ctx;
      const p = c?.room.players.get(c.key);
      if (!p || p.socket !== ws) return; // replaced by a reconnect
      p.socket = null;
      c.room.game.setConnected(p.id, false);
      try { c.room.game.checkReady(); } catch (e) { console.error('checkReady failed:', e.message); } // a leaver must not stall review
      if (![...c.room.players.values()].some((e) => e.socket)) c.room.emptySince = Date.now();
      if (rooms.get(c.code) === c.room) broadcast(c.code, c.room);
    });
  });

  const page = (res, status, msg) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Guess the Song</title><p>${esc(msg)}</p><p><a href="/">Back</a></p>`);
  };

  async function login(url, res) {
    const room = url.searchParams.get('room') ?? '';
    if (room === 'new') {
      if (rooms.size >= MAX_ROOMS) return page(res, 503, 'The server is full right now. Try again later.');
    } else {
      if (!/^[A-Z]{4}$/.test(room) || !rooms.has(room)) return page(res, 404, 'That room does not exist.');
    }
    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value); // evict oldest so anonymous GETs cannot lock others out
    const state = randomBytes(24).toString('base64url');
    const { verifier, challenge } = makePkce();
    pending.set(state, { verifier, room, createdAt: Date.now() });
    res.writeHead(302, { Location: authUrl({ clientId, redirectUri, state, challenge }) });
    res.end();
  }

  async function callback(url, res) {
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    const p = pending.get(state);
    pending.delete(state); // single use
    if (!p || Date.now() - p.createdAt > STATE_TTL) return page(res, 400, 'Login expired or invalid. Start again from the game page.');
    if (!code) return page(res, 400, 'Spotify did not return a login code (access was denied?).');
    let token, profile;
    try {
      token = await spotify.exchangeCode({ clientId, redirectUri, code, verifier: p.verifier });
      profile = await spotify.fetchProfile(token);
    } catch (e) {
      if (e instanceof SpotifyError && e.status === 403) return page(res, 403, "Your Spotify account isn't on the allowlist; ask the host to add it.");
      return page(res, 502, 'Spotify login failed. Please try again.');
    }
    let roomCode = p.room;
    let room;
    if (roomCode === 'new') {
      if (rooms.size >= MAX_ROOMS) return page(res, 503, 'The server is full right now. Try again later.');
      do { roomCode = Array.from({ length: 4 }, () => LETTERS[randomInt(LETTERS.length)]).join(''); } while (rooms.has(roomCode));
      room = { game: new Game({ durationMs }), players: new Map(), timer: null, starting: false, emptySince: Date.now() };
      rooms.set(roomCode, room);
    } else {
      room = rooms.get(roomCode);
      if (!room) return page(res, 404, 'That room no longer exists.');
    }
    const key = randomBytes(16).toString('hex');
    const existing = [...room.players].find(([, e]) => e.id === profile.id);
    if (existing) { // same Spotify account logging in again: rotate its key
      room.players.delete(existing[0]);
      existing[1].socket?.close(1000);
      const keep = room.game.phase === 'lobby' && !room.starting; // never store a token once start began
      room.players.set(key, { id: profile.id, token: keep ? token : null, socket: null });
      room.game.setConnected(profile.id, false);
    } else {
      if (room.starting) return page(res, 409, 'The host is starting the game; try again in a moment.');
      try {
        room.game.addPlayer(profile.id, profile.name, p.room === 'new');
      } catch (e) {
        if (p.room === 'new') rooms.delete(roomCode);
        return page(res, 403, e.message === 'Room is full' ? 'That room is full.' : 'That room has already started.');
      }
      room.players.set(key, { id: profile.id, token, socket: null });
    }
    res.writeHead(302, { Location: `/play.html#key=${key}` });
    res.end();
  }

  async function serveStatic(url, res) {
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { return page(res, 400, 'Bad request'); }
    if (path.includes('\0')) return page(res, 400, 'Bad request');
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(root, '.' + path);
    if (file !== root && !file.startsWith(root + sep)) return page(res, 404, 'Not found');
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    } catch {
      page(res, 404, 'Not found');
    }
  }

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return page(res, 400, 'Bad request'); }
    const h = req.method === 'GET' || req.method === 'HEAD'
      ? url.pathname === '/login' ? login : url.pathname === '/callback' ? callback : serveStatic
      : null;
    if (!h) return page(res, 405, 'Method not allowed');
    h(url, res).catch((e) => { console.error('request failed:', e?.message); if (!res.headersSent) page(res, 500, 'Server error'); else res.end(); });
  });

  server.on('upgrade', (req, socket, head) => {
    let path;
    try { path = new URL(req.url, 'http://localhost').pathname; } catch { return socket.destroy(); }
    if (path !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [s, p] of pending) if (now - p.createdAt > STATE_TTL) pending.delete(s);
    for (const [code, r] of rooms) {
      if (r.emptySince && now - r.emptySince > ABANDON_TTL) { clearTimeout(r.timer); rooms.delete(code); }
    }
  }, 60000);
  sweep.unref();
  server.on('close', () => {
    clearInterval(sweep);
    for (const r of rooms.values()) clearTimeout(r.timer);
    wss.close();
  });

  server.rooms = rooms; // exposed for tests only; never serialised
  return server;
}

// Entry point: `node src/server.js` reads config from env vars only.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { SPOTIFY_CLIENT_ID, PUBLIC_URL, PORT = '3000' } = process.env;
  if (!SPOTIFY_CLIENT_ID || !PUBLIC_URL) { console.error('SPOTIFY_CLIENT_ID and PUBLIC_URL are required'); process.exit(1); }
  const server = createServer({ clientId: SPOTIFY_CLIENT_ID, publicUrl: PUBLIC_URL.replace(/\/$/, '') }).listen(Number(PORT));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); }); // open websockets would delay close
}
