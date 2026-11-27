import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dequeue, enqueue, freeSlots, move, prune, remove, reorder } from '../src/core/queue.ts';

test('AT-1 enqueue appends in the order given, dequeue takes the front, a duplicate is skipped', () => {
  const q = enqueue([], ['A', 'B', 'C']);
  assert.deepEqual(q, ['A', 'B', 'C']);
  assert.deepEqual(dequeue(q), { id: 'A', rest: ['B', 'C'] });
  assert.deepEqual(enqueue(q, ['B']), ['A', 'B', 'C']);
  // A duplicate inside one call is kept once, at its first place.
  assert.deepEqual(enqueue(['A'], ['C', 'B', 'C']), ['A', 'C', 'B']);
  assert.deepEqual(dequeue([]), { id: undefined, rest: [] });
});

test('enqueue does not change its input', () => {
  const q = ['A'];
  enqueue(q, ['B']);
  assert.deepEqual(q, ['A']);
});

test('AT-2 move and remove edit the order', () => {
  const q = ['A', 'B', 'C'];
  assert.deepEqual(remove(move(q, 'C', 0), 'B'), ['C', 'A']);
  assert.deepEqual(q, ['A', 'B', 'C']);
  // An index past the end puts it last; an id not queued changes nothing.
  assert.deepEqual(move(q, 'A', 99), ['B', 'C', 'A']);
  assert.deepEqual(move(q, 'Z', 0), ['A', 'B', 'C']);
  assert.deepEqual(remove(q, 'Z'), ['A', 'B', 'C']);
  assert.throws(() => move(q, 'A', -1), /index/);
  assert.throws(() => move(q, 'A', 1.5), /index/);
});

test('reorder takes an order of some or all of the queued ids, and nothing else', () => {
  const q = ['A', 'B', 'C'];
  assert.deepEqual(reorder(q, ['C', 'A']), ['C', 'A']);
  assert.deepEqual(reorder(q, []), []);
  assert.throws(() => reorder(q, ['A', 'A']), /more than once/);
  assert.throws(() => reorder(q, ['A', 'Z']), /not queued: Z/);
});

test('prune keeps the ids that pass, in order', () => {
  assert.deepEqual(prune(['A', 'B', 'C'], (id) => id !== 'B'), ['A', 'C']);
});

test('freeSlots is the room left under the limit, never negative', () => {
  assert.equal(freeSlots(0, 3), 3);
  assert.equal(freeSlots(2, 3), 1);
  assert.equal(freeSlots(3, 3), 0);
  assert.equal(freeSlots(5, 3), 0);
});
