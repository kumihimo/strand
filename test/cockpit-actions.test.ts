import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseEnv } from './fixtures/env.ts';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readBinding, writeBinding } from '../src/core/binding.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCtx } from '../src/cli/ctx.ts';
import { createServer, type CockpitModel } from '../src/cockpit/server.ts';
import { checkUrl, resolveArtefact } from '../src/cockpit/actions.ts';
import { Model } from '../src/cockpit/model.ts';
import { beadVersion } from '../src/core/edit-bead.ts';
import { criteriaHash } from '../src/core/criteria-hash.ts';
import type { ListedBead } from '../src/core/bd.ts';
import { BdError } from '../src/core/bd.ts';
import { Terminals, type SpawnPty } from '../src/cockpit/pty.ts';

const TOKEN = 'd'.repeat(64);
const H = { 'x-strand-key': TOKEN };

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'strand-act-'));
  const tracker = join(ws, 'tracker');
  const art = join(tracker, 'artefacts', 't-1');
  mkdirSync(join(art, 'scratch'), { recursive: true });
  mkdirSync(join(art, 'sessions'), { recursive: true });
  writeFileSync(join(art, 'mockup.html'), '<h1>hi</h1>');
  writeFileSync(join(art, 'scratch', 'v1.html'), '<p>v1</p>');
  writeFileSync(join(art, 'sessions', 's1.jsonl.gz'), 'gz');
  writeFileSync(join(art, 'run.ps1'), 'x');
  const outside = join(ws, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 's');
  let symlinks = true;
  try {
    symlinkSync(outside, join(art, 'link'), 'dir');
  } catch {
    symlinks = false;
  }
  // Two repos in the workspace: the cockpit's repo list.
  for (const r of ['app', 'docs']) mkdirSync(join(ws, r, '.git'), { recursive: true });
  const cfg = join(ws, 'config');
  const env: NodeJS.ProcessEnv = { ...baseEnv(), STRAND_WORKSPACE: ws, XDG_CONFIG_HOME: cfg, APPDATA: cfg, HOME: cfg, USERPROFILE: cfg };
  delete env.STRAND_GITEA_URL;
  delete env.STRAND_GITEA_TOKEN;
  return { ws, tracker, env, symlinks };
}

test('resolveArtefact refuses escapes and scripts, accepts kept files', (t) => {
  const { tracker, symlinks } = setup();
  const bad: [string, string][] = [
    ['t-1', '../x'], ['t-1', 'scratch/../../x'], ['t-1', '..\\x'], ['t-1', '/etc/passwd'], ['t-1', 'C:\\x.txt'], ['t-1', 'c:x'],
    ['t-1', 'run.ps1'], ['t-1', 'RUN.PS1'], ['t-1', 'a\0b'], ['t-1', ''], ['t-1', 'missing.html'], ['t-1', 'scratch'],
    ['../t-1', 'mockup.html'], ['--help', 'mockup.html'],
  ];
  for (const [id, rel] of bad) assert.throws(() => resolveArtefact(tracker, id, rel), /^Error: refused: /, `${id} ${rel}`);
  if (symlinks) assert.throws(() => resolveArtefact(tracker, 't-1', 'link/secret.txt'), /refused: path escapes/);
  else t.diagnostic('symlinks unavailable');
  for (const rel of ['mockup.html', 'scratch/v1.html', 'scratch\\v1.html', 'sessions/s1.jsonl.gz']) {
    assert.ok(resolveArtefact(tracker, 't-1', rel).includes('t-1'), rel);
  }
});

test('checkUrl only allows http and https', () => {
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'ms-msdt:x', 'not a url', '']) {
    assert.throws(() => checkUrl(u), /refused: only http and https links can be opened/, u);
  }
  assert.equal(checkUrl('https://gitea.local/pr/1').href, 'https://gitea.local/pr/1');
});

type FakeBeads = {
  listAll: () => Promise<ListedBead[]>;
  note: (id: string, text: string) => Promise<void>;
  comment: (id: string, text: string) => Promise<void>;
  create: (i: unknown) => Promise<unknown>;
  setStatus: (id: string, status: string) => Promise<void>;
};

async function app(env: NodeJS.ProcessEnv, beads: Partial<FakeBeads> = {}, opened: string[] = [], inv: { n: number } = { n: 0 }, errs: string[] = [], wip?: { build: number; review: number; mode: 'warn' | 'refuse' }) {
  const built = buildCtx(env);
  const ctx = { ...built, config: wip ? { ...built.config, wip } : built.config, err: (l: string) => errs.push(l), beads: beads as never };
  const model = { invalidate: () => void inv.n++ } as unknown as CockpitModel;
  return createServer({ ctx, token: TOKEN, allowedHosts: 'any', model, opener: async (t) => void opened.push(t) });
}
const post = (s: Awaited<ReturnType<typeof app>>, url: string, payload: unknown) => s.inject({ method: 'POST', url, headers: H, payload: payload as never });

