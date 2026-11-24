import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SpotifyError, makePkce, authUrl, exchangeCode, fetchProfile, fetchPool } from '../src/spotify.js';

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const item = (id) => ({ track: { id, name: 'n' + id, artists: [{ name: 'a' + id }, { name: 'b' }] } });

test('makePkce', () => {
  const { verifier, challenge } = makePkce();
  assert.ok(verifier.length >= 43);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
});

test('authUrl', () => {
  const u = authUrl({ clientId: 'c', redirectUri: 'http://x/cb', state: 'st4te', challenge: 'ch' });
  const p = new URL(u).searchParams;
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('state'), 'st4te');
  assert.equal(p.get('scope'), 'user-library-read user-read-recently-played user-top-read');
  assert.equal(p.get('client_id'), 'c');
});

test('exchangeCode', async () => {
  let call;
  const f = async (url, opts) => { call = { url, opts }; return res(200, { access_token: 'tok' }); };
  const t = await exchangeCode({ clientId: 'c', redirectUri: 'r', code: 'cd', verifier: 'v' }, f);
  assert.equal(t, 'tok');
  assert.equal(call.url, 'https://accounts.spotify.com/api/token');
  assert.equal(call.opts.method, 'POST');
  const b = new URLSearchParams(call.opts.body);
  assert.equal(b.get('grant_type'), 'authorization_code');
  assert.equal(b.get('code_verifier'), 'v');
  assert.equal(b.get('client_secret'), null);
});

test('fetchProfile', async () => {
  assert.deepEqual(await fetchProfile('t', async () => res(200, { id: 'i', display_name: 'D' })), { id: 'i', name: 'D' });
  assert.deepEqual(await fetchProfile('t', async () => res(200, { id: 'i', display_name: null })), { id: 'i', name: 'i' });
});

test('fetchPool top', async () => {
  const urls = [];
  const f = async (url) => { urls.push(url); return res(200, { items: [item('1').track, item('2').track, item('1').track] }); };
  const pool = await fetchPool('t', 'top', f);
  assert.match(urls[0], /\/v1\/me\/top\/tracks\?time_range=short_term&limit=50$/);
  assert.deepEqual(pool.map((t) => t.id), ['1', '2']);
  await fetchPool('t', 'top', f, Math.random, { topRange: 'long_term', topLimit: 10 });
  assert.match(urls[1], /time_range=long_term&limit=10$/);
});

test('fetchPool recents', async () => {
  const urls = [];
  const f = async (url, o) => { urls.push(url); assert.equal(o.headers.Authorization, 'Bearer t'); return res(200, { items: [item('1'), item('2'), item('1')] }); };
  const pool = await fetchPool('t', 'recents', f);
  assert.match(urls[0], /\/v1\/me\/player\/recently-played\?limit=50$/);
  assert.deepEqual(pool, [
    { id: '1', uri: 'spotify:track:1', title: 'n1', artist: 'a1, b' },
    { id: '2', uri: 'spotify:track:2', title: 'n2', artist: 'a2, b' },
  ]);
});

test('fetchPool liked samples distinct pages', async () => {
  const urls = [];
  const f = async (url) => {
    urls.push(url);
    if (url.endsWith('limit=1')) return res(200, { total: 400, items: [] });
    const off = Number(new URL(url).searchParams.get('offset'));
    return res(200, { items: [item('t' + off)] });
  };
  const pool = await fetchPool('t', 'liked', f, () => 0.5);
  assert.match(urls[0], /\/v1\/me\/tracks\?limit=1$/);
  const offs = urls.slice(1).map((u) => new URL(u).searchParams.get('offset'));
  assert.equal(offs.length, 5);
  assert.equal(new Set(offs).size, 5);
  offs.forEach((o) => assert.ok(Number(o) % 50 === 0 && Number(o) < 400));
  assert.equal(pool.length, 5);
});

test('fetchPool liked with empty library', async () => {
  assert.deepEqual(await fetchPool('t', 'liked', async () => res(200, { total: 0, items: [] })), []);
});

test('403 throws SpotifyError', async () => {
  const f = async () => res(403, { error: 'no' });
  for (const p of [
    exchangeCode({ clientId: 'c', redirectUri: 'r', code: 'c', verifier: 'v' }, f),
    fetchProfile('secret-token', f),
    fetchPool('secret-token', 'recents', f),
  ]) {
    await assert.rejects(p, (e) => e instanceof SpotifyError && e.status === 403 && !e.message.includes('secret-token'));
  }
});

test('exchangeCode without access_token throws 502', async () => {
  await assert.rejects(exchangeCode({ clientId: 'c', redirectUri: 'r', code: 'c', verifier: 'v' }, async () => res(200, {})),
    (e) => e instanceof SpotifyError && e.status === 502);
});

test('malformed JSON on 2xx throws SpotifyError', async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); }, text: async () => '' });
  await assert.rejects(fetchProfile('t', f), (e) => e instanceof SpotifyError && e.status === 200);
});

test('fetchPool tolerates sparse data', async () => {
  const f = async () => res(200, { items: [{ track: { id: '1', name: 'n' } }, { track: null }, null, { track: { name: 'noid' } }] });
  assert.deepEqual(await fetchPool('t', 'recents', f), [{ id: '1', uri: 'spotify:track:1', title: 'n', artist: '' }]);
  const g = async (url) => (url.endsWith('limit=1') ? res(200, { total: 100 }) : res(200, {}));
  assert.deepEqual(await fetchPool('t', 'liked', g), []);
});
