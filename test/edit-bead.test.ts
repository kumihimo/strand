import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bead } from '../src/core/bd.ts';
import { criteriaHash } from '../src/core/criteria-hash.ts';
import { criteriaChanged } from '../src/core/approve.ts';
import { StaleEditError, beadVersion, editBead } from '../src/core/edit-bead.ts';
import { mergeAcceptance, mergeCriteria } from '../src/core/facts.ts';
import { readBinding, writeBinding } from '../src/core/binding.ts';

const STORY = 'As a dev, I want x, so that y';
const NOW = new Date('2026-11-23T10:00:00.000Z');
const V1 = '2026-11-23T09:00:00Z';

test('mergeCriteria keeps tick and evidence for an unchanged criterion', () => {
  const old = '- [x] One (check: a) (verified: a passed)\n- [ ] Two (check: b)';
  assert.equal(mergeCriteria(old, '- [ ] One (check: a)\n- [ ] Two (check: b)'), '- [x] One (check: a) (verified: a passed)\n- [ ] Two (check: b)');
});

test('mergeCriteria unticks a reworded criterion and one whose check changed', () => {
  const old = '- [x] One (check: a) (verified: ok)\n- [x] Two (check: b) (verified: ok)';
  assert.equal(mergeCriteria(old, '- [ ] One reworded (check: a)\n- [ ] Two (check: c)'), '- [ ] One reworded (check: a)\n- [ ] Two (check: c)');
});

test('mergeCriteria keeps ticks under reordering and whitespace changes, and starts a new criterion unticked', () => {
  const old = '- [x] One thing (check: a b) (verified: ok1)\n- [x] Two (check: b) (verified: ok2)';
  const merged = mergeCriteria(old, '- [ ]   Two   (check:  b )\n- [ ] Brand new (check: n)\n* [ ] One   thing (check: a   b)');
  assert.equal(merged, '- [x] Two (check: b) (verified: ok2)\n- [ ] Brand new (check: n)\n- [x] One thing (check: a b) (verified: ok1)');
});

test('mergeCriteria drops prose lines, omits a missing check, and handles no old text', () => {
  assert.equal(mergeCriteria(undefined, 'Some intro\n- [ ] Only text\n\nmore prose'), '- [ ] Only text');
  assert.equal(mergeCriteria('', ''), '');
});

test('mergeCriteria matches a ticked criterion without evidence and uses each old criterion once', () => {
  const old = '- [x] Same (check: a)\n- [x] Same (check: a) (verified: second)';
  assert.equal(mergeCriteria(old, '- [ ] Same (check: a)\n- [ ] Same (check: a)\n- [ ] Same (check: a)'), '- [x] Same (check: a)\n- [x] Same (check: a) (verified: second)\n- [ ] Same (check: a)');
});

type Row = Bead & { parent?: string };
const CRIT = '- [x] One (check: a) (verified: ok)\n- [ ] Two (check: b)';

function row(o: Partial<Row> = {}): Row {
  return { id: 't-1', title: 'Title', status: 'in_progress', priority: 2, issue_type: 'task', labels: [], dependencies: [], description: STORY, acceptance_criteria: CRIT, parent: 't-e', updated_at: V1, ...o };
}