test('POST /api/open refuses bad targets without launching, opens good ones', async () => {
  const { env, tracker } = setup();
  const opened: string[] = [];
  const s = await app(env, {}, opened);
  for (const body of [
    { url: 'file:///etc/passwd' }, { url: 'javascript:alert(1)' }, { path: '../x', beadId: 't-1' }, { path: 'run.ps1', beadId: 't-1' },
    { path: 'mockup.html' }, { path: 'mockup.html', url: 'https://x.test/' }, {}, { url: 5 },
  ]) {
    const r = await post(s, '/api/open', body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.ok(typeof r.json().error === 'string');
  }
  assert.match((await post(s, '/api/open', { url: 'file:///x' })).json().error, /^refused: /);
  assert.deepEqual(opened, []);
  assert.deepEqual((await post(s, '/api/open', { url: 'https://gitea.local/pr/1' })).json(), { ok: true });
  assert.deepEqual((await post(s, '/api/open', { path: 'scratch/v1.html', beadId: 't-1' })).json(), { ok: true });
  assert.equal(opened[0], 'https://gitea.local/pr/1');
  assert.equal(opened[1], resolveArtefact(tracker, 't-1', 'scratch/v1.html'));
  await s.close();
});

test('STRAND_COCKPIT_DRY_OPEN=1 returns the target without launching', async () => {
  const { env } = setup();
  const opened: string[] = [];
  const s = await app({ ...env, STRAND_COCKPIT_DRY_OPEN: '1' }, {}, opened);
  assert.deepEqual((await post(s, '/api/open', { url: 'https://a.test/x' })).json(), { ok: true, target: 'https://a.test/x', dryRun: true });
  assert.equal((await post(s, '/api/open', { url: 'file:///x' })).statusCode, 400);
  assert.deepEqual(opened, []);
  await s.close();
});

test('opener that returns an emitter without a listener cannot crash the server', async () => {
  const { env } = setup();
  const { EventEmitter } = await import('node:events');
  const ctx = { ...buildCtx(env), err: () => {} };
  const s = await createServer({ ctx, token: TOKEN, allowedHosts: 'any', model: { invalidate() {} } as never, opener: () => new EventEmitter() });
  const r = await post(s, '/api/open', { url: 'https://a.test/' });
  assert.equal(r.statusCode, 200);
  await s.close();
});

const CRITERIA = '- [ ] It works (check: node --test)';
const row = (id: string, extra: Partial<ListedBead> = {}): ListedBead => ({
  id, title: id, status: 'in_progress', priority: 2, issue_type: 'task', labels: [], dependencies: [], acceptance_criteria: CRITERIA,
  description: 'As a user, I want it, so that it works', ...extra,
});

/** Beads that serves rows and records the notes and comments written. */
function recorder(rows: ListedBead[]) {
  const notes: [string, string][] = [];
  const comments: [string, string][] = [];
  const beads: Partial<FakeBeads> = {
    listAll: async () => rows,
    note: async (id, text) => void notes.push([id, text]),
    comment: async (id, text) => void comments.push([id, text]),
  };
  return { beads, notes, comments };
}

test('approve writes plan-approved and the criteria baseline, returns approved, invalidates', async () => {
  const { env } = setup();
  const { beads, notes } = recorder([row('t-1')]);
  const inv = { n: 0 };
  const s = await app(env, beads, [], inv);
  const r = await post(s, '/api/beads/t-1/approve', {});
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { approved: true, typed: 0 });
  assert.equal(notes.length, 2);
  assert.match(notes[0][1], /^plan-approved \d{4}-\d\d-\d\dT/);
  assert.deepEqual(notes[1], ['t-1', `criteria ${criteriaHash(CRITERIA)}`]);
  assert.equal(inv.n, 1);
  await s.close();
});

test('approve in warn mode with a full WIP limit is 200 with the warning', async () => {
  const { env } = setup();
  const busy = row('t-2', { notes: 'plan-approved 2026-11-01T10:00:00.000Z' });
  const { beads, notes } = recorder([row('t-1'), busy]);
  const s = await app(env, beads, [], { n: 0 }, [], { build: 1, review: 3, mode: 'warn' });
  const r = await post(s, '/api/beads/t-1/approve', {});
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { approved: true, warn: 'Build is at its WIP limit (1/1)', typed: 0 });
  assert.equal(notes.length, 2, 'approval still written');
  await s.close();
});

test('approve errors: closed, already approved, spec problems, refuse-mode WIP are 409; unknown or malformed id is 404', async () => {
  const { env } = setup();
  const cases: [string, ListedBead[], string][] = [
    ['closed', [row('t-1', { status: 'closed' })], 'bead t-1 is closed'],
    ['approved', [row('t-1', { notes: 'plan-approved 2026-11-01T10:00:00.000Z' })], 'bead t-1 is already approved'],
    ['no criteria', [row('t-1', { acceptance_criteria: '' })], 'needs at least one acceptance criterion'],
    ['free text', [row('t-1', { acceptance_criteria: 'it works\n- [ ] it is fast' })], '2 acceptance lines are not in the form "- [ ] <text> (check: <command>)"'],
    ['no story', [row('t-1', { description: 'fix' })], 'description must open "As <role>, I want ..., so that ..."'],
  ];
  for (const [name, rows, error] of cases) {
    const { beads, notes } = recorder(rows);
    const inv = { n: 0 };
    const s = await app(env, beads, [], inv);
    const r = await post(s, '/api/beads/t-1/approve', {});
    assert.equal(r.statusCode, 409, name);
    assert.deepEqual(r.json(), { error }, name);
    assert.deepEqual(notes, [], name);
    assert.equal(inv.n, 1, `${name}: still invalidates`);
    await s.close();
  }
  const { beads, notes } = recorder([row('t-1'), row('t-2', { notes: 'plan-approved 2026-11-01T10:00:00.000Z' })]);
  const refuse = await app(env, beads, [], { n: 0 }, [], { build: 1, review: 3, mode: 'refuse' });
  const w = await post(refuse, '/api/beads/t-1/approve', {});
  assert.equal(w.statusCode, 409);
  assert.deepEqual(w.json(), { error: 'Build is at its WIP limit (1/1)' });
  assert.deepEqual(notes, []);
  await refuse.close();

  const s = await app(env, recorder([row('t-1')]).beads);
  const missing = await post(s, '/api/beads/t-nope/approve', {});
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: 'bead t-nope not found' });
  assert.equal((await post(s, '/api/beads/--help/approve', {})).statusCode, 404);
  await s.close();
});

