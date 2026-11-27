import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Beads, ListedBead } from '../src/core/bd.ts';
import type { Snapshot } from '../src/core/snapshot.ts';
import { readBinding, writeBinding } from '../src/core/binding.ts';
import { sessionsFor, writeEntry } from '../src/core/sessions.ts';
import { planMigration, formatPlan, readOldBindings } from '../src/core/migrate.ts';
import type { MigrationPlan } from '../src/core/migrate.ts';
import { main } from '../src/cli/commands/migrate.ts';
import type { Ctx } from '../src/cli/ctx.ts';

const bead = (id: string, over: Partial<ListedBead> = {}): ListedBead => ({
  id,
  title: `title ${id}`,
  status: 'open',
  priority: 2,
  issue_type: 'task',
  labels: [],
  dependencies: [],
  ...over,
});
const snap = (list: ListedBead[]): Snapshot => ({
  beads: new Map(list.map((b) => [b.id, b])),
  ids: new Set(list.map((b) => b.id)),
  prefixes: ['sub'],
});
const none = { workspaceRoot: '/ws', remotes: new Map<string, string>(), branchRepo: () => undefined, oldBindings: [] };

test('repo label comes from the pr: label matched to a workspace remote, case-insensitively', () => {
  const s = snap([bead('sub-a', { labels: ['pr:Acme/Orders#4'] })]);
  const p = planMigration(s, { ...none, remotes: new Map([['acme/orders', 'orders-service']]) });
  assert.deepEqual(p.addRepo, [{ id: 'sub-a', repo: 'orders-service' }]);
  assert.deepEqual(p.unassigned, []);
});

test('repo label falls back to the repo that holds the branch ref, then to unassigned', () => {
  const s = snap([
    bead('sub-a', { labels: ['branch:ada/x', 'pr:other/unknown#1'] }),
    bead('sub-b', { labels: ['branch:ada/y'] }),
    bead('sub-c', { labels: ['branch:ada/z'] }),
  ]);
  const p = planMigration(s, { ...none, branchRepo: (n) => (n === 'ada/x' ? 'repo-x' : n === 'ada/y' ? 'repo-y' : undefined) });
  assert.deepEqual(p.addRepo, [
    { id: 'sub-a', repo: 'repo-x' },
    { id: 'sub-b', repo: 'repo-y' },
  ]);
  assert.deepEqual(p.unassigned, ['sub-c']);
});

test('beads with a repo label, or with no branch and no PR, are left alone', () => {
  const s = snap([bead('sub-a', { labels: ['repo:have', 'branch:ada/a'] }), bead('sub-b', { labels: [] })]);
  const p = planMigration(s, { ...none, branchRepo: () => 'r' });
  assert.deepEqual([p.addRepo, p.unassigned], [[], []]);
});

test('in-review is removed from every bead that has it, closed included', () => {
  const s = snap([
    bead('sub-a', { labels: ['in-review'] }),
    bead('sub-b', { status: 'closed', labels: ['in-review', 'x'] }),
    bead('sub-c', { labels: ['x'] }),
  ]);
  assert.deepEqual(planMigration(s, none).removeInReview, ['sub-a', 'sub-b']);
});

test('plan-approved: in_progress with a branch or a ticked criterion and no plan-approved note', () => {
  const s = snap([
    bead('sub-a', { status: 'in_progress', labels: ['branch:ada/a'] }),
    bead('sub-b', { status: 'in_progress', acceptance_criteria: '- [x] done (check: t)' }),
    bead('sub-c', { status: 'in_progress', labels: ['branch:ada/c'], notes: 'plan-approved 2026-01-01T00:00:00Z' }),
    bead('sub-d', { status: 'in_progress', acceptance_criteria: '- [ ] open (check: t)' }),
    bead('sub-e', { status: 'open', labels: ['branch:ada/e'] }),
  ]);
  assert.deepEqual(planMigration(s, none).approve, ['sub-a', 'sub-b']);
});

