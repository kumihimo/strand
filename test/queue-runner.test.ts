import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ListedBead } from '../src/core/bd.ts';
import { readQueue, writeQueue } from '../src/core/queue-store.ts';
import { TerminalLimitError, type TerminalInfo, type TerminalMode } from '../src/cockpit/pty.ts';
import { WorkQueue, queueable } from '../src/cockpit/queue-runner.ts';

const APPROVED = 'plan-approved 2026-11-27T10:00:00Z';

function bead(id: string, status: string, extra: Partial<ListedBead> = {}): ListedBead {
  return { id, title: id, status, priority: 2, issue_type: 'task', labels: ['repo:app'], dependencies: [], ...extra };
}

type Started = { beadId: string; cwd: string; mode: TerminalMode };

/** A WorkQueue over fakes: the beads, the terminals and the comments are plain values the test controls. */
function harness(beads: ListedBead[], queue: string[], o: { limit?: number; startFails?: (id: string) => Error | undefined } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'strand-runner-')), 'queue.json');
  writeQueue(file, queue);
  const state = { beads: new Map(beads.map((b) => [b.id, b])) };
  const started: Started[] = [];
  const terms: TerminalInfo[] = [];
  const comments: { id: string; text: string }[] = [];
  let changed = 0;
  const wq = new WorkQueue({
    file,
    limit: () => o.limit ?? 3,
    beads: async () => state.beads,
    cwdFor: (b) => {
      if (!b.labels.includes('repo:app')) throw new Error(`bead ${b.id} has no repo: label`);
      return `/ws/app`;
    },
    terminals: {
      list: () => terms.map((t) => ({ ...t })),
      start: (s) => {
        const err = o.startFails?.(s.beadId);
        if (err) throw err;
        started.push({ beadId: s.beadId, cwd: s.cwd, mode: s.mode });
        const t: TerminalInfo = { id: `t-${s.beadId}`, beadId: s.beadId, mode: s.mode, startedAt: '2026-11-27T10:00:00Z' };
        terms.push(t);
        return t;
      },
    },
    comment: async (id, text) => void comments.push({ id, text }),
    onChange: () => changed++,
    warn: () => {},
  });
  return { wq, file, state, started, terms, comments, changes: () => changed };
}

test('queueable is an open, unapproved, unheld bead', () => {
  assert.equal(queueable(bead('a', 'open')), true);
  assert.equal(queueable(bead('a', 'in_progress')), false);
  assert.equal(queueable(bead('a', 'closed')), false);
  assert.equal(queueable(bead('a', 'blocked')), false);
  assert.equal(queueable(bead('a', 'deferred')), false);
  assert.equal(queueable(bead('a', 'open', { notes: APPROVED })), false);
});

test('AT-4 with 2 in progress, a tick starts only the front bead, in specify mode, in its repo folder', async () => {
  const h = harness([bead('w1', 'in_progress'), bead('w2', 'in_progress'), bead('A', 'open'), bead('B', 'open')], ['A', 'B']);
  assert.deepEqual(await h.wq.tick(), ['A']);
  assert.deepEqual(h.started, [{ beadId: 'A', cwd: '/ws/app', mode: 'specify' }]);
  assert.deepEqual(readQueue(h.file), ['B']);
  assert.deepEqual(h.wq.ids(), ['B']);
  assert.ok(h.changes() > 0);
});

test('AT-4 with nothing in progress, a tick fills every slot, front first', async () => {
  const h = harness(['A', 'B', 'C', 'D'].map((id) => bead(id, 'open')), ['C', 'A', 'D', 'B']);
  assert.deepEqual(await h.wq.tick(), ['C', 'A', 'D']);
  assert.deepEqual(h.wq.ids(), ['B']);
});

test('AT-5 with 3 in progress nothing starts; once one leaves in_progress the front bead starts. Held beads do not count', async () => {
  const h = harness(
    [bead('w1', 'in_progress'), bead('w2', 'in_progress'), bead('w3', 'in_progress'), bead('h1', 'blocked'), bead('h2', 'deferred'), bead('A', 'open')],
    ['A'],
  );
  assert.deepEqual(await h.wq.tick(), []);
  assert.deepEqual(h.started, []);
  assert.deepEqual(h.wq.ids(), ['A']);
  h.state.beads.set('w2', bead('w2', 'closed'));
  assert.deepEqual(await h.wq.tick(), ['A']);
  assert.deepEqual(h.wq.ids(), []);
});

test('AT-5 the limit is read on every tick', async () => {
  let limit = 1;
  const h = harness([bead('w1', 'in_progress'), bead('A', 'open')], ['A']);
  const wq = new WorkQueue({ ...h.wq.deps, limit: () => limit });
  assert.deepEqual(await wq.tick(), []);
  limit = 2;
  assert.deepEqual(await wq.tick(), ['A']);
});

test('AT-6 a started but unclaimed bead counts as in progress, so no extra bead starts', async () => {
  const h = harness([bead('w1', 'in_progress'), bead('w2', 'in_progress'), bead('A', 'open'), bead('B', 'open')], ['A', 'B']);
  assert.deepEqual(await h.wq.tick(), ['A']);
  // The hook has not claimed A yet: it is still open in Beads, but its terminal is live.
  assert.deepEqual(await h.wq.tick(), []);
  assert.deepEqual(h.wq.ids(), ['B']);
  // A terminal that exited does not hold a slot.
  h.terms[0].exited = { code: 0, at: '2026-11-27T10:05:00Z' };
  assert.deepEqual(await h.wq.tick(), ['B']);
});

