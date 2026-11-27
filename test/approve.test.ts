import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ListedBead } from '../src/core/bd.ts';
import { acceptCriteria, approveSpec, criteriaChanged, recordBaseline, requestChanges } from '../src/core/approve.ts';
import { criteriaHash } from '../src/core/criteria-hash.ts';
import { criteriaBaseline, planApprovedAt } from '../src/core/facts.ts';
import { readBinding, writeBinding } from '../src/core/binding.ts';

const CRIT = '- [ ] Plan 404s (check: make test)\n- [ ] Plan lists (check: make test)';
const NOW = new Date('2026-11-23T10:00:00.000Z');
const STORY = 'As a dev, I want plans, so that I can plan';

function bead(id: string, o: Partial<ListedBead> = {}): ListedBead {
  return { id, title: id, status: 'in_progress', priority: 2, issue_type: 'task', labels: [], dependencies: [], description: STORY, ...o };
}

/** In-memory Beads: note appends a line, comment is recorded, acceptance can be edited. */
function fake(initial: ListedBead[]) {
  const rows = new Map(initial.map((b) => [b.id, b]));
  const comments: [string, string][] = [];
  const notes: [string, string][] = [];
  const beads = {
    listAll: async () => [...rows.values()],
    note: async (id: string, text: string) => {
      const b = rows.get(id)!;
      b.notes = b.notes ? `${b.notes}\n${text}` : text;
      notes.push([id, text]);
    },
    comment: async (id: string, text: string) => void comments.push([id, text]),
  };
  return { beads, rows, comments, notes };
}

function ctx(f: ReturnType<typeof fake>, o: { mode?: 'warn' | 'refuse'; build?: number; review?: number } = {}) {
  const trackerDir = mkdtempSync(join(tmpdir(), 'strand-approve-'));
  const config = { trackerDir, wip: { build: o.build ?? 3, review: o.review ?? 3, mode: o.mode ?? 'warn' } };
  return { c: { beads: f.beads, config } as never, trackerDir, done: () => rmSync(trackerDir, { recursive: true, force: true }) };
}

test('approveSpec writes the two note lines once and sets approved on every binding', async () => {
  const f = fake([bead('t-1', { acceptance_criteria: CRIT })]);
  const x = ctx(f);
  try {
    writeBinding(x.trackerDir, 'a', { bead: 't-1' });
    writeBinding(x.trackerDir, 'b', { bead: 't-1' });
    writeBinding(x.trackerDir, 'c', { bead: 't-2' });
    const r = await approveSpec(x.c, 't-1', { by: 'cli', now: NOW });
    assert.deepEqual(r, {});
    assert.deepEqual(f.notes, [
      ['t-1', 'plan-approved 2026-11-23T10:00:00.000Z'],
      ['t-1', `criteria ${criteriaHash(CRIT)}`],
    ]);
    const notes = f.rows.get('t-1')!.notes;
    assert.equal(planApprovedAt(notes), '2026-11-23T10:00:00.000Z');
    assert.equal(criteriaBaseline(notes), criteriaHash(CRIT));
    assert.equal(readBinding(x.trackerDir, 'a').approved, true);
    assert.equal(readBinding(x.trackerDir, 'b').approved, true);
    assert.equal(readBinding(x.trackerDir, 'c').approved, undefined);
    await assert.rejects(approveSpec(x.c, 't-1', { by: 'cli' }), /bead t-1 is already approved/);
    assert.equal(f.notes.length, 2);
  } finally {
    x.done();
  }
});

test('approveSpec throws for a missing bead, a closed bead and an approved bead', async () => {
  const f = fake([bead('t-c', { status: 'closed' }), bead('t-a', { notes: 'plan-approved 2026-01-01T00:00:00Z' })]);
  const x = ctx(f);
  try {
    await assert.rejects(approveSpec(x.c, 't-none', { by: 'cli' }), /bead t-none not found/);
    await assert.rejects(approveSpec(x.c, 't-c', { by: 'cli' }), /bead t-c is closed/);
    await assert.rejects(approveSpec(x.c, 't-a', { by: 'plan' }), /bead t-a is already approved/);
    assert.equal(f.notes.length, 0);
  } finally {
    x.done();
  }
});