/** In-memory Beads: update, note and comment bump updated_at like bd does. */
function fake(initial: Row) {
  const state = { row: initial, tick: 0 };
  const calls: { op: string; args: unknown[] }[] = [];
  const bump = () => {
    state.tick++;
    state.row.updated_at = `2026-11-23T09:00:${String(state.tick).padStart(2, '0')}Z`;
  };
  const beads = {
    show: async (id: string) => {
      calls.push({ op: 'show', args: [id] });
      return structuredClone(state.row);
    },
    update: async (id: string, f: Record<string, unknown>) => {
      calls.push({ op: 'update', args: [id, f] });
      const r = state.row;
      if (f.title !== undefined) r.title = f.title as string;
      if (f.description !== undefined) r.description = f.description as string;
      if (f.acceptance !== undefined) r.acceptance_criteria = f.acceptance as string;
      if (f.design !== undefined) r.design = f.design as string;
      if (f.type !== undefined) r.issue_type = f.type as string;
      if (f.priority !== undefined) r.priority = f.priority as number;
      if (f.parent !== undefined) r.parent = f.parent as string;
      const remove = (f.removeLabels ?? []) as string[];
      r.labels = [...r.labels.filter((l) => !remove.includes(l)), ...((f.addLabels ?? []) as string[])];
      bump();
    },
    note: async (id: string, text: string) => {
      calls.push({ op: 'note', args: [id, text] });
      state.row.notes = state.row.notes ? `${state.row.notes}\n${text}` : text;
      bump();
    },
    comment: async (id: string, text: string) => {
      calls.push({ op: 'comment', args: [id, text] });
      bump();
    },
  };
  const writes = () => calls.filter((c) => c.op !== 'show');
  /** The version a form opened now would carry. */
  const ver = () => beadVersion(state.row);
  return { beads, state, calls, writes, ver };
}

function ctxFor(f: ReturnType<typeof fake>) {
  const trackerDir = mkdtempSync(join(tmpdir(), 'strand-edit-'));
  return { c: { beads: f.beads, config: { trackerDir } } as never, trackerDir, done: () => rmSync(trackerDir, { recursive: true, force: true }) };
}

test('a stale version throws StaleEditError with the current bead and writes nothing', async () => {
  const f = fake(row());
  const x = ctxFor(f);
  try {
    await assert.rejects(editBead(x.c, 't-1', { title: 'New' }, { version: '2026-11-23T08:00:00Z' }), (e: unknown) => {
      assert.ok(e instanceof StaleEditError);
      assert.equal(e.current.id, 't-1');
      assert.equal(e.current.updated_at, V1);
      return true;
    });
    assert.deepEqual(f.writes(), []);
  } finally {
    x.done();
  }
});

test('a closed bead throws and writes nothing', async () => {
  const f = fake(row({ status: 'closed' }));
  const x = ctxFor(f);
  try {
    await assert.rejects(editBead(x.c, 't-1', { title: 'New' }, { version: f.ver() }), /^Error: bead t-1 is closed$/);
    assert.deepEqual(f.writes(), []);
  } finally {
    x.done();
  }
});

const APPROVED = 'plan-approved 2026-11-01T10:00:00.000Z';

test('after approval a spec problem in the result throws the first message and writes nothing', async () => {
  const f = fake(row({ notes: APPROVED }));
  const x = ctxFor(f);
  try {
    await assert.rejects(editBead(x.c, 't-1', { title: 'x'.repeat(61) }, { version: f.ver() }), /^Error: title is over 60 characters$/);
    await assert.rejects(editBead(x.c, 't-1', { description: 'just a note' }, { version: f.ver() }), /^Error: description must open/);
    await assert.rejects(editBead(x.c, 't-1', { acceptance: '- [ ] no check here' }, { version: f.ver() }), /^Error: 1 acceptance line is not in the form/);
    await assert.rejects(editBead(x.c, 't-1', { acceptance: '' }, { version: f.ver() }), /^Error: needs at least one acceptance criterion$/);
    await assert.rejects(editBead(x.c, 't-1', { acceptance: 'It should be fast' }, { version: f.ver() }), /^Error: criterion must start "- \[ \] ": It should be fast$/);
    assert.deepEqual(f.writes(), []);
  } finally {
    x.done();
  }
});