/** A real Terminals over a fake spawn, with one live terminal for t-1 and one for t-2. */
function liveTerminals() {
  const written: [string, string][] = [];
  const spawn: SpawnPty = (_file, args) => ({
    pid: 1,
    write: (d) => void written.push([args[2]!, d]),
    resize() {},
    kill() {},
    onData() {},
    onExit() {},
  });
  const terminals = new Terminals({ spawn, nodePath: 'NODE', cliPath: 'CLI', maxSessions: 4, env: {} });
  terminals.start({ beadId: 't-1', cwd: '.', mode: 'work' });
  terminals.start({ beadId: 't-2', cwd: '.', mode: 'work' });
  return { terminals, written };
}

async function appWith(env: NodeJS.ProcessEnv, beads: Partial<FakeBeads>, terminals: unknown, errs: string[] = []) {
  const ctx = { ...buildCtx(env), err: (l: string) => errs.push(l), beads: beads as never };
  return createServer({ ctx, token: TOKEN, allowedHosts: 'any', model: { invalidate() {} } as never, terminals: terminals as never });
}

test('approve and request-changes type a line into the bead live terminal and report typed', async () => {
  const { env } = setup();
  const { terminals, written } = liveTerminals();
  const s = await appWith(env, recorder([row('t-1')]).beads, terminals);
  const a = await post(s, '/api/beads/t-1/approve', {});
  assert.equal(a.statusCode, 200);
  assert.deepEqual(a.json(), { approved: true, typed: 1 });
  const c = await post(s, '/api/beads/t-1/request-changes', { note: 'tighten\ncriterion 2' });
  assert.equal(c.statusCode, 200);
  assert.deepEqual(c.json(), { ok: true, typed: 1 });
  assert.deepEqual(written, [
    ['t-1', 'Spec approved. Start Build.\r'],
    ['t-1', 'Changes requested: tighten criterion 2\r'],
  ]);
  await s.close();
});

test('a failed approve types nothing; a typeLine that throws still reports success with typed 0', async () => {
  const { env } = setup();
  const { terminals, written } = liveTerminals();
  const s = await appWith(env, recorder([row('t-1', { status: 'closed' })]).beads, terminals);
  assert.equal((await post(s, '/api/beads/t-1/approve', {})).statusCode, 409);
  assert.deepEqual(written, []);
  await s.close();

  const errs: string[] = [];
  const broken = { typeLine: () => { throw new Error('input too large'); } };
  const { beads, notes, comments } = recorder([row('t-1')]);
  const b = await appWith(env, beads, broken, errs);
  const a = await post(b, '/api/beads/t-1/approve', {});
  assert.equal(a.statusCode, 200);
  assert.deepEqual(a.json(), { approved: true, typed: 0 });
  assert.equal(notes.length, 2, 'approval written');
  const c = await post(b, '/api/beads/t-1/request-changes', { note: 'x' });
  assert.deepEqual([c.statusCode, c.json()], [200, { ok: true, typed: 0 }]);
  assert.equal(comments.length, 1);
  assert.equal(errs.length, 2);
  assert.match(errs[0]!, /could not type into the terminal: input too large/);
  await b.close();
});

test('release puts a Specify bead back to open, unbinds it and invalidates', async () => {
  const { env } = setup();
  const statuses: [string, string][] = [];
  const { beads } = recorder([row('t-1')]);
  beads.setStatus = async (id, s) => void statuses.push([id, s]);
  const inv = { n: 0 };
  const s = await app(env, beads, [], inv);
  const r = await post(s, '/api/beads/t-1/release', {});
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { released: true });
  assert.deepEqual(statuses, [['t-1', 'open']]);
  assert.equal(inv.n, 1);
  await s.close();
});

test('release with a binding that cannot be cleared still releases, with a warning', async () => {
  const { env } = setup();
  const trackerDir = buildCtx(env).config.trackerDir;
  writeBinding(trackerDir, 'locked', { bead: 't-1' });
  writeBinding(trackerDir, 'free', { bead: 't-1' });
  // The writer saves to `<file>.<pid>.tmp` first. A directory at that path makes writeFileSync throw EISDIR on every platform.
  const blocker = join(trackerDir, '.strand', 'bindings', `locked.json.${process.pid}.tmp`);
  mkdirSync(blocker);
  try {
    const statuses: [string, string][] = [];
    const { beads } = recorder([row('t-1')]);
    beads.setStatus = async (id, s) => void statuses.push([id, s]);
    const s = await app(env, beads);
    const r = await post(s, '/api/beads/t-1/release', {});
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { released: true, warning: 'Released. 1 session binding(s) could not be cleared.' });
    assert.deepEqual(statuses, [['t-1', 'open']]);
    assert.equal(readBinding(trackerDir, 'free').bead, undefined);
    await s.close();
  } finally {
    rmSync(blocker, { recursive: true, force: true });
  }
});