test('AT-6 a live terminal of a bead already in progress is not counted twice', async () => {
  const h = harness([bead('w1', 'in_progress'), bead('w2', 'in_progress'), bead('A', 'open')], ['A']);
  h.terms.push({ id: 't1', beadId: 'w1', mode: 'work', startedAt: '2026-11-27T10:00:00Z' });
  assert.deepEqual(await h.wq.tick(), ['A']);
});

test('AT-7 a queued bead no longer in Backlog is dropped and not started', async () => {
  const h = harness(
    [bead('claimed', 'in_progress'), bead('closed', 'closed'), bead('held', 'blocked'), bead('approved', 'open', { notes: APPROVED }), bead('A', 'open')],
    ['gone', 'claimed', 'closed', 'held', 'approved', 'A'],
    { limit: 5 },
  );
  assert.deepEqual(await h.wq.tick(), ['A']);
  assert.deepEqual(h.started.map((s) => s.beadId), ['A']);
  assert.deepEqual(readQueue(h.file), []);
});

test('AT-7 dropping beads that left Backlog happens even when there is no room', async () => {
  const h = harness([bead('w1', 'in_progress'), bead('A', 'closed'), bead('B', 'open')], ['A', 'B'], { limit: 1 });
  assert.deepEqual(await h.wq.tick(), []);
  assert.deepEqual(h.wq.ids(), ['B']);
});

test('AT-8 a failed start removes the bead, comments the reason, and tries the next', async () => {
  const h = harness([bead('A', 'open', { labels: [] }), bead('B', 'open')], ['A', 'B'], { limit: 1 });
  assert.deepEqual(await h.wq.tick(), ['B']);
  assert.deepEqual(h.comments, [{ id: 'A', text: 'queue: could not start: bead A has no repo: label' }]);
  assert.deepEqual(h.wq.ids(), []);
});

test('AT-8 a spawn error is a failed start too', async () => {
  const h = harness([bead('A', 'open'), bead('B', 'open')], ['A', 'B'], { limit: 1, startFails: (id) => (id === 'A' ? new Error('spawn failed') : undefined) });
  assert.deepEqual(await h.wq.tick(), ['B']);
  assert.deepEqual(h.comments, [{ id: 'A', text: 'queue: could not start: spawn failed' }]);
});

test('the terminal cap is not a failed start: the bead stays at the front and the tick stops', async () => {
  const h = harness([bead('A', 'open'), bead('B', 'open')], ['A', 'B'], { startFails: () => new TerminalLimitError(4) });
  assert.deepEqual(await h.wq.tick(), []);
  assert.deepEqual(h.wq.ids(), ['A', 'B']);
  assert.deepEqual(h.comments, []);
});

test('a comment that fails does not stop the queue', async () => {
  const h = harness([bead('A', 'open', { labels: [] }), bead('B', 'open')], ['A', 'B'], { limit: 1 });
  const wq = new WorkQueue({ ...h.wq.deps, comment: async () => Promise.reject(new Error('bd down')) });
  assert.deepEqual(await wq.tick(), ['B']);
});

test('a Beads outage skips the tick and keeps the queue', async () => {
  const h = harness([bead('A', 'open')], ['A']);
  const wq = new WorkQueue({ ...h.wq.deps, beads: async () => Promise.reject(new Error('bd down')) });
  assert.deepEqual(await wq.tick(), []);
  assert.deepEqual(wq.ids(), ['A']);
});

test('ticks never overlap: a second tick waits for the first', async () => {
  const h = harness([bead('A', 'open'), bead('B', 'open')], ['A', 'B'], { limit: 1 });
  const [a, b] = await Promise.all([h.wq.tick(), h.wq.tick()]);
  // The second tick sees A's live terminal, so it starts nothing.
  assert.deepEqual([a, b], [['A'], []]);
  assert.deepEqual(h.started.map((s) => s.beadId), ['A']);
});

test('add, reorder and remove edit the stored queue; add takes Backlog beads only', async () => {
  const h = harness([bead('A', 'open'), bead('B', 'open'), bead('C', 'open'), bead('W', 'in_progress')], [], { limit: 0 });
  assert.deepEqual(await h.wq.add(['B', 'A']), { ids: ['B', 'A'] });
  await assert.rejects(h.wq.add(['C', 'W']), (e: Error & { code?: string }) => e.code === 'not-backlog' && /W is not in Backlog/.test(e.message));
  await assert.rejects(h.wq.add(['nope']), (e: Error & { code?: string }) => e.code === 'not-found');
  assert.deepEqual(h.wq.ids(), ['B', 'A']);
  assert.deepEqual(await h.wq.add(['C', 'B']), { ids: ['B', 'A', 'C'] });
  assert.deepEqual(await h.wq.setOrder(['C', 'B']), { ids: ['C', 'B'] });
  await assert.rejects(h.wq.setOrder(['A']), (e: Error & { code?: string }) => e.code === 'bad-order');
  assert.deepEqual(await h.wq.remove('C'), { ids: ['B'] });
  assert.deepEqual(readQueue(h.file), ['B']);
});

test('an edit ticks the queue at once', async () => {
  const h = harness([bead('A', 'open')], []);
  await h.wq.add(['A']);
  await h.wq.idle();
  assert.deepEqual(h.started.map((s) => s.beadId), ['A']);
});

test('after stop(), a tick starts nothing; start() resumes', async () => {
  const h = harness([bead('A', 'open')], ['A']);
  h.wq.stop();
  assert.deepEqual(await h.wq.tick(), []);
  assert.deepEqual(h.wq.ids(), ['A']);
  h.wq.start(60_000);
  await h.wq.idle();
  h.wq.stop();
  assert.deepEqual(h.started.map((s) => s.beadId), ['A']);
});
