import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ring } from '../src/cockpit/ring.ts';

test('under the limit keeps everything in order', () => {
  const r = new Ring(10);
  r.push(Buffer.from('abc'));
  r.push(Buffer.from('def'));
  assert.equal(r.bytes, 6);
  assert.equal(r.snapshot().toString(), 'abcdef');
});

test('over the limit drops the oldest bytes', () => {
  const r = new Ring(5);
  r.push(Buffer.from('abc'));
  r.push(Buffer.from('defg'));
  assert.equal(r.bytes, 5);
  assert.equal(r.snapshot().toString(), 'cdefg');
});

test('one chunk larger than the limit keeps only its tail', () => {
  const r = new Ring(4);
  r.push(Buffer.from('xy'));
  r.push(Buffer.from('0123456789'));
  assert.equal(r.bytes, 4);
  assert.equal(r.snapshot().toString(), '6789');
});

test('snapshot is a copy: later pushes do not change it', () => {
  const r = new Ring(8);
  r.push(Buffer.from('ab'));
  const s = r.snapshot();
  r.push(Buffer.from('cd'));
  assert.equal(s.toString(), 'ab');
});

test('wrapping around the end keeps order', () => {
  const r = new Ring(6);
  r.push(Buffer.from('abcd'));
  r.push(Buffer.from('efgh'));
  assert.equal(r.snapshot().toString(), 'cdefgh');
  r.push(Buffer.from('ij'));
  assert.equal(r.snapshot().toString(), 'efghij');
});

test('200,000 one-byte pushes keep the last bytes and hold the bound', () => {
  const r = new Ring(1000);
  for (let i = 0; i < 200_000; i++) r.push(Buffer.from([i % 251]));
  assert.equal(r.bytes, 1000);
  const s = r.snapshot();
  assert.equal(s.length, 1000);
  for (let k = 0; k < 1000; k++) assert.equal(s[k], (199_000 + k) % 251);
});

test('an empty ring snapshots to an empty buffer', () => {
  const r = new Ring(8);
  assert.equal(r.bytes, 0);
  assert.equal(r.snapshot().length, 0);
});