test('before approval only the title and parent rules apply, and the acceptance text is stored as typed', async () => {
  const f = fake(row({ description: '' }));
  const x = ctxFor(f);
  try {
    await assert.rejects(editBead(x.c, 't-1', { title: 'x'.repeat(61) }, { version: f.ver() }), /^Error: title is over 60 characters$/);
    const typed = 'Notes first\n- [ ] One (check: a)\n- [ ] no check yet\nit should be fast';
    const r = await editBead(x.c, 't-1', { description: 'just a note', acceptance: typed }, { version: f.ver() });
    assert.deepEqual(r.changed, ['description', 'acceptance']);
    // The unchanged criterion keeps its tick and evidence; everything else is as typed.
    assert.equal(f.state.row.acceptance_criteria, 'Notes first\n- [x] One (check: a) (verified: ok)\n- [ ] no check yet\nit should be fast');
    const again = await editBead(x.c, 't-1', { acceptance: '' }, { version: f.ver() });
    assert.deepEqual(again.changed, ['acceptance']);
  } finally {
    x.done();
  }
});

test('repos: the edit replaces the repo and context labels in one update, other labels stay', async () => {
  const f = fake(row({ labels: ['repo:app', 'context:old', 'keep-me'] }));
  const x = ctxFor(f);
  const known = ['app', 'docs', 'lib', 'old'];
  try {
    const r = await editBead(x.c, 't-1', { repo: 'app', context: ['docs', 'lib', 'docs', 'app'] }, { version: f.ver(), known });
    assert.deepEqual(r.changed, ['repos']);
    assert.deepEqual(f.writes(), [{ op: 'update', args: ['t-1', { addLabels: ['context:docs', 'context:lib'], removeLabels: ['context:old'] }] }]);
    assert.deepEqual([...f.state.row.labels].sort(), ['context:docs', 'context:lib', 'keep-me', 'repo:app']);
    const same = await editBead(x.c, 't-1', { repo: 'app', context: ['lib', 'docs'] }, { version: f.ver(), known });
    assert.deepEqual(same.changed, []);
    const cleared = await editBead(x.c, 't-1', { repo: '', context: [] }, { version: f.ver(), known });
    assert.deepEqual(cleared.changed, ['repos']);
    assert.deepEqual(f.state.row.labels, ['keep-me']);
  } finally {
    x.done();
  }
});

test('repos: an unknown name, context without a primary, and a primary change with a branch are refused', async () => {
  const f = fake(row({ labels: ['repo:app', 'branch:ada/x'], notes: APPROVED }));
  const x = ctxFor(f);
  const known = ['app', 'docs', 'lib'];
  try {
    await assert.rejects(editBead(x.c, 't-1', { repo: 'app', context: ['nope'] }, { version: f.ver(), known }), /^Error: unknown repo nope$/);
    await assert.rejects(editBead(x.c, 't-1', { repo: '', context: ['docs'] }, { version: f.ver(), known }), /^Error: a bead with context folders needs a primary repo$/);
    await assert.rejects(editBead(x.c, 't-1', { repo: 'lib' }, { version: f.ver(), known }), /^Error: bead t-1 has a branch in app$/);
    await assert.rejects(editBead(x.c, 't-1', { repo: '../x' }, { version: f.ver(), known }), /^Error: invalid repo name \.\.\/x$/);
    assert.deepEqual(f.writes(), []);
    // Context folders may change after approval and with a branch.
    const r = await editBead(x.c, 't-1', { context: ['docs'] }, { version: f.ver(), known });
    assert.deepEqual(r.changed, ['repos']);
    assert.deepEqual(f.writes(), [{ op: 'update', args: ['t-1', { addLabels: ['context:docs'] }] }]);
  } finally {
    x.done();
  }
});

test('repos: a bead whose folders have gone can change its context and its primary; only added names are checked', async () => {
  const f = fake(row({ labels: ['repo:gone', 'context:old'] }));
  const x = ctxFor(f);
  const known = ['app', 'docs'];
  try {
    await assert.rejects(editBead(x.c, 't-1', { context: ['old', 'nope'] }, { version: f.ver(), known }), /^Error: unknown repo nope$/);
    const ctx = await editBead(x.c, 't-1', { context: ['old', 'docs'] }, { version: f.ver(), known });
    assert.deepEqual(ctx.changed, ['repos']);
    const moved = await editBead(x.c, 't-1', { repo: 'app', context: ['docs'] }, { version: f.ver(), known });
    assert.deepEqual(moved.changed, ['repos']);
    assert.deepEqual([...f.state.row.labels].sort(), ['context:docs', 'repo:app']);
  } finally {
    x.done();
  }
});

