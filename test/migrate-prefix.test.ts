import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Beads, ListedBead } from '../src/core/bd.ts';
import { applyPrefixMigration, normalisePrefix, planPrefixMigration } from '../src/core/migrate-prefix.ts';
import { main } from '../src/cli/commands/migrate-prefix.ts';
import type { Ctx } from '../src/cli/ctx.ts';

const bead = (id: string): ListedBead => ({
  id,
  title: `title ${id}`,
  status: 'open',
  priority: 2,
  issue_type: 'task',
  labels: [],
  dependencies: [],
});

const json = (file: string, v: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(v, null, 2) + '\n');
};
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

/** Every file under `dir`, relative, with its bytes: a rerun must leave this unchanged. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/** A tracker holding one of each id-keyed file, in `.strand/` and in the legacy `.sdlc/`, plus files to leave alone. */
function tracker(): string {
  const t = mkdtempSync(path.join(tmpdir(), 'strand-prefix-'));
  mkdirSync(path.join(t, 'artefacts', 'sdlc-cpi.13', 'sessions'), { recursive: true });
  writeFileSync(path.join(t, 'artefacts', 'sdlc-cpi.13', 'mock.png'), 'png');
  mkdirSync(path.join(t, 'artefacts', 'sdlcx-1'), { recursive: true });
  mkdirSync(path.join(t, 'artefacts', 'strand-a1'), { recursive: true });
  writeFileSync(path.join(t, 'artefacts', 'sdlc-file'), 'not a folder');
  json(path.join(t, '.strand', 'sessions', 's1.json'), {
    sessionId: 's1', beadId: 'sdlc-cpi.13', startedAt: '2026-11-25T10:00:00Z', branch: 'ada/x', replaces: 's0',
  });
  json(path.join(t, '.sdlc', 'sessions', 's0.json'), { sessionId: 's0', beadId: 'sdlc-a1', startedAt: '2026-11-20T10:00:00Z' });
  json(path.join(t, '.strand', 'sessions', 's2.json'), { sessionId: 's2', beadId: 'strand-b2', startedAt: '2026-11-25T11:00:00Z' });
  json(path.join(t, '.strand', 'bindings', 's1.json'), { bead: 'sdlc-cpi.13', epic: 'sdlc-cpi', approved: true, handoverFrom: 's0' });
  json(path.join(t, '.sdlc', 'bindings', 's0.json'), { bead: 'sdlc-a1' });
  json(path.join(t, '.strand', 'bindings', 's3.json'), { none: true });
  json(path.join(t, '.strand', 'bindings', 'handover-0123456789ab.json'), {
    cwd: '/ws/strand', bead: 'sdlc-cpi.13', epic: 'sdlc-cpi', at: '2026-11-25T12:00:00Z', from: 's1',
  });
  json(path.join(t, '.strand', 'sessions', 'broken.json'), { beadId: 42 });
  writeFileSync(path.join(t, '.strand', 'bindings', 'junk.json'), '{ not json');
  return t;
}

const changesOf = (t: string) => planPrefixMigration(t, 'sdlc', 'strand');

test('prefixes are taken with or without the trailing dash, and a bad or looping pair is refused', () => {
  assert.equal(normalisePrefix('sdlc'), 'sdlc');
  assert.equal(normalisePrefix('sdlc-'), 'sdlc');
  for (const bad of ['', '-', 'a/b', 'a\\b', '..', 'a b', 'sdlc--']) {
    assert.throws(() => normalisePrefix(bad), /invalid prefix/, bad);
  }
  const t = tracker();
  assert.throws(() => planPrefixMigration(t, 'sdlc', 'sdlc'), /same/);
  // sdlc -> sdlc-x would rename sdlc-x-a again on every rerun.
  assert.throws(() => planPrefixMigration(t, 'sdlc', 'sdlc-x'), /starts with/);
});