test('release errors: not in Specify and a live terminal are 409, unknown or malformed id is 404', async () => {
  const { env } = setup();
  const statuses: [string, string][] = [];
  const mk = (rows: ListedBead[]) => {
    const { beads } = recorder(rows);
    beads.setStatus = async (id, st) => void statuses.push([id, st]);
    return beads;
  };
  const s = await app(env, mk([row('t-1', { status: 'open' }), row('t-2', { notes: 'plan-approved 2026-11-01T10:00:00.000Z' })]));
  const open = await post(s, '/api/beads/t-1/release', {});
  assert.deepEqual([open.statusCode, open.json()], [409, { error: 'bead t-1 is not in Specify' }]);
  const built = await post(s, '/api/beads/t-2/release', {});
  assert.deepEqual([built.statusCode, built.json()], [409, { error: 'bead t-2 is not in Specify' }]);
  const missing = await post(s, '/api/beads/t-nope/release', {});
  assert.deepEqual([missing.statusCode, missing.json()], [404, { error: 'bead t-nope not found' }]);
  assert.equal((await post(s, '/api/beads/--help/release', {})).statusCode, 404);
  await s.close();

  // The server asks the terminal manager; the client cannot say a session is stopped.
  const { terminals } = liveTerminals();
  const live = await appWith(env, mk([row('t-1')]), terminals);
  const r = await post(live, '/api/beads/t-1/release', {});
  assert.deepEqual([r.statusCode, r.json()], [409, { error: 'bead t-1 has a live session' }]);
  assert.deepEqual(statuses, []);
  await live.close();
});

test('approve: a failing bd write is a 500, not a 409', async () => {
  const { env } = setup();
  const { beads } = recorder([row('t-1')]);
  beads.note = async () => {
    throw new Error('disk full');
  };
  const s = await app(env, beads);
  assert.equal((await post(s, '/api/beads/t-1/approve', {})).statusCode, 500);
  await s.close();
});

test('request-changes writes a comment and invalidates; a bad note is 400; an unknown bead is 404', async () => {
  const { env } = setup();
  const { beads, comments } = recorder([row('t-1')]);
  const inv = { n: 0 };
  const s = await app(env, beads, [], inv);
  const r = await post(s, '/api/beads/t-1/request-changes', { note: 'tighten criterion 2' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, typed: 0 });
  assert.deepEqual(comments, [['t-1', 'changes requested: tighten criterion 2']]);
  assert.equal(inv.n, 1);
  for (const body of [{}, { note: '' }, { note: 'x'.repeat(2001) }, { note: 5 }, { note: null }]) {
    const bad = await post(s, '/api/beads/t-1/request-changes', body);
    assert.equal(bad.statusCode, 400, JSON.stringify(body));
    assert.deepEqual(bad.json(), { error: 'note must be 1 to 2000 characters' });
  }
  assert.equal(comments.length, 1);
  assert.equal((await post(s, '/api/beads/--help/request-changes', { note: 'x' })).statusCode, 404);
  await s.close();

  const gone = recorder([]);
  gone.beads.comment = async () => {
    throw new BdError('bd comments failed (exit 1): no issue found matching "t-nope"', 'Error: no issue found matching "t-nope"\n');
  };
  const s2 = await app(env, gone.beads);
  assert.equal((await post(s2, '/api/beads/t-nope/request-changes', { note: 'x' })).statusCode, 404);
  await s2.close();
});

const STORY = 'As a user, I want it, so that it works';

const UPDATED = '2026-11-23T09:00:00Z';
const baseRow = (o: Partial<ListedBead> = {}): ListedBead => row('t-1', { description: STORY, parent: 't-e', updated_at: UPDATED, ...o });
/** The version of the default editable bead. */
const V = beadVersion(baseRow() as never);
const put = (s: Awaited<ReturnType<typeof app>>, url: string, payload: unknown) => s.inject({ method: 'PUT', url, headers: H, payload: payload as never });

/** An editable Beads over one bead: show, update, note, comment, plus what the model reads for a 409. */
function editable(o: Partial<ListedBead> & { updated_at?: string } = {}) {
  const r = baseRow(o);
  const writes: [string, ...unknown[]][] = [];
  const beads = {
    listAll: async () => [r],
    show: async (id: string) => {
      if (id !== 't-1') throw new BdError('bd show failed (exit 1): no issue found matching "t-nope"', 'Error: no issue found matching "t-nope"\n');
      return { ...r };
    },
    comments: async () => [],
    update: async (id: string, f: Record<string, unknown>) => void writes.push(['update', id, f]),
    note: async (id: string, text: string) => void writes.push(['note', id, text]),
    comment: async (id: string, text: string) => void writes.push(['comment', id, text]),
  };
  return { beads: beads as unknown as Partial<FakeBeads>, writes, version: beadVersion(r as never) };
}

test('PUT /api/beads/:id saves, returns changed and rebaselined, invalidates', async () => {
  const { env } = setup();
  const e = editable();
  const inv = { n: 0 };
  const s = await app(env, e.beads, [], inv);
  const r = await put(s, '/api/beads/t-1', { version: V, title: 'New title', priority: 1 });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { changed: ['title', 'priority'], rebaselined: false });
  assert.deepEqual(e.writes, [['update', 't-1', { title: 'New title', priority: 1 }]]);
  assert.equal(inv.n, 1);
  await s.close();
});

