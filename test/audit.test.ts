import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBinding } from '../src/core/binding.ts';
import type { ListedBead } from '../src/core/bd.ts';
import type { Snapshot } from '../src/core/snapshot.ts';
import { auditReport } from '../src/core/audit.ts';
import type { StackHead } from '../src/core/audit.ts';
import { parseStackHeads } from '../src/core/but.ts';

function bead(id: string, over: Partial<ListedBead> = {}): ListedBead {
  return { id, title: `title ${id}`, status: 'in_progress', priority: 2, issue_type: 'task', labels: [], dependencies: [], ...over };
}

function snap(list: ListedBead[]): Snapshot {
  return { beads: new Map(list.map((b) => [b.id, b])), ids: new Set(list.map((b) => b.id)), prefixes: ['sub'] };
}

const heads = (h: StackHead[]) => async () => h;

test('parseStackHeads reads appliedStacks[].heads[].name, top first, stacks from 1', () => {
  const json = JSON.stringify({
    appliedStacks: [{ heads: [{ name: 'ada/top' }, { name: 'ada/base' }] }, { heads: [{ name: 'ada/other' }] }],
    unappliedStacks: [{ heads: [{ name: 'ada/off' }] }],
  });
  assert.deepEqual(parseStackHeads(`notice line\n${json}\n`), [
    { stack: 1, name: 'ada/top' },
    { stack: 1, name: 'ada/base' },
    { stack: 2, name: 'ada/other' },
  ]);
  assert.deepEqual(parseStackHeads('{}'), []);
});

test('audit: no applied stacks prints nothing', async () => {
  assert.equal(await auditReport('.', snap([]), { heads: heads([]) }), '');
});

test('audit: a stack that matches its beads reports no drift, and quiet prints nothing', async () => {
  const s = snap([
    bead('sub-aa1', { labels: ['branch:ada/top'], dependencies: [{ issue_id: 'sub-aa1', depends_on_id: 'sub-bb2', type: 'blocks' }] }),
    bead('sub-bb2', { labels: ['branch:ada/base'] }),
  ]);
  const h = heads([
    { stack: 1, name: 'ada/top' },
    { stack: 1, name: 'ada/base' },
  ]);
  assert.equal(await auditReport('.', s, { quiet: true, heads: h }), '');
  assert.equal(
    await auditReport('.', s, { heads: h }),
    [
      'Branches and beads: no drift.',
      'Stack 1 (top first)',
      '  ada/top  WIP: sub-aa1 title sub-aa1  [chat: none]',
      '  ada/base  WIP: sub-bb2 title sub-bb2  [chat: none]',
    ].join('\n'),
  );
});

test('audit: every problem gets a "!" line, and the header counts branches with drift', async () => {
  const s = snap([
    bead('sub-aa1', { labels: ['branch:ada/top'] }),
    bead('sub-bb2', { labels: ['branch:ada/mid', 'branch:ada/dup'] }),
    bead('sub-cc3', { status: 'closed', labels: ['branch:ada/done'] }),
  ]);
  const h = heads([
    { stack: 1, name: 'ada/top' },
    { stack: 1, name: 'ada/mid' },
    { stack: 2, name: 'ada/sub-aa1-fix' },
    { stack: 2, name: 'ada/done' },
    { stack: 3, name: 'ada/dup' },
  ]);
  const out = await auditReport('.', s, { quiet: true, heads: h });
  assert.equal(
    out,
    [
      'Branches and beads: 4 with drift. Fix with but reword, bd update --add-label branch:<name>, bd dep add.',
      'Stack 1 (top first)',
      '  ada/top  WIP: sub-aa1 title sub-aa1  [chat: none]',
      '  ada/mid  WIP: sub-bb2 title sub-bb2  [chat: none]',
      '  ! ada/top sits on ada/mid, but bead sub-aa1 does not depend on sub-bb2',
      'Stack 2 (top first)',
      '  ada/sub-aa1-fix  (no bead)',
      '  ! no bead has label branch:ada/sub-aa1-fix',
      '  ! bead id in the branch name',
      '  ada/done  DONE: sub-cc3 title sub-cc3  [chat: none]',
      '  ! bead sub-cc3 is closed but its branch is not merged',
      'Stack 3 (top first)',
      '  ada/dup  WIP: sub-bb2 title sub-bb2  [chat: none]',
      '  ! bead sub-bb2 also owns ada/mid',
    ].join('\n'),
  );
});

test('audit: the chat column shows the bound session id prefix', async () => {
  const trackerDir = mkdtempSync(join(tmpdir(), 'strand-audit-'));
  try {
    writeBinding(trackerDir, '0123456789abcdef', { bead: 'sub-aa1' });
    const s = snap([bead('sub-aa1', { labels: ['branch:ada/top'] })]);
    const out = await auditReport('.', s, { trackerDir, heads: heads([{ stack: 1, name: 'ada/top' }]) });
    assert.ok(out.includes('  ada/top  WIP: sub-aa1 title sub-aa1  [chat: session 01234567]'), out);
  } finally {
    rmSync(trackerDir, { recursive: true, force: true });
  }
});

test('audit: a failing but call prints nothing', async () => {
  const out = await auditReport('.', snap([]), {
    heads: async () => {
      throw new Error('not a GitButler project');
    },
  });
  assert.equal(out, '');
});