test('a dry run lists every artefacts folder, session index entry, binding and handover that names an old id', () => {
  const t = tracker();
  const before = tree(t);
  const plan = changesOf(t);
  assert.equal(plan.from, 'sdlc');
  assert.equal(plan.to, 'strand');
  assert.deepEqual(
    plan.items.map((i) => [i.kind, i.path, i.ids]),
    [
      ['artefacts', path.join('artefacts', 'sdlc-cpi.13'), [{ field: 'folder', from: 'sdlc-cpi.13', to: 'strand-cpi.13' }]],
      ['session', path.join('.sdlc', 'sessions', 's0.json'), [{ field: 'beadId', from: 'sdlc-a1', to: 'strand-a1' }]],
      ['session', path.join('.strand', 'sessions', 's1.json'), [{ field: 'beadId', from: 'sdlc-cpi.13', to: 'strand-cpi.13' }]],
      // Bindings and handovers share a folder and come in file-name order.
      [
        'handover',
        path.join('.strand', 'bindings', 'handover-0123456789ab.json'),
        [
          { field: 'bead', from: 'sdlc-cpi.13', to: 'strand-cpi.13' },
          { field: 'epic', from: 'sdlc-cpi', to: 'strand-cpi' },
        ],
      ],
      ['binding', path.join('.sdlc', 'bindings', 's0.json'), [{ field: 'bead', from: 'sdlc-a1', to: 'strand-a1' }]],
      [
        'binding',
        path.join('.strand', 'bindings', 's1.json'),
        [
          { field: 'bead', from: 'sdlc-cpi.13', to: 'strand-cpi.13' },
          { field: 'epic', from: 'sdlc-cpi', to: 'strand-cpi' },
        ],
      ],
    ],
  );
  assert.deepEqual(plan.conflicts, [], 'artefacts/strand-a1 exists, but no sdlc-a1 folder wants that name');
  assert.deepEqual(tree(t), before, 'planning writes nothing');
});

test('a .sdlc/ item hidden by the same name in .strand/ is not listed: readers never see it', () => {
  const t = tracker();
  json(path.join(t, '.sdlc', 'bindings', 's1.json'), { bead: 'sdlc-old' });
  const listed = changesOf(t).items.filter((i) => i.kind === 'binding').map((i) => i.path);
  assert.deepEqual(listed, [path.join('.sdlc', 'bindings', 's0.json'), path.join('.strand', 'bindings', 's1.json')]);
});

test('with --apply each one is moved or rewritten to the new id, and a rerun changes nothing', () => {
  const t = tracker();
  const done = applyPrefixMigration(t, changesOf(t));
  assert.equal(done.applied, 6);

  assert.ok(!existsSync(path.join(t, 'artefacts', 'sdlc-cpi.13')));
  assert.equal(readFileSync(path.join(t, 'artefacts', 'strand-cpi.13', 'mock.png'), 'utf8'), 'png');
  assert.ok(existsSync(path.join(t, 'artefacts', 'strand-cpi.13', 'sessions')));
  assert.ok(existsSync(path.join(t, 'artefacts', 'sdlcx-1')), 'another prefix is left alone');

  assert.deepEqual(read(path.join(t, '.strand', 'sessions', 's1.json')), {
    sessionId: 's1', beadId: 'strand-cpi.13', startedAt: '2026-11-25T10:00:00Z', branch: 'ada/x', replaces: 's0',
  });
  assert.deepEqual(read(path.join(t, '.strand', 'bindings', 's1.json')), {
    bead: 'strand-cpi.13', epic: 'strand-cpi', approved: true, handoverFrom: 's0',
  });
  assert.deepEqual(read(path.join(t, '.strand', 'bindings', 'handover-0123456789ab.json')), {
    cwd: '/ws/strand', bead: 'strand-cpi.13', epic: 'strand-cpi', at: '2026-11-25T12:00:00Z', from: 's1',
  });
  // A legacy item is written to .strand/ and its .sdlc/ copy removed.
  assert.deepEqual(read(path.join(t, '.strand', 'sessions', 's0.json')), {
    sessionId: 's0', beadId: 'strand-a1', startedAt: '2026-11-20T10:00:00Z',
  });
  assert.deepEqual(read(path.join(t, '.strand', 'bindings', 's0.json')), { bead: 'strand-a1' });
  assert.ok(!existsSync(path.join(t, '.sdlc', 'sessions', 's0.json')));
  assert.ok(!existsSync(path.join(t, '.sdlc', 'bindings', 's0.json')));
  assert.equal(readFileSync(path.join(t, '.strand', 'bindings', 'junk.json'), 'utf8'), '{ not json', 'malformed files are left alone');

  const after = tree(t);
  const rerun = changesOf(t);
  assert.deepEqual(rerun.items, []);
  assert.deepEqual(rerun.conflicts, []);
  assert.equal(applyPrefixMigration(t, rerun).applied, 0);
  assert.deepEqual(tree(t), after, 'the rerun changes nothing');
});

