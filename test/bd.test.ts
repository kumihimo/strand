import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/core/exec.ts';
import { BdError, Beads } from '../src/core/bd.ts';
import { baseEnv, runWith } from './fixtures/env.ts';

const hasBd = await run('bd', ['--version']).then((r) => r.code === 0, () => false);
const skip = hasBd ? false : 'bd not on PATH';

let dir = '';
let beads: Beads;
const env = { ...baseEnv(), BD_NON_INTERACTIVE: '1' };

before(async () => {
  if (!hasBd) return;
  dir = mkdtempSync(join(tmpdir(), 'strand-bd-'));
  await run('git', ['init', '-q'], { cwd: dir });
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  const init = await runWith('bd', ['init', '--prefix', 't'], { cwd: dir, env });
  assert.equal(init.code, 0, init.stderr);
  beads = new Beads(dir);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('create returns a bead with labels, show normalises', { skip }, async () => {
  const b = await beads.create({ title: 'Stream orders', type: 'feature', priority: 1, labels: ['repo:orders-service'] });
  assert.deepEqual(b.labels, ['repo:orders-service']);
  const s = await beads.show(b.id);
  assert.equal(s.title, 'Stream orders');
  assert.deepEqual(s.dependencies, []);
  await beads.claim(b.id);
  assert.equal((await beads.show(b.id)).status, 'in_progress');
  const all = await beads.list();
  assert.ok(all.some((x) => x.id === b.id));
});

test('create stores description and acceptance, including text that starts with a dash', { skip }, async () => {
  const b = await beads.create({
    title: 'Filed whole',
    type: 'task',
    description: 'As a dev, I want x, so that y.',
    acceptance: '- [ ] one (check: a)\n- [ ] two (check: b)',
  });
  const s = await beads.show(b.id);
  assert.equal(s.description, 'As a dev, I want x, so that y.');
  assert.equal(s.acceptance_criteria, '- [ ] one (check: a)\n- [ ] two (check: b)');
});

test('setAcceptance, addLabel, removeLabel and addDep change the bead', { skip }, async () => {
  const a = await beads.create({ title: 'A', type: 'task' });
  const c = await beads.create({ title: 'C', type: 'task' });
  await beads.setAcceptance(a.id, '- [ ] first (check: t)');
  assert.equal((await beads.show(a.id)).acceptance_criteria, '- [ ] first (check: t)');
  await beads.addLabel(a.id, 'branch:me/topic');
  await beads.addLabel(a.id, 'other');
  assert.deepEqual([...(await beads.show(a.id)).labels].sort(), ['branch:me/topic', 'other']);
  await beads.removeLabel(a.id, 'other');
  assert.deepEqual((await beads.show(a.id)).labels, ['branch:me/topic']);
  await beads.addDep(a.id, c.id);
  const row = (await beads.listAll()).find((x) => x.id === a.id)!;
  assert.ok(row.dependencies.some((d) => d.depends_on_id === c.id));
  assert.ok(!(await beads.ready()).some((x) => x.id === a.id), 'a depends on the open c');
});

test('update changes title and acceptance in one call, and updated_at moves in show and list', { skip }, async () => {
  const epic = await beads.create({ title: 'Epic', type: 'epic' });
  const b = await beads.create({ title: 'Before', type: 'task', description: 'As a dev, I want x, so that y', acceptance: '- [ ] one (check: a)', parent: epic.id });
  const before = await beads.show(b.id);
  assert.match(before.updated_at ?? '', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(before.parent, epic.id);
  assert.equal((await beads.listAll()).find((x) => x.id === b.id)!.updated_at, before.updated_at, 'list and show agree');
  await new Promise((r) => setTimeout(r, 1100)); // updated_at has second precision
  await beads.update(b.id, { title: '-After', acceptance: '- [ ] two (check: b)\n- [ ] three (check: c)', design: '-spec', priority: 1 });
  const after = await beads.show(b.id);
  assert.equal(after.title, '-After');
  assert.equal(after.acceptance_criteria, '- [ ] two (check: b)\n- [ ] three (check: c)');
  assert.equal(after.design, '-spec');
  assert.equal(after.priority, 1);
  assert.equal(after.description, 'As a dev, I want x, so that y', 'untouched fields stay');
  assert.notEqual(after.updated_at, before.updated_at);
  assert.equal((await beads.listAll()).find((x) => x.id === b.id)!.updated_at, after.updated_at);
});

test('update with no fields makes no bd call, and sends each field as --flag=value', async () => {
  const seen: string[][] = [];
  const b = new Beads('.');
  (b as unknown as { exec(args: string[]): Promise<string> }).exec = async (args) => {
    seen.push(args);
    return '';
  };
  await b.update('t-1', {});
  await b.update('t-1', { title: '-a', description: 'd', acceptance: '- [ ] x', design: '-z', type: 'task', priority: 0, parent: 't-9' });
  assert.deepEqual(seen, [['update', 't-1', '--title=-a', '--description=d', '--acceptance=- [ ] x', '--design=-z', '--type=task', '--priority=0', '--parent=t-9']]);
});

test('comments, notes and design round-trip', { skip }, async () => {
  const b = await beads.create({ title: 'Talk', type: 'task' });
  await beads.comment(b.id, 'hello there');
  const cs = await beads.comments(b.id);
  assert.equal(cs.length, 1);
  assert.equal(cs[0]!.text, 'hello there');
  await beads.setDesign(b.id, 'the design');
  await beads.note(b.id, 'a note');
  const s = await beads.show(b.id);
  assert.equal(s.design, 'the design');
  assert.match(s.notes ?? '', /a note/);
  await beads.close(b.id, 'done');
  assert.equal((await beads.show(b.id)).status, 'closed');
});

test('failing bd command throws with args and stderr', { skip }, async () => {
  await assert.rejects(beads.show('t-nope'), /show t-nope/);
});

test('leading-dash text is safe and lists are unlimited', { skip }, async () => {
  const b = await beads.create({ title: '-dash title', type: 'task' });
  assert.equal(b.title, '-dash title');
  await beads.comment(b.id, '-hi there');
  assert.equal((await beads.comments(b.id))[0]!.text, '-hi there');
  await beads.note(b.id, '-n');
  assert.match((await beads.show(b.id)).notes ?? '', /-n/);
  await beads.setDesign(b.id, '-des');
  assert.equal((await beads.show(b.id)).design, '-des');
  assert.ok((await beads.list()).length >= 1);
  assert.ok((await beads.ready()).some((x) => x.id === b.id));
});

test('Beads waits 20 s by default; a failed bd call is a BdError carrying stderr', { skip }, async () => {
  assert.equal(new Beads(dir).timeoutMs, 20_000);
  assert.equal(new Beads(dir, { timeoutMs: 50 }).timeoutMs, 50);
  await assert.rejects(beads.create({ title: 'x', type: 'task', parent: 'nope-1' }), (e: BdError) => {
    assert.ok(e instanceof BdError);
    assert.equal(e.firstStderrLine, 'Error: parent issue nope-1 not found');
    return true;
  });
});

test('bd reads the tracker even when BEADS_DIR points elsewhere', { skip }, async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'strand-bd-other-'));
  await run('git', ['init', '-q'], { cwd: elsewhere });
  const other = await runWith('bd', ['init', '--prefix', 'o'], { cwd: elsewhere, env });
  assert.equal(other.code, 0, other.stderr);
  const saved = process.env.BEADS_DIR;
  process.env.BEADS_DIR = join(elsewhere, '.beads');
  try {
    const b = await beads.create({ title: 'Pinned to tracker', type: 'task' });
    assert.ok((await beads.list()).some((x) => x.id === b.id));
    const direct = await runWith('bd', ['list', '--all', '--json'], { cwd: dir, env: { ...env, BEADS_DIR: join(dir, '.beads') } });
    assert.ok(direct.stdout.includes(b.id), 'the bead is not in the tracker database');
  } finally {
    if (saved === undefined) delete process.env.BEADS_DIR;
    else process.env.BEADS_DIR = saved;
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('close passes --session only when a session id is given', async () => {
  const seen: string[][] = [];
  const b = new Beads('.');
  (b as unknown as { exec(args: string[]): Promise<string> }).exec = async (args) => {
    seen.push(args);
    return '';
  };
  await b.close('t-1', 'Merged as acme/svc#7', 'sess-1');
  await b.close('t-2', 'done');
  assert.deepEqual(seen, [
    ['close', 't-1', '--reason', 'Merged as acme/svc#7', '--session', 'sess-1'],
    ['close', 't-2', '--reason', 'done'],
  ]);
});

test('setStatus sends --status=<value> as one flag', async () => {
  const seen: string[][] = [];
  const b = new Beads('.');
  (b as unknown as { exec(args: string[]): Promise<string> }).exec = async (args) => {
    seen.push(args);
    return '';
  };
  await b.setStatus('t-1', 'open');
  assert.deepEqual(seen, [['update', 't-1', '--status=open']]);
});

test('setStatus puts a claimed bead back to open against real bd', { skip }, async () => {
  const b = await beads.create({ title: 'Released', type: 'task' });
  await beads.claim(b.id);
  assert.equal((await beads.show(b.id)).status, 'in_progress');
  await beads.setStatus(b.id, 'open');
  assert.equal((await beads.show(b.id)).status, 'open');
});

test('close with a session id works against real bd', { skip }, async () => {
  const b = await beads.create({ title: 'Session close', type: 'task' });
  await beads.close(b.id, 'done', 'sess-real');
  assert.equal((await beads.show(b.id)).status, 'closed');
});

test('exportAll writes one JSON line per bead, each with an id', { skip }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'strand-bd-export-'));
  try {
    await beads.create({ title: 'Export one', type: 'task' });
    await beads.create({ title: 'Export two', type: 'task', labels: ['x'] });
    const file = join(out, 'all.jsonl');
    await beads.exportAll(file);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
    assert.ok(lines.length >= 2, `${lines.length} lines`);
    for (const l of lines) assert.equal(typeof (JSON.parse(l) as { id?: unknown }).id, 'string');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('exportAll throws when bd fails (an existing folder with no .beads)', { skip }, async () => {
  const empty = mkdtempSync(join(tmpdir(), 'strand-bd-empty-'));
  try {
    await assert.rejects(new Beads(empty).exportAll(join(empty, 'out.jsonl')), BdError);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