test('in_progress beads with no branch, no tick and no approval are listed as staying in Specify', () => {
  const s = snap([
    bead('sub-a', { status: 'in_progress', acceptance_criteria: '- [ ] open (check: t)' }),
    bead('sub-b', { status: 'in_progress', labels: ['branch:ada/b'] }),
    bead('sub-c', { status: 'in_progress', notes: 'plan-approved 2026-01-01T00:00:00Z' }),
    bead('sub-d', { status: 'open' }),
  ]);
  const p = planMigration(s, none);
  assert.deepEqual(p.staysInSpecify, ['sub-a']);
  assert.match(formatPlan(p, s), /^in_progress, stays in Specify: approve it or claim it again \(1\)\n {2}sub-a {2}title sub-a$/m);
});

test('old bindings: unknown beads are skipped, none and epic are kept', () => {
  const s = snap([bead('sub-a'), bead('sub-e', { issue_type: 'epic' })]);
  const p = planMigration(s, {
    ...none,
    oldBindings: [
      { sessionId: 's1', bead: 'sub-a', epic: 'sub-e' },
      { sessionId: 's2', bead: 'sub-gone' },
      { sessionId: 's3', bead: 'none' },
      { sessionId: 's4', bead: 'sub-a', epic: 'sub-gone' },
    ],
  });
  assert.deepEqual(p.bindings, [
    { sessionId: 's1', bead: 'sub-a', epic: 'sub-e' },
    { sessionId: 's3', bead: 'none' },
    { sessionId: 's4', bead: 'sub-a' },
  ]);
});

test('formatPlan groups by rule and ends with the dry-run line', () => {
  const s = snap([bead('sub-a', { labels: ['in-review'] })]);
  const plan: MigrationPlan = { ...planMigration(s, none), addRepo: [{ id: 'sub-a', repo: 'r1' }] };
  const out = formatPlan(plan, s);
  assert.match(out, /^repo: labels to add \(1\)\n {2}sub-a {2}title sub-a {2}-> repo:r1$/m);
  assert.match(out, /^needs a repo: label, assign by hand \(0\)$/m);
  assert.match(out, /^in-review labels to remove \(1\)\n {2}sub-a {2}title sub-a {2}-> remove in-review$/m);
  assert.match(out, /^plan-approved to write \(0\)$/m);
  assert.match(out, /^session bindings to import \(0\)$/m);
  assert.ok(out.endsWith('Dry run. Nothing was changed. Rerun with --apply to make these changes.'));
});

test('formatPlan says a safety export comes first, when it is given the tracker folder', () => {
  const s = snap([]);
  const out = formatPlan(planMigration(s, none), s, '/t');
  const lines = out.split('\n');
  assert.equal(lines.at(-2), `With --apply, a safety export is written first to ${path.join('/t', '.strand', 'backups')}${path.sep}.`);
  assert.equal(lines.at(-1), 'Dry run. Nothing was changed. Rerun with --apply to make these changes.');
});

// --- command, against temp state only -------------------------------------------------

const tmp = () => mkdtempSync(path.join(tmpdir(), 'strand-mig-'));
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });

type Rig = {
  ctx: Ctx;
  out: string[];
  errs: string[];
  calls: string[];
  home: string;
  tracker: string;
  ws: string;
  /** Make the nth addLabel throw (0 = never). */
  failAddOn: { call: number };
  /** What the fake export does: write every bead, write one line too few, or throw. */
  exportMode: { mode: 'ok' | 'short' | 'throw' };
};

