import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ListedBead } from '../src/core/bd.ts';
import { readBinding, writeBinding } from '../src/core/binding.ts';
import { releaseClaim } from '../src/core/release.ts';

function bead(id: string, o: Partial<ListedBead> = {}): ListedBead {
  return { id, title: id, status: 'in_progress', priority: 2, issue_type: 'task', labels: [], dependencies: [], ...o };
}

function setup(rows: ListedBead[]) {
  const statuses: [string, string][] = [];
  const beads = {
    listAll: async () => rows,
    setStatus: async (id: string, s: string) => void statuses.push([id, s]),
  };
  const trackerDir = mkdtempSync(join(tmpdir(), 'strand-release-'));
  const c = { beads, config: { trackerDir } } as never;
  return { c, statuses, trackerDir, done: () => rmSync(trackerDir, { recursive: true, force: true }) };
}

test('releaseClaim sets the status to open and unbinds every session of that bead only', async () => {
  const x = setup([bead('t-1'), bead('t-2')]);
  try {
    writeBinding(x.trackerDir, 'a', { bead: 't-1', lastStage: 'specify', appTitle: 'keep me' });
    writeBinding(x.trackerDir, 'b', { bead: 't-1', epic: 't-9' });
    writeBinding(x.trackerDir, 'c', { bead: 't-2' });
    writeBinding(x.trackerDir, 'd', { none: true });
    await releaseClaim(x.c, 't-1', { hasLiveTerminal: false });
    assert.deepEqual(x.statuses, [['t-1', 'open']]);
    assert.equal(readBinding(x.trackerDir, 'a').bead, undefined);
    assert.equal(readBinding(x.trackerDir, 'a').lastStage, undefined);
    assert.equal(readBinding(x.trackerDir, 'a').appTitle, 'keep me');
    assert.equal(readBinding(x.trackerDir, 'b').bead, undefined);
    assert.equal(readBinding(x.trackerDir, 'b').epic, 't-9');
    assert.equal(readBinding(x.trackerDir, 'c').bead, 't-2');
    assert.equal(readBinding(x.trackerDir, 'd').none, true);
  } finally {
    x.done();
  }
});

test('releaseClaim clears the bead and its per-bead state, and keeps the rest', async () => {
  const x = setup([bead('t-1')]);
  try {
    writeBinding(x.trackerDir, 'a', {
      bead: 't-1', approved: true, dirty: true, nagged: 'x', lastStage: 'specify', specEditedAt: '2026-11-23T10:00:00.000Z',
      appTitle: 'keep', epic: 't-9', learnAsked: true,
    });
    assert.deepEqual(await releaseClaim(x.c, 't-1', { hasLiveTerminal: false }), { unbound: 1, failed: 0 });
    assert.deepEqual(readBinding(x.trackerDir, 'a'), { appTitle: 'keep', epic: 't-9', learnAsked: true });
  } finally {
    x.done();
  }
});

test('releaseClaim: one binding that cannot be written does not stop the others, and nothing throws', async () => {
  const x = setup([bead('t-1')]);
  // The writer saves to `<file>.<pid>.tmp` first. A directory at that path makes writeFileSync throw EISDIR on every platform.
  const blocker = join(x.trackerDir, '.strand', 'bindings', `b.json.${process.pid}.tmp`);
  try {
    writeBinding(x.trackerDir, 'a', { bead: 't-1' });
    writeBinding(x.trackerDir, 'b', { bead: 't-1' });
    writeBinding(x.trackerDir, 'c', { bead: 't-1' });
    mkdirSync(blocker);
    const r = await releaseClaim(x.c, 't-1', { hasLiveTerminal: false });
    assert.deepEqual(r, { unbound: 2, failed: 1 });
    assert.deepEqual(x.statuses, [['t-1', 'open']]);
    assert.equal(readBinding(x.trackerDir, 'a').bead, undefined);
    assert.equal(readBinding(x.trackerDir, 'b').bead, 't-1');
    assert.equal(readBinding(x.trackerDir, 'c').bead, undefined);
  } finally {
    rmSync(blocker, { recursive: true, force: true });
    x.done();
  }
});

test('releaseClaim: bindings that cannot be listed do not throw after the status write', async () => {
  const x = setup([bead('t-1')]);
  try {
    // A file where the bindings folder should be: readdirSync throws ENOTDIR on every platform.
    mkdirSync(join(x.trackerDir, '.strand'));
    writeFileSync(join(x.trackerDir, '.strand', 'bindings'), 'not a folder');
    assert.deepEqual(await releaseClaim(x.c, 't-1', { hasLiveTerminal: false }), { unbound: 0, failed: 1 });
    assert.deepEqual(x.statuses, [['t-1', 'open']]);
  } finally {
    x.done();
  }
});

test('releaseClaim refuses a bead that is not in Specify, and writes nothing', async () => {
  const x = setup([
    bead('t-open', { status: 'open' }),
    bead('t-build', { notes: 'plan-approved 2026-11-01T10:00:00.000Z' }),
    bead('t-closed', { status: 'closed' }),
    bead('t-held', { status: 'blocked' }),
  ]);
  try {
    writeBinding(x.trackerDir, 'a', { bead: 't-build' });
    for (const id of ['t-open', 't-build', 't-closed', 't-held']) {
      await assert.rejects(releaseClaim(x.c, id, { hasLiveTerminal: false }), new RegExp(`^Error: bead ${id} is not in Specify$`));
    }
    await assert.rejects(releaseClaim(x.c, 't-nope', { hasLiveTerminal: false }), /^Error: bead t-nope not found$/);
    assert.deepEqual(x.statuses, []);
    assert.equal(readBinding(x.trackerDir, 'a').bead, 't-build');
  } finally {
    x.done();
  }
});

test('releaseClaim refuses while a live terminal exists, and writes nothing', async () => {
  const x = setup([bead('t-1')]);
  try {
    writeBinding(x.trackerDir, 'a', { bead: 't-1' });
    await assert.rejects(releaseClaim(x.c, 't-1', { hasLiveTerminal: true }), /^Error: bead t-1 has a live session$/);
    assert.deepEqual(x.statuses, []);
    assert.equal(readBinding(x.trackerDir, 'a').bead, 't-1');
  } finally {
    x.done();
  }
});