test('repos: an approved bead whose spec breaks a rule can still change only its repos', async () => {
  const f = fake(row({ notes: APPROVED, description: 'no story', labels: ['repo:app'] }));
  const x = ctxFor(f);
  try {
    const r = await editBead(x.c, 't-1', { repo: 'app', context: ['docs'] }, { version: f.ver(), known: ['app', 'docs'] });
    assert.deepEqual(r.changed, ['repos']);
    // The spec rules judge the spec fields only: a title edit is not held back by an older description.
    const t = await editBead(x.c, 't-1', { title: 'Other' }, { version: f.ver() });
    assert.deepEqual(t.changed, ['title']);
    await assert.rejects(editBead(x.c, 't-1', { description: 'still no story' }, { version: f.ver() }), /^Error: description must open/);
  } finally {
    x.done();
  }
});

// The skill's tick format: the check is replaced by the evidence.
const TICKED = '- [x] One (verified: npm test passed)\n- [x] Two (verified: make lint passed)';

test('an approved bead ticked in the skill format saves a priority, title or spec body edit, ticks and evidence kept', async () => {
  const f = fake(row({ notes: APPROVED, acceptance_criteria: TICKED }));
  const x = ctxFor(f);
  try {
    for (const edit of [{ priority: 1 }, { title: 'Renamed' }, { design: 'More detail' }, { parent: 't-f' }]) {
      const r = await editBead(x.c, 't-1', edit, { version: f.ver() });
      assert.equal(r.changed.length, 1, JSON.stringify(edit));
    }
    assert.equal(f.state.row.acceptance_criteria, TICKED);
  } finally {
    x.done();
  }
});

test('an approved bead ticked in the skill format saves a description edit', async () => {
  const f = fake(row({ notes: APPROVED, acceptance_criteria: TICKED }));
  const x = ctxFor(f);
  try {
    const r = await editBead(x.c, 't-1', { description: `${STORY}, now with more` }, { version: f.ver() });
    assert.deepEqual(r.changed, ['description']);
    assert.equal(f.state.row.acceptance_criteria, TICKED);
  } finally {
    x.done();
  }
});

test('mergeAcceptance keeps prose lines as typed and ticks on unchanged criteria', () => {
  const old = '- [x] One (check: a) (verified: ok)';
  assert.equal(mergeAcceptance(old, 'intro\r\n- [ ]  One (check: a)\n\n- [ ] Two'), 'intro\n- [x] One (check: a) (verified: ok)\n\n- [ ] Two');
});

test('bad field values are refused before any write', async () => {
  const f = fake(row());
  const x = ctxFor(f);
  try {
    await assert.rejects(editBead(x.c, 't-1', { priority: 9 }, { version: f.ver() }), /^Error: invalid priority/);
    await assert.rejects(editBead(x.c, 't-1', { type: '-t' }, { version: f.ver() }), /^Error: invalid type/);
    await assert.rejects(editBead(x.c, 't-1', { parent: '--x' }, { version: f.ver() }), /^Error: invalid parent/);
    await assert.rejects(editBead(x.c, 't-1', { title: '  ' }, { version: f.ver() }), /^Error: title is required/);
    assert.deepEqual(f.writes(), []);
  } finally {
    x.done();
  }
});

test('no change writes nothing, and a whitespace-only save of the criteria is no change', async () => {
  const f = fake(row());
  const x = ctxFor(f);
  try {
    writeBinding(x.trackerDir, 'a', { bead: 't-1' });
    const same = await editBead(x.c, 't-1', { title: 'Title', priority: 2, parent: 't-e', acceptance: '- [ ]  One   (check: a)\n- [ ] Two (check:  b)' }, { version: f.ver() });
    assert.deepEqual(same.changed, []);
    assert.equal(same.rebaselined, false);
    assert.equal(same.bead.updated_at, V1);
    assert.deepEqual(f.writes(), []);
    assert.equal(readBinding(x.trackerDir, 'a').specEditedAt, undefined);
  } finally {
    x.done();
  }
});