function rig(source: ListedBead[]): Rig {
  const list = structuredClone(source);
  const failAddOn = { call: 0 };
  const exportMode: Rig['exportMode'] = { mode: 'ok' };
  let adds = 0;
  const home = tmp();
  const ws = path.join(home, 'ws');
  const tracker = path.join(home, 'tracker');
  mkdirSync(ws, { recursive: true });
  mkdirSync(tracker, { recursive: true });
  const calls: string[] = [];
  // Every write is recorded. A dry run must leave `calls` empty.
  const beads = {
    listAll: async () => list,
    exportAll: async (file: string) => {
      calls.push('export');
      if (exportMode.mode === 'throw') throw new Error('disk full');
      const n = exportMode.mode === 'short' ? list.length - 1 : list.length;
      writeFileSync(file, list.slice(0, n).map((b) => JSON.stringify({ id: b.id })).join('\n') + '\n');
    },
    addLabel: async (id: string, l: string) => {
      if (failAddOn.call > 0 && ++adds === failAddOn.call) throw new Error('boom');
      calls.push(`add ${id} ${l}`);
      list.find((b) => b.id === id)!.labels.push(l);
    },
    removeLabel: async (id: string, l: string) => {
      calls.push(`remove ${id} ${l}`);
      const b = list.find((x) => x.id === id)!;
      b.labels = b.labels.filter((x) => x !== l);
    },
    note: async (id: string, t: string) => {
      calls.push(`note ${id} ${t}`);
      const b = list.find((x) => x.id === id)!;
      b.notes = `${b.notes ?? ''}\n${t}`;
    },
  } as unknown as Beads;
  const out: string[] = [];
  const errs: string[] = [];
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home };
  const ctx = {
    config: { workspaceRoot: ws, trackerDir: tracker },
    beads,
    out: (l: string) => void out.push(l),
    err: (l: string) => void errs.push(l),
    env,
    cwd: home,
  } as unknown as Ctx;
  return { ctx, out, errs, calls, home, tracker, ws, failAddOn, exportMode };
}

function repoWith(ws: string, folder: string, opts: { remote?: string; branch?: string }) {
  const dir = path.join(ws, folder);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init');
  if (opts.remote) git(dir, 'remote', 'add', 'origin', opts.remote);
  if (opts.branch) git(dir, 'branch', opts.branch);
  return dir;
}

function oldFile(home: string, name: string, text: string) {
  const dir = path.join(home, '.claude', 'state', 'beads');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), text);
}

const list = [
  bead('sub-a', { status: 'in_progress', labels: ['pr:acme/orders#4', 'branch:ada/a', 'in-review'] }),
  bead('sub-b', { labels: ['branch:ada/b'] }),
  bead('sub-c', { labels: ['branch:ada/nowhere'] }),
];

function populate(r: Rig) {
  repoWith(r.ws, 'orders-service', { remote: 'https://git.example/Acme/orders.git' });
  repoWith(r.ws, 'other', { branch: 'ada/b' });
  mkdirSync(path.join(r.ws, 'not-a-repo'));
  oldFile(r.home, 's1.bead', 'sub-a\n');
  oldFile(r.home, 's1.epic', 'sub-a\n');
  oldFile(r.home, 's2.bead', 'none\n');
}

const backups = (r: Rig) => {
  const dir = path.join(r.tracker, '.strand', 'backups');
  return existsSync(dir) ? readdirSync(dir) : [];
};

test('readOldBindings reads .bead and .epic files, and returns nothing when the folder is absent', () => {
  const home = tmp();
  assert.deepEqual(readOldBindings(home), []);
  oldFile(home, 's1.bead', 'sub-a\n');
  oldFile(home, 's1.epic', 'sub-e\n');
  oldFile(home, 's2.bead', 'none');
  oldFile(home, 'x.txt', 'ignored');
  assert.deepEqual(
    readOldBindings(home).sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    [
      { sessionId: 's1', bead: 'sub-a', epic: 'sub-e' },
      { sessionId: 's2', bead: 'none' },
    ],
  );
});