test('PUT /api/beads/:id: bad bodies and filing problems are 400, nothing is written', async () => {
  const { env } = setup();
  const e = editable();
  const inv = { n: 0 };
  const s = await app(env, e.beads, [], inv);
  const bad: unknown[] = [
    {}, { title: 'x' }, { version: 5 }, { version: V, title: 5 }, { version: V, description: 5 }, { version: V, acceptance: [] }, { version: V, design: 1 },
    { version: V, type: 5 }, { version: V, priority: '1' }, { version: V, priority: 9 }, { version: V, priority: 1.5 }, { version: V, parent: 3 },
    { version: V, title: 'x'.repeat(61) }, { version: V, parent: '--x' },
    { version: V, repo: 5 }, { version: V, repo: '../x' }, { version: V, repo: 'nope' }, { version: V, context: 'docs' }, { version: V, context: [1] },
    { version: V, repo: 'app', context: ['nope'] }, { version: V, repo: '', context: ['docs'] },
  ];
  for (const body of bad) {
    const r = await put(s, '/api/beads/t-1', body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.equal(typeof r.json().error, 'string');
  }
  assert.equal((await put(s, '/api/beads/t-1', { version: V, title: 'x'.repeat(61) })).json().error, 'title is over 60 characters');
  assert.equal((await put(s, '/api/beads/t-1', { version: V, repo: 'nope' })).json().error, 'unknown repo nope');
  assert.deepEqual(e.writes, []);
  assert.equal(inv.n, bad.length + 2, 'every attempt invalidates');
  await s.close();

  // After approval the spec rules apply to an edit.
  const approved = editable({ notes: 'plan-approved 2026-11-01T10:00:00.000Z' });
  const a = await app(env, approved.beads);
  const strict: unknown[] = [
    { description: 'no story' }, { acceptance: '- [ ] no check' }, { acceptance: '- [ ] One (check: a)\n- [] typo (check: b)' }, { acceptance: '1. numbered (check: a)' },
  ];
  for (const body of strict) {
    const r = await put(a, '/api/beads/t-1', { version: approved.version, ...(body as object) });
    assert.equal(r.statusCode, 400, JSON.stringify(body));
  }
  assert.deepEqual(approved.writes, []);
  await a.close();
});

test('PUT /api/beads/:id: before approval the acceptance text is free; repos replace the labels; a primary change with a branch is 409', async () => {
  const { env } = setup();
  const e = editable({ labels: ['repo:app', 'keep'] });
  const s = await app(env, e.beads);
  const free = await put(s, '/api/beads/t-1', { version: e.version, description: 'no story yet', acceptance: 'it should be quick' });
  assert.deepEqual([free.statusCode, free.json()], [200, { changed: ['description', 'acceptance'], rebaselined: false }]);
  const repos = await put(s, '/api/beads/t-1', { version: e.version, repo: 'docs', context: ['app'] });
  assert.deepEqual([repos.statusCode, repos.json()], [200, { changed: ['repos'], rebaselined: false }]);
  assert.deepEqual(e.writes[1], ['update', 't-1', { addLabels: ['repo:docs', 'context:app'], removeLabels: ['repo:app'] }]);
  await s.close();

  const b = editable({ labels: ['repo:app', 'branch:ada/x'] });
  const s2 = await app(env, b.beads);
  const moved = await put(s2, '/api/beads/t-1', { version: b.version, repo: 'docs' });
  assert.deepEqual([moved.statusCode, moved.json()], [409, { error: 'bead t-1 has a branch in app' }]);
  assert.deepEqual(b.writes, []);
  await s2.close();
});

test('GET /api/repos lists the workspace repos read at startup; POST /api/repos/refresh reads them again', async () => {
  const { env, ws, tracker } = setup();
  // The tracker is a git repo in the workspace, but it is never listed.
  mkdirSync(join(tracker, '.git'), { recursive: true });
  const s = await app(env);
  const first = await s.inject({ url: '/api/repos', headers: H });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json().repos, ['app', 'docs']);
  assert.match(first.json().at, /^\d{4}-\d\d-\d\dT/);
  mkdirSync(join(ws, 'Billing', '.git'), { recursive: true });
  assert.deepEqual((await s.inject({ url: '/api/repos', headers: H })).json().repos, ['app', 'docs'], 'kept in memory');
  const fresh = await post(s, '/api/repos/refresh', {});
  assert.equal(fresh.statusCode, 200);
  assert.deepEqual(fresh.json().repos, ['app', 'Billing', 'docs']);
  assert.deepEqual((await s.inject({ url: '/api/repos', headers: H })).json().repos, ['app', 'Billing', 'docs']);
  assert.equal((await s.inject({ url: '/api/repos' })).statusCode, 401);
  assert.equal((await s.inject({ method: 'POST', url: '/api/repos/refresh' })).statusCode, 401);
  await s.close();
});

test('PUT /api/beads/:id: an unknown or malformed id is 404', async () => {
  const { env } = setup();
  const s = await app(env, editable().beads);
  assert.equal((await put(s, '/api/beads/--help', { version: V, title: 'x' })).statusCode, 404);
  const gone = await put(s, '/api/beads/t-nope', { version: V, title: 'x' });
  assert.equal(gone.statusCode, 404);
  assert.deepEqual(gone.json(), { error: 'bead t-nope not found' });
  await s.close();
});

