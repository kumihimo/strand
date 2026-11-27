import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BeadCard } from '../src/cockpit/model.ts';
import { columnsFor } from '../ui/src/lib/format.ts';
import { boardColumns, DEFAULT_VIEW } from '../ui/src/lib/filter.ts';
import { COLUMNS } from '../ui/src/lib/detail.ts';
import { dropVerdict } from '../ui/src/lib/views.ts';
import { canSelectChild, moveBy, selectionNumber, toggleSelection } from '../ui/src/lib/queue.ts';

const card = (o: Partial<BeadCard>): BeadCard => ({
  id: 'b-1', title: 't', type: 'task', priority: 2, status: 'open', stage: 'backlog',
  ready: false, blockedBy: [], live: false, needsYou: false, held: false, awaitingApproval: false, ciUnknown: false, labels: [], context: [], ...o,
});

test('Queued is a column between Backlog and Specify', () => {
  assert.deepEqual(COLUMNS.map((c) => c.key), ['backlog', 'queued', 'specify', 'build', 'verify', 'review', 'done']);
  assert.deepEqual(COLUMNS.find((c) => c.key === 'queued')?.label, 'Queued');
});

test('columnsFor puts queued Backlog cards in Queued, in queue order, not priority order', () => {
  const cards = [card({ id: 'a', priority: 0 }), card({ id: 'b', priority: 1 }), card({ id: 'c', priority: 3 }), card({ id: 'w', stage: 'build' })];
  const cols = columnsFor(cards, ['c', 'a', 'w', 'gone']);
  assert.deepEqual(cols.queued.map((x) => x.id), ['c', 'a']);
  assert.deepEqual(cols.backlog.map((x) => x.id), ['b']);
  // A queued id that is no longer in Backlog stays in its own column: the server drops it on its next tick.
  assert.deepEqual(cols.build.map((x) => x.id), ['w']);
});

test('boardColumns keeps the queue order in Queued whatever the sort', () => {
  const cards = [card({ id: 'a', title: 'a' }), card({ id: 'b', title: 'b' })];
  const cols = boardColumns(cards, { ...DEFAULT_VIEW, sort: 'title', dir: 'asc' }, ['b', 'a']);
  assert.deepEqual(cols.find((c) => c.stage === 'queued')!.shown.map((x) => x.id), ['b', 'a']);
});

test('dropVerdict: Backlog to Queued enqueues, Queued to Backlog dequeues, Queued to Specify starts now', () => {
  const b = card({});
  assert.deepEqual(dropVerdict(b, 'queued', false, false), { ok: true, action: 'enqueue' });
  assert.deepEqual(dropVerdict(b, 'backlog', false, true), { ok: true, action: 'dequeue' });
  assert.deepEqual(dropVerdict(b, 'specify', false, true), { ok: true, action: 'specify' });
  assert.deepEqual(dropVerdict(b, 'queued', false, true), { ok: false, reason: '' });
  assert.deepEqual(dropVerdict(card({ stage: 'specify' }), 'queued', false), { ok: false, reason: 'Only a Backlog bead can be queued.' });
  assert.deepEqual(dropVerdict(card({ held: true, status: 'blocked' }), 'queued', false), { ok: false, reason: 'This bead is on hold.' });
  // A queued card still leaves for Build only by approval.
  assert.equal(dropVerdict(b, 'build', false, true).ok, false);
});

test('toggleSelection keeps the order of ticking; a second tick takes it out', () => {
  let sel: string[] = [];
  sel = toggleSelection(sel, 'c');
  sel = toggleSelection(sel, 'a');
  sel = toggleSelection(sel, 'b');
  assert.deepEqual(sel, ['c', 'a', 'b']);
  sel = toggleSelection(sel, 'a');
  assert.deepEqual(sel, ['c', 'b']);
  assert.equal(selectionNumber(sel, 'b'), 2);
  assert.equal(selectionNumber(sel, 'a'), undefined);
});

test('canSelectChild: Backlog, not on hold, not already queued', () => {
  const queued = new Set(['q']);
  assert.equal(canSelectChild(card({ id: 'x' }), queued), true);
  assert.equal(canSelectChild(card({ id: 'q' }), queued), false);
  assert.equal(canSelectChild(card({ id: 'x', stage: 'specify', status: 'in_progress' }), queued), false);
  assert.equal(canSelectChild(card({ id: 'x', held: true, status: 'blocked' }), queued), false);
  assert.equal(canSelectChild(card({ id: 'x', status: 'closed', stage: 'done' }), queued), false);
});

test('moveBy moves one place up or down and stops at the ends', () => {
  assert.deepEqual(moveBy(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(moveBy(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
  assert.deepEqual(moveBy(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(moveBy(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
});