test('migrate without --apply prints the plan and makes no write', async () => {
  const r = rig(list);
  populate(r);
  const before = readdirSync(r.tracker);
  assert.equal(await main([], r.ctx), 0);
  assert.deepEqual(r.calls, []);
  assert.deepEqual(readdirSync(r.tracker), before);
  assert.ok(!existsSync(path.join(r.tracker, '.strand')));
  assert.equal(r.out[0], `Tracker: ${r.tracker} (3 beads)`);
  const text = r.out.join('\n');
  assert.match(text, /repo: labels to add \(2\)/);
  assert.match(text, /sub-a {2}title sub-a {2}-> repo:orders-service/);
  assert.match(text, /sub-b {2}title sub-b {2}-> repo:other/);
  assert.match(text, /needs a repo: label, assign by hand \(1\)/);
  assert.match(text, /in-review labels to remove \(1\)/);
  assert.match(text, /plan-approved to write \(1\)/);
  assert.match(text, /session bindings to import \(2\)/);
  assert.match(text, /With --apply, a safety export is written first to .*backups/);
  assert.ok(text.endsWith('Dry run. Nothing was changed. Rerun with --apply to make these changes.'));
});

test('migrate --json prints the MigrationPlan and still writes nothing', async () => {
  const r = rig(list);
  populate(r);
  assert.equal(await main(['--json'], r.ctx), 0);
  assert.deepEqual(r.calls, []);
  const plan = JSON.parse(r.out.join('\n')) as MigrationPlan;
  assert.deepEqual(plan.addRepo, [
    { id: 'sub-a', repo: 'orders-service' },
    { id: 'sub-b', repo: 'other' },
  ]);
  assert.deepEqual(plan.unassigned, ['sub-c']);
  assert.deepEqual(plan.removeInReview, ['sub-a']);
  assert.deepEqual(plan.approve, ['sub-a']);
  assert.equal(plan.bindings.length, 2);
});

test('migrate --apply writes a safety export first, then labels, notes and bindings', async () => {
  const r = rig(list);
  populate(r);
  assert.equal(await main(['--apply'], r.ctx), 0);
  assert.equal(r.calls[0], 'export');
  const files = backups(r);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^pre-migrate-\d{8}-\d{6}\.jsonl$/);
  assert.match(r.out.join('\n'), /^Safety export: .*pre-migrate-\d{8}-\d{6}\.jsonl$/m);
  assert.ok(r.calls.includes('add sub-a repo:orders-service'));
  assert.ok(r.calls.includes('add sub-b repo:other'));
  assert.ok(r.calls.includes('remove sub-a in-review'));
  const note = r.calls.find((c) => c.startsWith('note sub-a '))!;
  assert.match(note, /^note sub-a plan-approved \d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.deepEqual(readBinding(r.tracker, 's1'), { bead: 'sub-a', epic: 'sub-a' });
  assert.deepEqual(readBinding(r.tracker, 's2'), { none: true });
});

test('migrate --apply never overwrites an existing binding for the same session', async () => {
  const r = rig(list);
  populate(r);
  writeBinding(r.tracker, 's1', { bead: 'sub-b', approved: true });
  assert.equal(await main(['--apply'], r.ctx), 0);
  assert.deepEqual(readBinding(r.tracker, 's1'), { bead: 'sub-b', approved: true });
  assert.deepEqual(readBinding(r.tracker, 's2'), { none: true });
});

test('an export that throws stops everything with zero writes, and says so', async () => {
  const r = rig(list);
  populate(r);
  r.exportMode.mode = 'throw';
  assert.equal(await main(['--apply'], r.ctx), 1);
  assert.deepEqual(r.calls, ['export']);
  assert.ok(!existsSync(path.join(r.tracker, '.strand', 'bindings')));
  assert.match(r.out.join('\n'), /^repo labels: 0 of 2 applied$/m);
  assert.equal(r.errs.length, 1);
  assert.match(r.errs[0]!, /^Could not write a safety export to .*pre-migrate-\d{8}-\d{6}\.jsonl: disk full\. Nothing was changed\.$/);
});

