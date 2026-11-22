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
});