test('an edit before approval makes one update call, no comment and no note', async () => {
  const f = fake(row());
  const x = ctxFor(f);
  try {
    const r = await editBead(x.c, 't-1', { title: 'New title', acceptance: '- [ ] One (check: a)\n- [ ] Three (check: c)' }, { version: f.ver(), now: NOW });
    assert.deepEqual(r.changed, ['title', 'acceptance']);
    assert.equal(r.rebaselined, false);
    assert.deepEqual(f.writes(), [{ op: 'update', args: ['t-1', { title: 'New title', acceptance: '- [x] One (check: a) (verified: ok)\n- [ ] Three (check: c)' }] }]);
    assert.equal(r.bead.title, 'New title');
  } finally {
    x.done();
  }
});

test('an edit after approval that changes a criterion writes the baseline note and the comment', async () => {
  const f = fake(row({ notes: 'plan-approved 2026-11-01T10:00:00.000Z\ncriteria deadbeef' }));
  const x = ctxFor(f);
  try {
    const r = await editBead(x.c, 't-1', { title: 'Other', acceptance: '- [ ] One (check: a)\n- [ ] Three (check: c)' }, { version: f.ver() });
    assert.equal(r.rebaselined, true);
    assert.deepEqual(r.changed, ['title', 'acceptance']);
    const after = '- [x] One (check: a) (verified: ok)\n- [ ] Three (check: c)';
    assert.deepEqual(f.writes().map((c) => c.op), ['update', 'note', 'comment']);
    assert.deepEqual(f.writes()[1]!.args, ['t-1', `criteria ${criteriaHash(after)}`]);
    assert.deepEqual(f.writes()[2]!.args, ['t-1', 'spec edited in the cockpit: title, acceptance']);
  } finally {
    x.done();
  }
});

test('an edit after approval that changes only the title writes no note and no comment', async () => {
  const f = fake(row({ notes: 'plan-approved 2026-11-01T10:00:00.000Z' }));
  const x = ctxFor(f);
  try {
    const r = await editBead(x.c, 't-1', { title: 'Renamed' }, { version: f.ver() });
    assert.equal(r.rebaselined, false);
    assert.deepEqual(f.writes().map((c) => c.op), ['update']);
  } finally {
    x.done();
  }
});

test('reordering criteria on an approved bead is a criteria change, because the hash is over the texts in order', async () => {
  const f = fake(row({ notes: 'plan-approved 2026-11-01T10:00:00.000Z' }));
  const x = ctxFor(f);
  try {
    const r = await editBead(x.c, 't-1', { acceptance: '- [ ] Two (check: b)\n- [ ] One (check: a)' }, { version: f.ver() });
    assert.equal(r.rebaselined, true);
  } finally {
    x.done();
  }
});

test('every binding of the bead gets specEditedAt, others are left alone', async () => {
  const f = fake(row());
  const x = ctxFor(f);
  try {
    writeBinding(x.trackerDir, 'a', { bead: 't-1', lastStage: 'build' });
    writeBinding(x.trackerDir, 'b', { bead: 't-1' });
    writeBinding(x.trackerDir, 'c', { bead: 't-2' });
    await editBead(x.c, 't-1', { priority: 1 }, { version: f.ver(), now: NOW });
    assert.equal(readBinding(x.trackerDir, 'a').specEditedAt, '2026-11-23T10:00:00.000Z');
    assert.equal(readBinding(x.trackerDir, 'a').lastStage, 'build');
    assert.equal(readBinding(x.trackerDir, 'b').specEditedAt, '2026-11-23T10:00:00.000Z');
    assert.equal(readBinding(x.trackerDir, 'c').specEditedAt, undefined);
  } finally {
    x.done();
  }
});