test('an artefacts folder whose new name already exists is reported as a conflict and left alone', () => {
  const t = tracker();
  mkdirSync(path.join(t, 'artefacts', 'strand-cpi.13'));
  writeFileSync(path.join(t, 'artefacts', 'strand-cpi.13', 'other.txt'), 'kept');
  const plan = changesOf(t);
  assert.deepEqual(plan.conflicts, [
    { path: path.join('artefacts', 'sdlc-cpi.13'), target: path.join('artefacts', 'strand-cpi.13') },
  ]);
  assert.ok(!plan.items.some((i) => i.kind === 'artefacts'));
  applyPrefixMigration(t, plan);
  assert.equal(readFileSync(path.join(t, 'artefacts', 'sdlc-cpi.13', 'mock.png'), 'utf8'), 'png');
  assert.deepEqual(readdirSync(path.join(t, 'artefacts', 'strand-cpi.13')), ['other.txt']);
});

function ctxFor(t: string, ids: string[]) {
  const out: string[] = [];
  const errs: string[] = [];
  const beads = { listAll: async () => ids.map(bead) } as unknown as Beads;
  const ctx = {
    config: { trackerDir: t },
    beads,
    out: (l: string) => void out.push(l),
    err: (l: string) => void errs.push(l),
    env: {},
    cwd: t,
  } as unknown as Ctx;
  return { ctx, out, errs };
}

test('--apply is refused while beads with the old prefix remain; the dry run still lists the plan', async () => {
  const t = tracker();
  const before = tree(t);
  const r = ctxFor(t, ['sdlc-cpi.13', 'strand-a1']);
  assert.equal(await main(['sdlc', 'strand', '--apply'], r.ctx), 1);
  assert.match(r.errs.join('\n'), /1 bead still named sdlc-.*rename-prefix strand-/);
  assert.deepEqual(tree(t), before, 'nothing changed');

  const d = ctxFor(t, ['sdlc-cpi.13']);
  assert.equal(await main(['sdlc', 'strand'], d.ctx), 0);
  const text = d.out.join('\n');
  assert.match(text, /artefacts\s+artefacts[\\/]sdlc-cpi\.13\s+folder sdlc-cpi\.13 -> strand-cpi\.13/);
  assert.match(text, /binding\s+\.strand[\\/]bindings[\\/]s1\.json\s+bead sdlc-cpi\.13 -> strand-cpi\.13, epic sdlc-cpi -> strand-cpi/);
  assert.match(text, /bd still holds 1 bead named sdlc-/);
  assert.match(text, /Dry run/);
  assert.deepEqual(tree(t), before);
});

test('the CLI applies the plan once bd has renamed every bead, and says to commit the folders in a git tracker', async () => {
  const t = tracker();
  mkdirSync(path.join(t, '.git'));
  mkdirSync(path.join(t, 'artefacts', 'strand-x'));
  mkdirSync(path.join(t, 'artefacts', 'sdlc-x'));
  const r = ctxFor(t, ['strand-cpi.13', 'strand-a1']);
  assert.equal(await main(['sdlc-', 'strand-', '--apply'], r.ctx), 1, 'a conflict is left for the engineer');
  const text = r.out.join('\n');
  assert.match(text, /Applied 6 of 6/);
  assert.match(text, /conflict\s+artefacts[\\/]sdlc-x\s+artefacts[\\/]strand-x already exists, left alone/);
  assert.match(text, /Commit the renamed artefacts folders in the tracker/);
  assert.ok(existsSync(path.join(t, 'artefacts', 'strand-cpi.13')));

  const again = ctxFor(t, ['strand-cpi.13']);
  assert.equal(await main(['sdlc', 'strand', '--apply', '--json'], again.ctx), 1);
  const plan = JSON.parse(again.out.join('\n'));
  assert.deepEqual(plan.items, []);
  assert.equal(plan.applied, 0);
  assert.equal(plan.conflicts.length, 1);
});

test('the CLI asks for both prefixes and rejects a bad one', async () => {
  const t = tracker();
  const r = ctxFor(t, []);
  assert.equal(await main(['sdlc'], r.ctx), 2);
  assert.match(r.errs.join('\n'), /usage: strand migrate-prefix <old> <new>/);
  const b = ctxFor(t, []);
  assert.equal(await main(['sdlc', 'a/b'], b.ctx), 2);
  assert.match(b.errs.join('\n'), /invalid prefix/);
});