test('cli and cockpit check the spec rules and list every problem', async () => {
  const form = 'not in the form "- [ ] <text> (check: <command>)"';
  const f = fake([
    bead('t-free', { acceptance_criteria: 'It works\n- [ ] It is fast\n\n- [ ] It is safe (check: make test)' }),
    bead('t-bare', { description: 'fix it' }),
    bead('t-good', { acceptance_criteria: CRIT }),
    bead('t-chore', { issue_type: 'chore', description: undefined }),
  ]);
  const x = ctx(f);
  try {
    await assert.rejects(approveSpec(x.c, 't-free', { by: 'cockpit' }), (e: Error) => e.message === `2 acceptance lines are ${form}`);
    await assert.rejects(
      approveSpec(x.c, 't-bare', { by: 'cli' }),
      (e: Error) => e.message === 'description must open "As a ..., I want ..., so that ..."; needs at least one acceptance criterion',
    );
    assert.equal(f.notes.length, 0);
    await approveSpec(x.c, 't-good', { by: 'cockpit', now: NOW });
    await approveSpec(x.c, 't-chore', { by: 'cli', now: NOW });
    assert.deepEqual(f.notes.map(([id, n]) => `${id} ${n.split(' ')[0]}`), ['t-good plan-approved', 't-good criteria', 't-chore plan-approved']);
  } finally {
    x.done();
  }
});

test('plan and claim approvals need no criteria, and then write no criteria line', async () => {
  const f = fake([bead('t-1', { description: undefined }), bead('t-2', { description: undefined }), bead('t-3', { acceptance_criteria: 'prose' }), bead('t-4')]);
  const x = ctx(f);
  try {
    await approveSpec(x.c, 't-2', { by: 'plan', now: NOW });
    await approveSpec(x.c, 't-3', { by: 'claim', now: NOW });
    assert.deepEqual(f.notes, [
      ['t-2', 'plan-approved 2026-11-23T10:00:00.000Z'],
      ['t-3', 'plan-approved 2026-11-23T10:00:00.000Z'],
    ]);
  } finally {
    x.done();
  }
});

test('a full Build limit is a warning in warn mode and an error in refuse mode', async () => {
  const busy = () => [
    bead('t-b1', { notes: 'plan-approved 2026-01-01T00:00:00Z', labels: ['branch:x'], acceptance_criteria: '- [ ] a' }),
    bead('t-new', { acceptance_criteria: CRIT }),
  ];
  const f1 = fake(busy());
  const x1 = ctx(f1, { build: 1, mode: 'warn' });
  const f2 = fake(busy());
  const x2 = ctx(f2, { build: 1, mode: 'refuse' });
  try {
    const r = await approveSpec(x1.c, 't-new', { by: 'cli', now: NOW });
    assert.equal(r.warn, 'Build is at its WIP limit (1/1)');
    assert.equal(planApprovedAt(f1.rows.get('t-new')!.notes) !== undefined, true);
    await assert.rejects(approveSpec(x2.c, 't-new', { by: 'cli' }), /Build is at its WIP limit \(1\/1\)/);
    assert.equal(f2.notes.length, 0);
  } finally {
    x1.done();
    x2.done();
  }
});

test('the bead being approved does not count against its own limit', async () => {
  const f = fake([bead('t-1', { acceptance_criteria: CRIT })]);
  const x = ctx(f, { build: 1, mode: 'refuse' });
  try {
    assert.deepEqual(await approveSpec(x.c, 't-1', { by: 'cli', now: NOW }), {});
  } finally {
    x.done();
  }
});

