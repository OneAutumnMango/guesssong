import test from 'node:test';
import assert from 'node:assert/strict';
import { joinUrl, qrSvg } from '../src/qr.js';

test('joinUrl with and without trailing slash', () => {
  assert.equal(joinUrl('https://x.example/', 'ABCD'), 'https://x.example/login?room=ABCD');
  assert.equal(joinUrl('https://x.example', 'ABCD'), 'https://x.example/login?room=ABCD');
});

test('qrSvg is a deterministic scalable svg with white background', () => {
  const a = qrSvg('https://x.example/login?room=ABCD');
  assert.ok(a.startsWith('<svg'));
  assert.equal(a, qrSvg('https://x.example/login?room=ABCD'));
  assert.notEqual(a, qrSvg('https://x.example/login?room=ABCE'));
  assert.match(a, /viewBox="/);
  assert.match(a, /<rect[^>]*fill="#fff(fff)?"/);
  assert.ok(!/^<svg[^>]* width=/.test(a));
  const size = Number(/viewBox="0 0 (\d+) \d+"/.exec(a)[1]);
  assert.equal((size - 6 - 21) % 4, 0); // module count (21 + 4k) plus a 3-module quiet zone on each side
  assert.ok(a.includes('<path d="M3 3h1v1h-1z')); // first finder-pattern module sits at the quiet-zone offset
  assert.ok(a.includes(`<rect width="${size}" height="${size}" fill="#fff"/>`)); // background covers the quiet zone
});