test('approve with the version the engineer looked at: a stale one is 409 with the current bead and approves nothing', async () => {
  const { env } = setup();
  const e = editable({ acceptance_criteria: '- [ ] Rewritten by Claude (check: t)' });
  const ctx = { ...buildCtx(env), err: () => {}, beads: e.beads as never };
  const s = await createServer({ ctx, token: TOKEN, allowedHosts: 'any', model: new Model(ctx) });
  const stale = await post(s, '/api/beads/t-1/approve', { version: V });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, 'This bead changed since you opened it.');
  assert.equal(stale.json().current.version, e.version);
  assert.deepEqual(e.writes, []);
  assert.equal((await post(s, '/api/beads/t-1/approve', { version: 5 })).statusCode, 400);
  assert.equal((await post(s, '/api/beads/t-nope/approve', { version: V })).statusCode, 404);
  assert.deepEqual(e.writes, []);
  const ok = await post(s, '/api/beads/t-1/approve', { version: e.version });
  assert.equal(ok.statusCode, 200);
  assert.equal(e.writes[0]![0], 'note');
  await s.close();
});

test('PUT /api/beads/:id: a stale version is 409 with the current bead, and nothing is written', async () => {
  const { env } = setup();
  const e = editable({ title: 'Changed elsewhere' });
  // The 409 carries a real BeadDetail, so this one runs over the real read model.
  const ctx = { ...buildCtx(env), err: () => {}, beads: e.beads as never };
  const s = await createServer({ ctx, token: TOKEN, allowedHosts: 'any', model: new Model(ctx) });
  const r = await put(s, '/api/beads/t-1', { version: '2026-11-23T08:00:00Z', title: 'Mine' });
  assert.equal(r.statusCode, 409);
  const body = r.json();
  assert.equal(body.error, 'This bead changed since you opened it.');
  assert.equal(body.current.id, 't-1');
  assert.equal(body.current.title, 'Changed elsewhere');
  assert.equal(body.current.version, e.version);
  assert.deepEqual(e.writes, []);
  await s.close();
});

test('PUT /api/beads/:id: a closed bead is 409 with a plain error', async () => {
  const { env } = setup();
  const e = editable({ status: 'closed' });
  const s = await app(env, e.beads);
  const r = await put(s, '/api/beads/t-1', { version: V, title: 'x' });
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.json(), { error: 'bead t-1 is closed' });
  assert.deepEqual(e.writes, []);
  await s.close();
});

test('PUT /api/beads/:id: bd refusing the write (unknown parent) is 400 with its reason; other failures are 500', async () => {
  const { env } = setup();
  const e = editable();
  (e.beads as unknown as { update: unknown }).update = async () => {
    throw new BdError('bd update failed', 'Error: parent issue t-zzz not found\n');
  };
  const s = await app(env, e.beads);
  const r = await put(s, '/api/beads/t-1', { version: V, parent: 't-zzz' });
  assert.equal(r.statusCode, 400);
  assert.deepEqual(r.json(), { error: 'Error: parent issue t-zzz not found' });
  (e.beads as unknown as { update: unknown }).update = async () => {
    throw new Error('disk full');
  };
  assert.equal((await put(s, '/api/beads/t-1', { version: V, title: 'y' })).statusCode, 500);
  await s.close();
});

test('PUT /api/beads/:id: any other bd failure is a 503 Beads unavailable, not a 400', async () => {
  const { env } = setup();
  const e = editable();
  (e.beads as unknown as { update: unknown }).update = async () => {
    throw new BdError('bd update failed', 'Error: database is locked\n');
  };
  const s = await app(env, e.beads);
  const r = await put(s, '/api/beads/t-1', { version: V, title: 'y' });
  assert.equal(r.statusCode, 503);
  assert.deepEqual(r.json(), { error: 'Beads unavailable: Error: database is locked' });
  await s.close();
});

