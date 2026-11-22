import { randomBytes, createHash } from 'node:crypto';

const SCOPE = 'user-library-read user-read-recently-played';
const API = 'https://api.spotify.com/v1';

export class SpotifyError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'SpotifyError';
    this.status = status;
  }
}

export function makePkce() {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authUrl({ clientId, redirectUri, state, challenge }) {
  const p = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    scope: SCOPE, state, code_challenge_method: 'S256', code_challenge: challenge,
  });
  return 'https://accounts.spotify.com/authorize?' + p;
}

// Never put the token or Authorization header in errors; only the response body.
async function call(fetchFn, url, opts) {
  const r = await fetchFn(url, opts);
  if (!r.ok) throw new SpotifyError(r.status, await r.text());
  try {
    return await r.json();
  } catch {
    throw new SpotifyError(r.status, 'invalid JSON');
  }
}

export async function exchangeCode({ clientId, redirectUri, code, verifier }, fetchFn = fetch) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: clientId, code_verifier: verifier,
  });
  const j = await call(fetchFn, 'https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!j.access_token) throw new SpotifyError(502, 'no access_token in token response');
  return j.access_token;
}

const get = (token, path, fetchFn) => call(fetchFn, API + path, { headers: { Authorization: `Bearer ${token}` } });

export async function fetchProfile(token, fetchFn = fetch) {
  const j = await get(token, '/me', fetchFn);
  return { id: j.id, name: j.display_name || j.id };
}

const toTracks = (items) => {
  const seen = new Map();
  for (const t of (items ?? []).map((i) => i?.track)) {
    if (t && t.id && !seen.has(t.id)) {
      seen.set(t.id, { id: t.id, uri: 'spotify:track:' + t.id, title: t.name, artist: (t.artists ?? []).map((a) => a.name).join(', ') });
    }
  }
  return [...seen.values()];
};

export async function fetchPool(token, source, fetchFn = fetch, rng = Math.random) {
  if (source === 'recents') {
    return toTracks((await get(token, '/me/player/recently-played?limit=50', fetchFn)).items);
  }
  const { total } = await get(token, '/me/tracks?limit=1', fetchFn);
  const pages = Array.from({ length: Math.ceil(total / 50) }, (_, i) => i);
  for (let i = pages.length - 1; i > 0; i--) { // Fisher-Yates, then take 5
    const j = Math.floor(rng() * (i + 1));
    [pages[i], pages[j]] = [pages[j], pages[i]];
  }
  const got = await Promise.all(pages.slice(0, 5).map((p) => get(token, `/me/tracks?limit=50&offset=${p * 50}`, fetchFn)));
  return toTracks(got.flatMap((g) => g.items ?? []));
}