test('an export with too few lines stops everything with zero writes', async () => {
  const r = rig(list);
  populate(r);
  r.exportMode.mode = 'short';
  assert.equal(await main(['--apply'], r.ctx), 1);
  assert.deepEqual(r.calls, ['export']);
  assert.ok(!existsSync(path.join(r.tracker, '.strand', 'bindings')));
  assert.match(r.errs.join('\n'), /Could not write a safety export to .*: 2 lines for 3 beads\. Nothing was changed\./);
});

test('an export that writes no file stops everything', async () => {
  const r = rig(list);
  populate(r);
  (r.ctx.beads as unknown as { exportAll: () => Promise<void> }).exportAll = async () => void r.calls.push('export');
  assert.equal(await main(['--apply'], r.ctx), 1);
  assert.deepEqual(r.calls, ['export']);
  assert.match(r.errs.join('\n'), /Could not write a safety export to .*: file not found\. Nothing was changed\./);
});

test('migrate --apply prints per-group counts on success', async () => {
  const r = rig(list);
  populate(r);
  assert.equal(await main(['--apply'], r.ctx), 0);
  assert.equal(r.out[0], `Tracker: ${r.tracker} (3 beads)`);
  const text = r.out.join('\n');
  assert.match(text, /^repo labels: 2 of 2 applied$/m);
  assert.match(text, /^in-review removals: 1 of 1 applied$/m);
  assert.match(text, /^plan-approved notes: 1 of 1 applied$/m);
  assert.match(text, /^session bindings: 2 of 2 applied$/m);
});

test('a bd error part way through --apply names what was and was not applied, and a rerun finishes', async () => {
  const r = rig(list);
  populate(r);
  r.failAddOn.call = 2;
  assert.equal(await main(['--apply'], r.ctx), 1);
  const text = r.out.join('\n');
  assert.match(text, /^repo labels: 1 of 2 applied$/m);
  assert.match(text, /^in-review removals: 0 of 1 applied$/m);
  assert.match(text, /^plan-approved notes: 0 of 1 applied$/m);
  assert.match(text, /^session bindings: 0 of 2 applied$/m);
  assert.match(text, /^Safety export: /m);
  assert.deepEqual(r.errs, ['Stopped: boom. Nothing was lost. Rerun strand migrate --apply to finish.']);
  assert.deepEqual(r.calls.filter((c) => c.startsWith('add ')), ['add sub-a repo:orders-service']);

  r.failAddOn.call = 0;
  r.out.length = 0;
  r.errs.length = 0;
  assert.equal(await main(['--apply'], r.ctx), 0);
  assert.match(r.out.join('\n'), /^repo labels: 1 of 1 applied$/m);
  assert.ok(r.calls.includes('add sub-b repo:other'));
  assert.equal(r.calls.filter((c) => c === 'add sub-a repo:orders-service').length, 1);
  assert.deepEqual(r.errs, []);
});

test('migrate --apply --json prints one object: plan, export path, counts, and the error on failure', async () => {
  const ok = rig(list);
  populate(ok);
  assert.equal(await main(['--apply', '--json'], ok.ctx), 0);
  assert.equal(ok.out.length, 1);
  const good = JSON.parse(ok.out[0]!);
  assert.equal(good.plan.addRepo.length, 2);
  assert.match(good.export, /pre-migrate-\d{8}-\d{6}\.jsonl$/);
  assert.deepEqual(good.applied.addRepo, { done: 2, total: 2 });
  assert.deepEqual(good.applied.bindings, { done: 2, total: 2 });
  assert.equal(good.error, undefined);

  const bad = rig(list);
  populate(bad);
  bad.failAddOn.call = 2;
  assert.equal(await main(['--apply', '--json'], bad.ctx), 1);
  assert.equal(bad.out.length, 1);
  const failed = JSON.parse(bad.out[0]!);
  assert.deepEqual(failed.applied.addRepo, { done: 1, total: 2 });
  assert.deepEqual(failed.applied.approve, { done: 0, total: 1 });
  assert.equal(failed.error, 'boom');
});