test('PUT /api/beads/:id: a failed note after the write is a 200 with the warning', async () => {
  const { env } = setup();
  const e = editable({ notes: 'plan-approved 2026-11-01T10:00:00.000Z' });
  (e.beads as unknown as { note: unknown }).note = async () => {
    throw new Error('disk full');
  };
  const s = await app(env, e.beads);
  const r = await put(s, '/api/beads/t-1', { version: V, acceptance: '- [ ] It works (check: node --test)\n- [ ] More (check: x)' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { changed: ['acceptance'], rebaselined: false, warning: 'Saved. The criteria baseline or the comment was not recorded: disk full' });
  await s.close();
});

test('POST /api/beads passes description, acceptance and parent through, validates, invalidates', async () => {
  const { env } = setup();
  const made: unknown[] = [];
  const inv = { n: 0 };
  const s = await app(env, { create: async (i) => (made.push(i), { id: 't-9', title: 'X', issue_type: 'task', priority: 1, labels: ['repo:app'] }) }, [], inv);
  const r = await post(s, '/api/beads', { title: 'X', type: 'task', priority: 1, repo: 'app', parent: 't-1', description: STORY, acceptance: CRITERIA });
  assert.equal(r.statusCode, 201);
  assert.deepEqual(r.json(), { id: 't-9', title: 'X', type: 'task', priority: 1, labels: ['repo:app'] });
  assert.deepEqual(made[0], { title: 'X', type: 'task', priority: 1, labels: ['repo:app'], parent: 't-1', description: STORY, acceptance: CRITERIA });
  const ok = { description: STORY, acceptance: CRITERIA, parent: 't-1' };
  for (const bad of [{}, { title: ' ', type: 'task' }, { title: 'x' }, { title: 'x', type: '-t' }, { title: 'x', type: 'task', priority: 9, ...ok }, { title: 'x', type: 'task', repo: '../x', ...ok }, { title: 'x', type: 'task', ...ok, parent: '--x' }, { title: 5, type: 'task' }, { title: 'x', type: 'task', ...ok, description: 5 }]) {
    const b = await post(s, '/api/beads', bad);
    assert.equal(b.statusCode, 400, JSON.stringify(bad));
    assert.equal(typeof b.json().error, 'string');
  }
  assert.equal(made.length, 1);
  assert.equal(inv.n, 10, 'every attempt invalidates');
  const form = await s.inject({ method: 'POST', url: '/api/beads', headers: { ...H, 'content-type': 'text/plain' }, payload: 'x' });
  assert.equal(form.statusCode, 415);
  await s.close();
});

test('POST /api/beads: each capture rule and repo check comes back as a 400 with its message and creates nothing', async () => {
  const { env } = setup();
  const made: unknown[] = [];
  const s = await app(env, { create: async (i) => (made.push(i), {}) });
  const base = { title: 'X', type: 'task', parent: 't-1' };
  const cases: [Record<string, unknown>, string][] = [
    [{ title: 'x'.repeat(61) }, 'title is over 60 characters'],
    [{ parent: undefined }, 'needs a parent epic'],
    [{ repo: 'nope' }, 'unknown repo nope'],
    [{ repo: 'app', context: ['docs', 'gone'] }, 'unknown repo gone'],
    [{ context: ['docs'] }, 'a bead with context folders needs a primary repo'],
    [{ repo: 'app', context: 'docs' }, 'invalid context'],
    [{ repo: 'app', context: ['../x'] }, 'invalid repo name ../x'],
  ];
  for (const [over, error] of cases) {
    const r = await post(s, '/api/beads', { ...base, ...over });
    assert.equal(r.statusCode, 400, error);
    assert.deepEqual(r.json(), { error }, error);
  }
  assert.deepEqual(made, []);
  await s.close();
});

test('POST /api/beads: an empty repo name is refused by name', async () => {
  const { env } = setup();
  const s = await app(env, { create: async () => ({}) });
  const r = await post(s, '/api/beads', { title: 'X', type: 'task', parent: 't-1', repo: '' });
  assert.deepEqual([r.statusCode, r.json()], [400, { error: 'invalid repo name: empty' }]);
  await s.close();
});

test('POST /api/beads: a title only is enough; free-text criteria and context folders are kept', async () => {
  const { env } = setup();
  const made: unknown[] = [];
  const s = await app(env, { create: async (i) => (made.push(i), { id: 't-9', title: 'X', issue_type: 'task', priority: 2, labels: [] }) });
  assert.equal((await post(s, '/api/beads', { title: 'X', type: 'task', parent: 't-1' })).statusCode, 201);
  assert.deepEqual(made[0], { title: 'X', type: 'task', priority: 2, labels: [], parent: 't-1', description: undefined, acceptance: undefined });
  const r = await post(s, '/api/beads', { title: 'X', type: 'task', parent: 't-1', acceptance: 'it is quick', repo: 'app', context: ['docs', 'app', 'docs'] });
  assert.equal(r.statusCode, 201);
  assert.deepEqual(made[1], { title: 'X', type: 'task', priority: 2, labels: ['repo:app', 'context:docs'], parent: 't-1', description: undefined, acceptance: 'it is quick' });
  await s.close();
});

test('GET artefact streams with type, nosniff, sandbox for html; refused rel is 400', async () => {
  const { env, symlinks } = setup();
  const s = await app(env);
  const html = await s.inject({ url: '/api/beads/t-1/artefact?rel=mockup.html', headers: H });
  assert.equal(html.statusCode, 200);
  assert.equal(html.body, '<h1>hi</h1>');
  assert.match(String(html.headers['content-type']), /^text\/html/);
  assert.equal(html.headers['content-disposition'], 'inline');
  assert.equal(html.headers['x-content-type-options'], 'nosniff');
  assert.equal(html.headers['content-security-policy'], "sandbox; frame-ancestors 'self'");
  const gz = await s.inject({ url: '/api/beads/t-1/artefact?rel=sessions/s1.jsonl.gz', headers: H });
  assert.equal(gz.headers['content-security-policy'], "frame-ancestors 'self'", 'no sandbox for non-HTML');
  assert.equal(gz.headers['content-type'], 'application/gzip');
  const refused = ['../x', '/etc/passwd', 'run.ps1', 'nope.html', ''];
  if (symlinks) refused.push('link/secret.txt');
  for (const rel of refused) {
    const r = await s.inject({ url: `/api/beads/t-1/artefact?rel=${encodeURIComponent(rel)}`, headers: H });
    assert.equal(r.statusCode, 400, rel);
    assert.match(r.json().error, /^refused: /);
  }
  assert.equal((await s.inject({ url: '/api/beads/t-1/artefact', headers: H })).statusCode, 400);
  assert.equal((await s.inject({ url: '/api/beads/t-1/artefact?rel=mockup.html' })).statusCode, 401);
  await s.close();
});

test('primitive and null throws are 500 internal error and logged', async () => {
  const { env } = setup();
  for (const thrown of ['x', null, 42]) {
    const errs: string[] = [];
    const ctx = { ...buildCtx(env), err: (l: string) => errs.push(l) };
    const model = { invalidate() {}, board: async () => { throw thrown; } } as never;
    const s = await createServer({ ctx, token: TOKEN, allowedHosts: 'any', model });
    const r = await s.inject({ url: '/api/board', headers: H });
    assert.equal(r.statusCode, 500);
    assert.deepEqual(r.json(), { error: 'internal error' });
    assert.deepEqual(errs, [`cockpit: GET /api/board failed: ${String(thrown)}`]);
    await s.close();
  }
});

test('open: allowlist, Windows-name tricks, exec bits; GET keeps denylist only', async (t) => {
  const { env, tracker } = setup();
  const art = join(tracker, 'artefacts', 't-1');
  for (const f of ['x.hta', 'x.command', 'x.scr', 'x.desktop', 'plain', 'doc.md', 'pic.PNG', 'data.csv']) writeFileSync(join(art, f), 'x');
  const opened: string[] = [];
  const s = await app(env, {}, opened);
  for (const path of ['run.bat.', 'run.bat ', 'run.bat::$DATA', 'x.hta', 'x.command', 'x.scr', 'x.desktop', 'plain', 'run.ps1']) {
    const r = await post(s, '/api/open', { path, beadId: 't-1' });
    assert.equal(r.statusCode, 400, path);
    assert.match(r.json().error, /^refused: /);
  }
  assert.equal((await post(s, '/api/open', { path: 'x.hta', beadId: 't-1' })).json().error, "refused: this file type can't be opened from the cockpit");
  assert.deepEqual(opened, []);
  for (const path of ['mockup.html', 'doc.md', 'pic.PNG', 'data.csv', 'sessions/s1.jsonl.gz']) {
    assert.equal((await post(s, '/api/open', { path, beadId: 't-1' })).statusCode, 200, path);
  }
  if (process.platform !== 'win32') {
    const { chmodSync } = await import('node:fs');
    writeFileSync(join(art, 'tool.txt'), 'x');
    chmodSync(join(art, 'tool.txt'), 0o755);
    assert.equal((await post(s, '/api/open', { path: 'tool.txt', beadId: 't-1' })).statusCode, 400);
    writeFileSync(join(art, 'noext'), 'x');
    chmodSync(join(art, 'noext'), 0o755);
    assert.equal((await post(s, '/api/open', { path: 'noext', beadId: 't-1' })).statusCode, 400);
  } else t.diagnostic('exec-bit checks are POSIX only');
  // GET still serves other types as octet-stream, but never the denylist or odd names.
  assert.equal((await s.inject({ url: '/api/beads/t-1/artefact?rel=x.hta', headers: H })).headers['content-type'], 'application/octet-stream');
  assert.equal((await s.inject({ url: '/api/beads/t-1/artefact?rel=run.ps1', headers: H })).statusCode, 400);
  await s.close();
});

test('a symlink from one bead into another is refused', (t) => {
  const { tracker, symlinks } = setup();
  if (!symlinks) return t.skip('symlinks unavailable');
  const other = join(tracker, 'artefacts', 't-2');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'secret.html'), 's');
  symlinkSync(other, join(tracker, 'artefacts', 't-1', 'peek'), 'dir');
  assert.throws(() => resolveArtefact(tracker, 't-1', 'peek/secret.html'), /refused: path escapes/);
});