test('beadVersion: updated_at plus a fingerprint of the editable fields, ticks included', () => {
  const a = row();
  assert.match(beadVersion(a), /^2026-11-23T09:00:00Z:[0-9a-f]{12}$/);
  assert.equal(beadVersion(a), beadVersion(row()));
  for (const o of [{ title: 'T2' }, { description: 'd' }, { acceptance_criteria: CRIT.replace('- [ ] Two', '- [x] Two') }, { design: 'x' }, { issue_type: 'bug' }, { priority: 0 }, { parent: 't-z' }] as Partial<Row>[]) {
    assert.notEqual(beadVersion(row(o)), beadVersion(a), JSON.stringify(o));
  }
  assert.equal(beadVersion(row({ parent: undefined, dependencies: [{ id: 't-e', issue_type: 'epic', status: 'open', dependency_type: 'parent-child' }] })), beadVersion(a), 'parent from the dependency');
});

test('same updated_at but a different title is stale, and nothing is written', async () => {
  const f = fake(row());
  const x = ctxFor(f);
  try {
    const opened = f.ver();
    f.state.row.title = 'Changed in the same second';
    await assert.rejects(editBead(x.c, 't-1', { priority: 1 }, { version: opened }), StaleEditError);
    assert.deepEqual(f.writes(), []);
  } finally {
    x.done();
  }
});

test('a tick written in the same second makes the form stale', async () => {
  const f = fake(row());
  const x = ctxFor(f);
  try {
    const opened = f.ver();
    f.state.row.acceptance_criteria = CRIT.replace('- [ ] Two (check: b)', '- [x] Two (check: b) (verified: ok)');
    await assert.rejects(editBead(x.c, 't-1', { priority: 1 }, { version: opened }), StaleEditError);
  } finally {
    x.done();
  }
});

test('after approval a mistyped criterion line is refused, not dropped; a blank line between criteria is fine', async () => {
  const f = fake(row({ notes: APPROVED }));
  const x = ctxFor(f);
  try {
    await assert.rejects(editBead(x.c, 't-1', { acceptance: '- [ ] One (check: a)\n- [] typo (check: b)' }, { version: f.ver() }), /^Error: criterion must start "- \[ \] ": - \[\] typo \(check: b\)$/);
    await assert.rejects(editBead(x.c, 't-1', { acceptance: '- [ ] One (check: a)\n1. Totals match (check: a)' }, { version: f.ver() }), /^Error: criterion must start "- \[ \] ": 1\. Totals match/);
    assert.deepEqual(f.writes(), []);
    const r = await editBead(x.c, 't-1', { acceptance: '- [ ] One (check: a)\n\n- [ ] Two (check: b)\n   \n- [ ] Three (check: c)' }, { version: f.ver() });
    assert.deepEqual(r.changed, ['acceptance']);
  } finally {
    x.done();
  }
});

test('after approval a mistyped line is refused for a chore too', async () => {
  const f = fake(row({ issue_type: 'chore', notes: APPROVED }));
  const x = ctxFor(f);
  try {
    await assert.rejects(editBead(x.c, 't-1', { acceptance: '- [] typo' }, { version: f.ver() }), /^Error: criterion must start/);
    assert.deepEqual(f.writes(), []);
  } finally {
    x.done();
  }
});

test('bindings are told straight after the update; a failing note returns a warning instead of throwing', async () => {
  const f = fake(row({ notes: 'plan-approved 2026-11-01T10:00:00.000Z' }));
  f.beads.note = async () => {
    throw new Error('disk full');
  };
  const x = ctxFor(f);
  try {
    writeBinding(x.trackerDir, 'a', { bead: 't-1' });
    const r = await editBead(x.c, 't-1', { acceptance: '- [ ] One (check: a)\n- [ ] Three (check: c)' }, { version: f.ver(), now: NOW });
    assert.equal(r.warning, 'Saved. The criteria baseline or the comment was not recorded: disk full');
    assert.equal(r.rebaselined, false);
    assert.deepEqual(r.changed, ['acceptance']);
    assert.equal(readBinding(x.trackerDir, 'a').specEditedAt, '2026-11-23T10:00:00.000Z');
    assert.deepEqual(f.writes().map((c) => c.op), ['update']);
  } finally {
    x.done();
  }
});

