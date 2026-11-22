import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression: the hidden Spotify embed was parked off-screen, the browser never loaded its lazy
// iframe, and Play did nothing ("Spotify is slow to load"). Verified against the real embed.
test('hidden Spotify embed stays inside the viewport and is not display:none', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const rule = /\.embed-hidden\s*\{([^}]*)\}/.exec(css)?.[1];
  assert.ok(rule, '.embed-hidden rule exists');
  assert.doesNotMatch(rule, /(left|right|top|bottom)\s*:\s*-/, 'no negative offsets');
  assert.doesNotMatch(rule, /display\s*:\s*none|visibility\s*:\s*hidden/, 'stays rendered');
  assert.match(rule, /opacity\s*:\s*0(\.\d+)?\s*;/, 'invisible via opacity (opacity:0 still loads and plays: tested)');
  assert.match(rule, /pointer-events\s*:\s*none/, 'cannot be clicked');
});