test('repo names with a comma are 400', async () => {
  const { env } = setup();
  const s = await app(env, { create: async () => ({}) });
  assert.equal((await post(s, '/api/beads', { title: 'x', type: 'task', repo: 'a,repo:b', description: STORY, acceptance: CRITERIA, parent: 't-1' })).statusCode, 400);
  await s.close();
});

test('POST /api/beads: a bd failure is 400 with its first stderr line; a hung bd is 503', async () => {
  const { env } = setup();
  const failing = new BdError('bd create failed (exit 1): Error: parent issue nope-1 not found', 'Error: parent issue nope-1 not found\nHint: x\n');
  const s = await app(env, { create: async () => { throw failing; } } as never);
  const r = await post(s, '/api/beads', { title: 'X', type: 'task', parent: 'nope-1', description: STORY, acceptance: CRITERIA });
  assert.equal(r.statusCode, 400);
  assert.deepEqual(r.json(), { error: 'Error: parent issue nope-1 not found' });
  await s.close();
  const hung = await app(env, { create: async () => { throw new Error('bd did not answer within 20 s'); } } as never);
  const h = await post(hung, '/api/beads', { title: 'X', type: 'task', parent: 't-1', description: STORY, acceptance: CRITERIA });
  assert.equal(h.statusCode, 503);
  assert.deepEqual(h.json(), { error: 'Beads unavailable: bd did not answer within 20 s' });
  await hung.close();
});

test('artefacts may be framed only by the cockpit itself; HTML stays sandboxed', async () => {
  const { env } = setup();
  const s = await app(env);
  const html = await s.inject({ url: '/api/beads/t-1/artefact?rel=mockup.html', headers: H });
  assert.equal(html.headers['content-security-policy'], "sandbox; frame-ancestors 'self'");
  assert.equal(html.headers['x-frame-options'], 'SAMEORIGIN');
  const other = await s.inject({ url: '/api/beads/t-1/artefact?rel=sessions/s1.jsonl.gz', headers: H });
  assert.equal(other.statusCode, 200);
  assert.equal(other.headers['content-security-policy'], "frame-ancestors 'self'");
  assert.equal(other.headers['x-frame-options'], 'SAMEORIGIN');
  await s.close();
});