test('a binding that cannot be written after the update returns a warning, and the baseline and comment still run', async () => {
  const f = fake(row({ notes: 'plan-approved 2026-11-01T10:00:00.000Z' }));
  const x = ctxFor(f);
  try {
    writeBinding(x.trackerDir, 'a', { bead: 't-1' });
    // A folder where the temp file goes makes the binding write fail.
    mkdirSync(join(x.trackerDir, '.strand', 'bindings', `a.json.${process.pid}.tmp`));
    const r = await editBead(x.c, 't-1', { acceptance: '- [ ] One (check: a)\n- [ ] Three (check: c)' }, { version: f.ver() });
    assert.match(r.warning ?? '', /^Saved\. A session bound to this bead was not told of the edit: /);
    assert.equal(r.rebaselined, true);
    assert.deepEqual(f.writes().map((c) => c.op), ['update', 'note', 'comment']);
  } finally {
    x.done();
  }
});

test('a failing comment after the note returns a warning, and the baseline stays written', async () => {
  const f = fake(row({ notes: 'plan-approved 2026-11-01T10:00:00.000Z' }));
  f.beads.comment = async () => {
    throw new Error('locked');
  };
  const x = ctxFor(f);
  try {
    const r = await editBead(x.c, 't-1', { acceptance: '- [ ] One (check: a)\n- [ ] Three (check: c)' }, { version: f.ver() });
    assert.equal(r.rebaselined, true);
    assert.match(r.warning ?? '', /: locked$/);
  } finally {
    x.done();
  }
});

test('a check-only change on an approved bead writes the comment and no new baseline', async () => {
  const f = fake(row({ notes: 'plan-approved 2026-11-01T10:00:00.000Z' }));
  const x = ctxFor(f);
  try {
    const r = await editBead(x.c, 't-1', { acceptance: '- [ ] One (check: other)\n- [ ] Two (check: b)' }, { version: f.ver() });
    assert.equal(r.rebaselined, false);
    assert.deepEqual(f.writes().map((c) => c.op), ['update', 'comment']);
    assert.deepEqual(f.writes()[1]!.args, ['t-1', 'spec edited in the cockpit: acceptance']);
  } finally {
    x.done();
  }
});

test('removing every criterion of an approved chore records the empty baseline and writes the comment', async () => {
  const f = fake(row({ issue_type: 'chore', notes: 'plan-approved 2026-11-01T10:00:00.000Z\ncriteria deadbeef' }));
  const x = ctxFor(f);
  try {
    const r = await editBead(x.c, 't-1', { acceptance: '' }, { version: f.ver() });
    assert.deepEqual(r.changed, ['acceptance']);
    assert.equal(r.rebaselined, true);
    assert.deepEqual(f.writes().map((c) => c.op), ['update', 'note', 'comment']);
    // The hooks no longer see a criteria change.
    assert.equal(criteriaChanged(f.state.row), false);
  } finally {
    x.done();
  }
});

test('adding a criterion on an approved bead is a baseline change and a comment', async () => {
  const f = fake(row({ notes: 'plan-approved 2026-11-01T10:00:00.000Z' }));
  const x = ctxFor(f);
  try {
    const r = await editBead(x.c, 't-1', { acceptance: `${CRIT}\n- [ ] Three (check: c)` }, { version: f.ver() });
    assert.equal(r.rebaselined, true);
    assert.deepEqual(f.writes().map((c) => c.op), ['update', 'note', 'comment']);
  } finally {
    x.done();
  }
});