test('two folders sharing an origin: the first in sorted order wins for remotes and branches, and the report names them', async () => {
  const r = rig([bead('sub-a', { labels: ['pr:acme/orders#4'] }), bead('sub-b', { labels: ['branch:ada/shared'] })]);
  repoWith(r.ws, 'b-copy', { remote: 'https://git.example/acme/orders.git', branch: 'ada/shared' });
  repoWith(r.ws, 'A-orig', { remote: 'git@git.example:Acme/orders.git', branch: 'ada/shared' });
  assert.equal(await main([], r.ctx), 0);
  const text = r.out.join('\n');
  assert.match(text, /sub-a {2}title sub-a {2}-> repo:A-orig/);
  assert.match(text, /sub-b {2}title sub-b {2}-> repo:A-orig/);
  assert.match(text, /Folders sharing an origin \(acme\/orders\): A-orig, b-copy\. The first one wins\./);
  assert.ok(text.endsWith('Dry run. Nothing was changed. Rerun with --apply to make these changes.'));
});

test('migrate rejects an unknown option', async () => {
  const r = rig(list);
  await assert.rejects(main(['--bogus'], r.ctx));
  assert.deepEqual(r.calls, []);
});

function transcript(home: string, sessionId: string) {
  const dir = path.join(home, '.claude', 'projects', 'C--ws-orders');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, '{}\n');
  return file;
}

test('migrate --apply lists an imported session on its bead when its transcript exists', async () => {
  const r = rig(list);
  populate(r);
  const file = transcript(r.home, 's1');
  transcript(r.home, 's2');
  oldFile(r.home, 's3.bead', 'sub-b\n');
  assert.equal(await main(['--apply'], r.ctx), 0);
  const entries = sessionsFor(r.tracker, 'sub-a');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.sessionId, 's1');
  assert.equal(entries[0]!.transcriptPath, file);
  assert.match(entries[0]!.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(entries[0]!.endedAt, 'an imported session is not live');
  // s2 is bound to no bead; s3 has no transcript to resume.
  assert.deepEqual(readdirSync(path.join(r.tracker, '.strand', 'sessions')), ['s1.json']);
  assert.match(r.out.join('\n'), /^sessions listed: 1 of 1 applied$/m);
});

test('a rerun lists sessions whose binding was imported before, and then has nothing left', async () => {
  const r = rig(list);
  populate(r);
  transcript(r.home, 's1');
  writeBinding(r.tracker, 's1', { bead: 'sub-b' });
  writeBinding(r.tracker, 's2', { none: true });
  assert.equal(await main([], r.ctx), 0);
  const dry = r.out.join('\n');
  assert.match(dry, /^session bindings to import \(0\)$/m);
  assert.match(dry, /^sessions to list on their bead \(1\)$/m);
  assert.match(dry, /sub-b {2}title sub-b {2}-> session s1/);
  assert.ok(!existsSync(path.join(r.tracker, '.strand', 'sessions')));

  assert.equal(await main(['--apply'], r.ctx), 0);
  // The binding in force wins over the old file's bead.
  assert.deepEqual(sessionsFor(r.tracker, 'sub-b').map((e) => e.sessionId), ['s1']);
  assert.deepEqual(sessionsFor(r.tracker, 'sub-a'), []);

  r.out.length = 0;
  assert.equal(await main([], r.ctx), 0);
  assert.match(r.out.join('\n'), /^sessions to list on their bead \(0\)$/m);
});

test('migrate --apply leaves a session that is already in the index alone', async () => {
  const r = rig(list);
  populate(r);
  transcript(r.home, 's1');
  writeEntry(r.tracker, { sessionId: 's1', beadId: 'sub-a', startedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(await main(['--apply'], r.ctx), 0);
  assert.deepEqual(sessionsFor(r.tracker, 'sub-a'), [{ sessionId: 's1', beadId: 'sub-a', startedAt: '2026-01-01T00:00:00.000Z' }]);
});