test('criteriaChanged is false after ticking, true after a text edit, false after acceptCriteria', async () => {
  const f = fake([bead('t-1', { acceptance_criteria: CRIT })]);
  const x = ctx(f);
  try {
    assert.equal(criteriaChanged(f.rows.get('t-1')!), false, 'no baseline yet');
    await approveSpec(x.c, 't-1', { by: 'cli', now: NOW });
    const b = f.rows.get('t-1')!;
    assert.equal(criteriaChanged(b), false);
    b.acceptance_criteria = '- [x] Plan 404s (check: make test) (verified: ok)\n- [ ] Plan lists (check: make test)';
    assert.equal(criteriaChanged(b), false, 'ticking does not change the hash');
    b.acceptance_criteria = '- [ ] Plan 404s always (check: make test)\n- [ ] Plan lists (check: make test)';
    assert.equal(criteriaChanged(b), true);
    await acceptCriteria(x.c, 't-1');
    assert.equal(criteriaChanged(b), false);
    assert.equal(criteriaBaseline(b.notes), criteriaHash(b.acceptance_criteria));
  } finally {
    x.done();
  }
});

test('recordBaseline writes once, only when approved and criteria exist', async () => {
  const f = fake([
    bead('t-1', { notes: 'plan-approved 2026-01-01T00:00:00Z', acceptance_criteria: CRIT }),
    bead('t-2', { acceptance_criteria: CRIT }),
    bead('t-3', { notes: 'plan-approved 2026-01-01T00:00:00Z' }),
  ]);
  const x = ctx(f);
  try {
    await recordBaseline(x.c, 't-1');
    await recordBaseline(x.c, 't-1');
    await recordBaseline(x.c, 't-2');
    await recordBaseline(x.c, 't-3');
    assert.deepEqual(f.notes, [['t-1', `criteria ${criteriaHash(CRIT)}`]]);
  } finally {
    x.done();
  }
});

test('approveSpec skips the WIP check for an epic, even in refuse mode at the limit', async () => {
  const f = fake([
    bead('t-b1', { notes: 'plan-approved 2026-01-01T00:00:00Z', acceptance_criteria: '- [ ] a' }),
    bead('t-e', { issue_type: 'epic', acceptance_criteria: CRIT }),
    bead('t-new', { acceptance_criteria: CRIT }),
  ]);
  const x = ctx(f, { build: 1, mode: 'refuse' });
  try {
    assert.deepEqual(await approveSpec(x.c, 't-e', { by: 'plan', now: NOW }), {});
    assert.notEqual(planApprovedAt(f.rows.get('t-e')!.notes), undefined);
    await assert.rejects(approveSpec(x.c, 't-new', { by: 'plan' }), /Build is at its WIP limit \(1\/1\)/);
  } finally {
    x.done();
  }
});

test('acceptCriteria throws unless the bead is open, approved and has criteria', async () => {
  const APPROVED = 'plan-approved 2026-01-01T00:00:00Z';
  const f = fake([
    bead('t-ok', { notes: APPROVED, acceptance_criteria: CRIT }),
    bead('t-closed', { status: 'closed', notes: APPROVED, acceptance_criteria: CRIT }),
    bead('t-unapproved', { acceptance_criteria: CRIT }),
    bead('t-empty', { notes: APPROVED }),
  ]);
  const x = ctx(f);
  try {
    await assert.rejects(acceptCriteria(x.c, 't-closed'), /bead t-closed is closed/);
    await assert.rejects(acceptCriteria(x.c, 't-unapproved'), /bead t-unapproved is not approved/);
    await assert.rejects(acceptCriteria(x.c, 't-empty'), /bead t-empty has no acceptance criteria/);
    assert.equal(f.notes.length, 0);
    await acceptCriteria(x.c, 't-ok');
    assert.deepEqual(f.notes, [['t-ok', `criteria ${criteriaHash(CRIT)}`]]);
  } finally {
    x.done();
  }
});

test('requestChanges comments and checks the note length', async () => {
  const f = fake([bead('t-1')]);
  const x = ctx(f);
  try {
    await requestChanges(x.c, 't-1', 'split the second criterion');
    assert.deepEqual(f.comments, [['t-1', 'changes requested: split the second criterion']]);
    await assert.rejects(requestChanges(x.c, 't-1', ''), /1 to 2000/);
    await assert.rejects(requestChanges(x.c, 't-1', 'x'.repeat(2001)), /1 to 2000/);
    await requestChanges(x.c, 't-1', 'x'.repeat(2000));
    assert.equal(f.comments.length, 2);
  } finally {
    x.done();
  }
});
