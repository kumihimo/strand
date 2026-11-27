import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ListedBead } from '../src/core/bd.ts';
import { deriveStage } from '../src/core/stage.ts';
import { findBead, isWorkItem, loadSnapshot, localFacts, localStage, parentOf, wipOf } from '../src/core/snapshot.ts';
import { beadIdsIn } from '../src/core/facts.ts';

function bead(id: string, over: Partial<ListedBead> = {}): ListedBead {
  return { id, title: id, status: 'open', priority: 2, issue_type: 'task', labels: [], dependencies: [], ...over };
}

const VERIFIED = '- [x] It works (check: npm test) (verified: npm test passed)';
const APPROVED = 'plan-approved 2026-11-01T10:00:00Z';

test('loadSnapshot calls listAll once and sets the prefixes', async () => {
  let calls = 0;
  const s = await loadSnapshot({
    listAll: async () => {
      calls++;
      return [bead('sub-abc'), bead('sub-def')];
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(s.prefixes, ['sub']);
  assert.deepEqual([...s.ids].sort(), ['sub-abc', 'sub-def']);
  assert.equal(s.beads.get('sub-abc')?.id, 'sub-abc');
});

test('loadSnapshot of an empty list has no prefixes', async () => {
  const s = await loadSnapshot({ listAll: async () => [] });
  assert.deepEqual(s.prefixes, []);
  assert.equal(s.beads.size, 0);
});

test('localStage matches deriveStage for a labelled PR bead', () => {
  const b = bead('sub-1', {
    status: 'in_progress',
    notes: APPROVED,
    acceptance_criteria: VERIFIED,
    labels: ['branch:ada/x', 'pr:o/r#7'],
  });
  const f = localFacts(b);
  assert.deepEqual(f, {
    status: 'in_progress',
    planApproved: true,
    verified: true,
    hasBranch: true,
    pr: { state: 'open', ci: 'unknown' },
  });
  assert.equal(localStage(b), 'review');
  assert.equal(localStage(b), deriveStage(f));
});

test('localFacts has no pr without a pr label', () => {
  assert.equal(localFacts(bead('sub-2')).pr, undefined);
  assert.equal(localStage(bead('sub-2')), 'backlog');
});

test('isWorkItem excludes epics, gates and closed beads', () => {
  assert.equal(isWorkItem(bead('a-1')), true);
  assert.equal(isWorkItem(bead('a-2', { issue_type: 'epic' })), false);
  assert.equal(isWorkItem(bead('a-3', { issue_type: 'gate' })), false);
  assert.equal(isWorkItem(bead('a-4', { status: 'closed' })), false);
});

test('wipOf counts build and review, skips held beads, epics and the excluded bead', async () => {
  const building = (id: string, status = 'in_progress') => bead(id, { status, notes: APPROVED });
  const reviewing = (id: string) => bead(id, { status: 'in_progress', notes: APPROVED, acceptance_criteria: VERIFIED, labels: ['pr:o/r#1'] });
  const s = await loadSnapshot({
    listAll: async () => [
      building('a-1'),
      building('a-2'),
      building('a-3', 'blocked'),
      reviewing('a-4'),
      bead('a-5', { issue_type: 'epic', status: 'in_progress', notes: APPROVED }),
    ],
  });
  assert.deepEqual(wipOf(s), { build: 2, review: 1 });
  assert.deepEqual(wipOf(s, 'a-1'), { build: 1, review: 1 });
});

test('wipOf over 500 beads runs under 100 ms', async () => {
  const list = Array.from({ length: 500 }, (_, i) =>
    bead(`g-${i}`, { status: 'in_progress', notes: APPROVED, labels: [`branch:b${i}`] }),
  );
  const s = await loadSnapshot({ listAll: async () => list });
  const t = performance.now();
  const w = wipOf(s);
  assert.ok(performance.now() - t < 100);
  assert.equal(w.build, 500);
});

test('parentOf reads the parent field, else the parent-child dependency', () => {
  assert.equal(parentOf(bead('x-1', { parent: 'x-e' })), 'x-e');
  const deps = [
    { issue_id: 'x-1', depends_on_id: 'x-b', type: 'blocks' },
    { issue_id: 'x-1', depends_on_id: 'x-e', type: 'parent-child' },
  ];
  assert.equal(parentOf(bead('x-1', { dependencies: deps })), 'x-e');
  assert.equal(parentOf(bead('x-1')), undefined);
});

test('a tracker with sdlc- and strand- ids keeps both prefixes and resolves short ids of each', async () => {
  const s = await loadSnapshot({ listAll: async () => [bead('sdlc-cpi.12'), bead('strand-a1b'), bead('sdlc-x9z')] });
  assert.deepEqual(s.prefixes, ['sdlc', 'strand']);
  assert.equal(findBead(s, 'strand-a1b')?.id, 'strand-a1b');
  assert.equal(findBead(s, 'a1b')?.id, 'strand-a1b');
  assert.equal(findBead(s, 'cpi.12')?.id, 'sdlc-cpi.12');
  assert.equal(findBead(s, 'nope'), undefined);
});

test('a short id that two prefixes share resolves to neither', async () => {
  const s = await loadSnapshot({ listAll: async () => [bead('sdlc-abc'), bead('strand-abc')] });
  assert.equal(findBead(s, 'abc'), undefined);
  assert.equal(findBead(s, 'sdlc-abc')?.id, 'sdlc-abc');
});

test('beadIdsIn finds known ids of every prefix', () => {
  const known = new Set(['sdlc-cpi.12', 'strand-a1b']);
  assert.deepEqual(beadIdsIn('fix sdlc-cpi.12 and strand-a1b, not strand-zzz', ['sdlc', 'strand'], known), ['sdlc-cpi.12', 'strand-a1b']);
  assert.deepEqual(beadIdsIn('sdlc-cpi.12', [], known), []);
});
