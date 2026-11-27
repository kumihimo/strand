import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { baseEnv, runWith } from './fixtures/env.ts';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/core/exec.ts';
import { Beads } from '../src/core/bd.ts';
import { readBinding } from '../src/core/binding.ts';
import { buildCtx } from '../src/cli/ctx.ts';
import { recordEnd, recordStart } from '../src/core/sessions.ts';
import { runCli } from '../src/cli/strand.ts';
import { main as pr } from '../src/cli/commands/pr.ts';

const hasBd = await run('bd', ['--version']).then((r) => r.code === 0, () => false);
const skip = hasBd ? false : 'bd not on PATH';
const STRAND = join(import.meta.dirname, '..', 'src', 'cli', 'strand.ts');

let ws = '';
let tracker = '';
let repoDir = '';
let beads: Beads;
let server: Server;
let giteaUrl = '';
let pulls: unknown[] = [];
let created: { title: string; body: string; head: string; base: string }[] = [];
let env: NodeJS.ProcessEnv = {};
let epic = '';

const STORY = 'As a dev, I want a thing, so that it works.';
const CRIT = '- [ ] It works (check: make test)';
const APPROVED = 'plan-approved 2026-11-20T10:00:00.000Z';

before(async () => {
  if (!hasBd) return;
  ws = mkdtempSync(join(tmpdir(), 'strand-cli-'));
  tracker = join(ws, 'tracker');
  repoDir = join(ws, 'orders-service');
  const cfg = join(ws, 'config');
  for (const d of [tracker, repoDir, cfg]) mkdirSync(d);
  for (const d of [tracker, repoDir]) {
    await run('git', ['init', '-q'], { cwd: d });
    await run('git', ['config', 'user.name', 'T'], { cwd: d });
    await run('git', ['config', 'user.email', 't@example.com'], { cwd: d });
    await run('git', ['config', 'commit.gpgsign', 'false'], { cwd: d });
  }
  await run('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: tracker });
  const init = await runWith('bd', ['init', '--prefix', 't'], { cwd: tracker, env: { ...baseEnv(), BD_NON_INTERACTIVE: '1' } });
  assert.equal(init.code, 0, init.stderr);
  beads = new Beads(tracker);
  epic = (await beads.create({ title: 'Epic', type: 'epic' })).id;

  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.includes('/actions/runs')) return res.end(JSON.stringify({ workflow_runs: [] }));
    if (req.method === 'POST' && req.url?.includes('/pulls')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = JSON.parse(body);
        created.push(p);
        res.end(JSON.stringify({ number: 9, state: 'open', merged: false, html_url: 'http://g/acme/orders-service/pulls/9', head: { ref: p.head, sha: 'abc' } }));
      });
      return;
    }
    if (req.url?.includes('/pulls')) return res.end(JSON.stringify(pulls));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  giteaUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  await run('git', ['remote', 'add', 'origin', `${giteaUrl}/acme/orders-service.git`], { cwd: repoDir });

  // Every config location points into the sandbox on all three OSes (in-process and spawned).
  env = { ...baseEnv(), STRAND_WORKSPACE: ws, XDG_CONFIG_HOME: cfg, APPDATA: cfg, HOME: cfg, USERPROFILE: cfg, STRAND_DRY_RUN_CLAUDE: '1' };
  delete env.STRAND_GITEA_URL;
  delete env.STRAND_GITEA_TOKEN;
  delete env.BEADS_DIR;
  delete env.BEADS_ACTOR;
});

after(() => {
  server?.close();
  if (ws) rmSync(ws, { recursive: true, force: true });
});

function cliCtx(o: { gitea?: boolean; wip?: { build: number; review: number; mode: 'warn' | 'refuse' }; vcs?: 'none' | 'git' | 'git-lfs'; cwd?: string }, out: string[], err: string[]) {
  const e = o.gitea ? { ...env, STRAND_GITEA_URL: giteaUrl, STRAND_GITEA_TOKEN: 'tok' } : env;
  const ctx = buildCtx(e, { out: (s) => out.push(s), err: (s) => err.push(s) });
  if (o.wip) ctx.config.wip = o.wip;
  if (o.vcs) ctx.config.artefactsVcs = o.vcs;
  ctx.cwd = o.cwd ?? ws;
  return ctx;
}

async function cli(args: string[], o: { gitea?: boolean; wip?: { build: number; review: number; mode: 'warn' | 'refuse' }; vcs?: 'none' | 'git' | 'git-lfs'; cwd?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx = cliCtx(o, out, err);
  const code = await runCli(args, ctx);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** `node <entry> ...args` (the strand CLI by default) with exactly the sandbox env, never merged over process.env. */
const spawnCli = (args: string[], entry = STRAND, e: NodeJS.ProcessEnv = env) => runWith(process.execPath, [entry, ...args], { env: e });

// Needs no bd: it runs everywhere, not under the bd skip.
test('spawnCli gives the child exactly the sandbox env: no STRAND_CONFIG_DIR, BEADS_DIR or BEADS_ACTOR from the shell', async () => {
  const keys = ['STRAND_CONFIG_DIR', 'BEADS_DIR', 'BEADS_ACTOR'] as const;
  const saved = keys.map((k) => process.env[k]);
  const dir = mkdtempSync(join(tmpdir(), 'strand-env-probe-'));
  const probe = join(dir, 'print-env.mjs');
  writeFileSync(probe, `process.stdout.write(JSON.stringify(${JSON.stringify(keys)}.map((k) => process.env[k] ?? null)));\n`);
  try {
    process.env.STRAND_CONFIG_DIR = join(dir, 'leak-cfg');
    process.env.BEADS_DIR = join(dir, 'leak-beads');
    process.env.BEADS_ACTOR = 'leak-actor';
    // The sandbox env is built while the shell has all three set, as a test's before() would be.
    const r = await spawnCli([], probe, { ...baseEnv(), HOME: dir, USERPROFILE: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [null, null, null]);
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('new (real process) creates a bead with the repo label and prints JSON', { skip }, async () => {
  const r = await spawnCli(['new', 'Stream orders', '--type', 'feature', '--repo', 'orders-service', '--description', STORY, '--acceptance', CRIT, '--parent', epic, '--json']);
  assert.equal(r.code, 0, r.stderr);
  const id = JSON.parse(r.stdout).id as string;
  const b = await beads.show(id);
  assert.equal(b.title, 'Stream orders');
  assert.equal(b.issue_type, 'feature');
  assert.deepEqual(b.labels, ['repo:orders-service']);
  const plain = await cli(['new', 'Plain', '--type', 'chore', '--parent', epic]);
  assert.equal(plain.code, 0);
  assert.match(plain.out, /^t-[a-z0-9]+(\.\d+)?$/);
});

test('work (real process) without a repo label prints one error line and exits 1', { skip }, async () => {
  const b = await beads.create({ title: 'No repo', type: 'task' });
  const r = await spawnCli(['work', b.id]);
  assert.equal(r.code, 1);
  assert.equal(r.stderr, `error: bead ${b.id} has no repo: label\n`);
});

test('work with a repo label whose folder is missing exits 1', { skip }, async () => {
  const b = await beads.create({ title: 'Ghost', type: 'task', labels: ['repo:ghost-service'] });
  const r = await cli(['work', b.id]);
  assert.equal(r.code, 1);
  assert.equal(r.err, `error: repo folder ${join(ws, 'ghost-service')} not found`);
});

test('work on a valid bead claims it, records the session and prints the claude command', { skip }, async () => {
  const b = await beads.create({ title: 'Stream orders', type: 'feature', labels: ['repo:orders-service'] });
  const r = await cli(['work', b.id]);
  assert.equal(r.code, 0, r.err);
  const m = new RegExp(`^claude --session-id ([0-9a-f-]{36}) --model opus --effort high --name "${b.id} Stream orders"$`, 'm').exec(r.out);
  assert.ok(m, r.out);
  assert.match(r.out, new RegExp(`^cwd: ${repoDir.replace(/[\\.]/g, '\\$&')}$`, 'm'));
  const sid = m[1]!;
  assert.equal((await beads.show(b.id)).status, 'in_progress');
  const entry = JSON.parse(readFileSync(join(tracker, '.strand', 'sessions', `${sid}.json`), 'utf8'));
  assert.equal(entry.beadId, b.id);
  assert.ok(!entry.endedAt);
  assert.ok((await beads.comments(b.id)).some((c) => c.text === `session ${sid} started`));

  const j = await cli(['work', b.id, '--format', 'ears', '--json']);
  const data = JSON.parse(j.out);
  assert.equal(data.cwd, repoDir);
  assert.equal(data.command, 'claude');
  assert.deepEqual(data.env, { STRAND_BEAD_ID: b.id, STRAND_SPEC_FORMAT: 'ears' });
});

test('work --specify starts with the first prompt, not in plan mode, and --resume of an unknown session is refused', { skip }, async () => {
  const b = await beads.create({ title: 'Plan first', type: 'task', labels: ['repo:orders-service'] });
  const s = await cli(['work', b.id, '--specify', '--json']);
  assert.equal(s.code, 0, s.err);
  const data = JSON.parse(s.out);
  assert.deepEqual(data.args.slice(-3), ['--name', `${b.id} Plan first`, `/strand:work ${b.id}`]);
  assert.ok(!data.args.includes('--permission-mode'));
  const sid = '00000000-0000-0000-0000-000000000000';
  const r = await cli(['work', b.id, '--resume', sid]);
  assert.equal(r.code, 1);
  assert.equal(r.err, `error: session ${sid} is not a session of bead ${b.id}`);
});

test('a failed claude launch ends the session and reports the missing tool once', { skip }, async () => {
  const b = await beads.create({ title: 'No claude', type: 'task', labels: ['repo:orders-service'] });
  const out: string[] = [];
  const err: string[] = [];
  const e = { ...env, PATH: join(ws, 'config'), STRAND_DRY_RUN_CLAUDE: '' };
  const code = await runCli(['work', b.id], buildCtx(e, { out: (s) => out.push(s), err: (s) => err.push(s) }));
  assert.equal(code, 1);
  assert.deepEqual(err, ['error: claude not found — Install claude and make sure it is on PATH']);
  const started = (await beads.comments(b.id)).map((c) => c.text);
  const sid = /^session (\S+) started$/.exec(started.find((t) => t.endsWith(' started')) ?? '')?.[1];
  assert.ok(sid, started.join('|'));
  assert.ok(started.includes(`session ${sid} failed to start`));
  const entry = JSON.parse(readFileSync(join(tracker, '.strand', 'sessions', `${sid}.json`), 'utf8'));
  assert.ok(entry.endedAt);
});

test('keep moves a scratch file, commits only it and notes the bead', { skip }, async () => {
  const b = await beads.create({ title: 'Mockups', type: 'task' });
  const scratch = join(tracker, 'artefacts', b.id, 'scratch', 'mockup-v3.html');
  mkdirSync(join(scratch, '..'), { recursive: true });
  writeFileSync(scratch, '<html></html>');
  const r = await cli(['keep', b.id, 'mockup-v3.html'], { vcs: 'git' });
  assert.equal(r.code, 0, r.err);
  const kept = join(tracker, 'artefacts', b.id, 'mockup-v3.html');
  assert.ok(existsSync(kept));
  assert.ok(!existsSync(scratch));
  const log = await run('git', ['log', '-1', '--format=%s'], { cwd: tracker });
  assert.equal(log.stdout.trim(), `${b.id}: keep mockup-v3.html`);
  const files = await run('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: tracker });
  assert.equal(files.stdout.trim(), `artefacts/${b.id}/mockup-v3.html`);
  assert.match((await beads.show(b.id)).notes ?? '', /kept mockup-v3\.html/);

  const missing = await cli(['keep', b.id, 'nope.html']);
  assert.equal(missing.code, 1);
  assert.equal(missing.err, 'error: no such scratch file');
  const escape = await cli(['keep', b.id, '../x.html']);
  assert.equal(escape.code, 1);
  assert.match(escape.err, /^error: /);
});

test('work refuses a closed bead and never reopens it', { skip }, async () => {
  const b = await beads.create({ title: 'Finished', type: 'task', labels: ['repo:orders-service'] });
  await beads.close(b.id, 'done');
  const r = await cli(['work', b.id]);
  assert.equal(r.code, 1);
  assert.equal(r.err, `error: bead ${b.id} is closed`);
  assert.equal((await beads.show(b.id)).status, 'closed');
});

test("keep with artefactsVcs 'none' moves and notes without committing", { skip }, async () => {
  const b = await beads.create({ title: 'Plain keep', type: 'task' });
  const scratch = join(tracker, 'artefacts', b.id, 'scratch', 'shot.png');
  mkdirSync(join(scratch, '..'), { recursive: true });
  writeFileSync(scratch, 'png');
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: tracker })).stdout;
  const r = await cli(['keep', b.id, 'shot.png'], { vcs: 'none' });
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(tracker, 'artefacts', b.id, 'shot.png')));
  assert.ok(!existsSync(scratch));
  assert.equal((await run('git', ['rev-parse', 'HEAD'], { cwd: tracker })).stdout, head);
  assert.match((await beads.show(b.id)).notes ?? '', /kept shot\.png/);
});

test('archive comments on the bead in every mode', { skip }, async () => {
  const b = await beads.create({ title: 'Archived', type: 'task' });
  const src = join(ws, 'transcript.jsonl');
  writeFileSync(src, '{}\n');
  recordStart(tracker, { sessionId: 'arch-1', beadId: b.id });
  recordEnd(tracker, { sessionId: 'arch-1', transcriptPath: src });
  const r = await cli(['archive', '--json'], { vcs: 'none' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).archived, [join(tracker, 'artefacts', b.id, 'sessions', 'arch-1.jsonl.gz')]);
  assert.ok((await beads.comments(b.id)).some((c) => c.text === 'session arch-1 archived'));
});

test('new defaults --repo to the current folder when it sits in the workspace root', { skip }, async () => {
  const inRepo = await cli(['new', 'From repo folder', '--type', 'chore', '--parent', epic, '--json'], { cwd: repoDir });
  assert.equal(inRepo.code, 0, inRepo.err);
  assert.deepEqual(JSON.parse(inRepo.out).labels, ['repo:orders-service']);
  const nested = join(repoDir, 'src');
  mkdirSync(nested, { recursive: true });
  const elsewhere = await cli(['new', 'From elsewhere', '--type', 'chore', '--parent', epic, '--json'], { cwd: nested });
  assert.deepEqual(JSON.parse(elsewhere.out).labels, []);
});

test('new accepts repo names with spaces and rejects path-like ones', { skip }, async () => {
  const ok = await cli(['new', 'Spaced', '--type', 'chore', '--parent', epic, '--repo', 'orders service', '--json']);
  assert.equal(ok.code, 0, ok.err);
  assert.deepEqual(JSON.parse(ok.out).labels, ['repo:orders service']);
  for (const bad of ['.', '..', 'a/b', 'a\\b', '', 'x..y']) {
    const r = await cli(['new', 'Bad', '--type', 'chore', '--parent', epic, '--repo', bad]);
    assert.equal(r.code, 1, bad);
    assert.equal(r.err, bad === '' ? 'error: invalid repo name: empty' : `error: invalid repo name ${bad}`);
  }
});

test('work rejects a repo:. label', { skip }, async () => {
  const b = await beads.create({ title: 'Dot repo', type: 'task', labels: ['repo:.'] });
  const r = await cli(['work', b.id]);
  assert.equal(r.code, 1);
  assert.equal(r.err, `error: bead ${b.id} has an invalid repo label: repo:.`);
});


test('brief --json: waiting holds specify beads with criteria and review beads, with no gate field', { skip }, async () => {
  const spec = await beads.create({ title: 'Needs approval', type: 'task', parent: epic, description: STORY, acceptance: CRIT });
  await beads.claim(spec.id);
  const bare = await beads.create({ title: 'No criteria yet', type: 'chore', parent: epic });
  await beads.claim(bare.id);
  const rv = await beads.create({ title: 'In review', type: 'task', parent: epic, description: STORY, acceptance: CRIT });
  await beads.note(rv.id, APPROVED);
  await beads.setAcceptance(rv.id, '- [x] It works (verified: make test passed)');
  await beads.addLabel(rv.id, 'pr:acme/orders-service#3');
  const j = JSON.parse((await cli(['brief', '--json'])).out);
  assert.deepEqual(Object.keys(j), ['waiting', 'ready', 'blocked', 'wip', 'sessions']);
  assert.deepEqual(j.waiting.find((w: { id: string }) => w.id === spec.id), { id: spec.id, title: 'Needs approval', action: 'approve spec' });
  assert.deepEqual(j.waiting.find((w: { id: string }) => w.id === rv.id), { id: rv.id, title: 'In review', action: 'review' });
  assert.ok(!j.waiting.some((w: { id: string }) => w.id === bare.id));
  assert.ok(j.wip.review.count >= 1);
  assert.deepEqual(Object.keys(j.wip.build), ['count', 'limit']);
  assert.ok(!j.ready.some((r: { id: string }) => r.id === epic), 'epics are not ready work');
  const text = await cli(['brief']);
  assert.equal(text.code, 0, text.err);
  const heads = ['Waiting on you', 'Ready', 'Blocked', 'WIP', 'Live sessions'].map((h) => text.out.indexOf(h));
  assert.ok(heads.every((i, k) => i >= 0 && (k === 0 || i > heads[k - 1]!)), text.out);
  assert.match(text.out, new RegExp(`${spec.id}  approve spec  Needs approval`));
});

test('brief shows the WIP warning when a limit is reached', { skip }, async () => {
  const r = await cli(['brief'], { wip: { build: 99, review: 1, mode: 'warn' } });
  assert.match(r.out, /warning: Review is at its WIP limit \(\d+\/1\)/);
});

test('archive, pr without Gitea and unknown commands', { skip }, async () => {
  const a = await cli(['archive', '--json']);
  assert.equal(a.code, 0, a.err);
  assert.deepEqual(JSON.parse(a.out), { archived: [] });
  const b = await beads.create({ title: 'Pull me', type: 'task', labels: ['repo:orders-service', 'branch:ada/pull-me'] });
  const p = await cli(['pr', b.id, '--title', 'Pull me', '--body', 'Why']);
  assert.equal(p.code, 1);
  assert.match(p.err, /^error: repo folder .*orders-service is on 127\.0\.0\.1, which strand cannot open PRs on yet\. Open its PR there by hand, or, if it is your Gitea, run the installer or set STRAND_GITEA_URL and a token\.$/);
  const u = await cli(['frobnicate']);
  assert.equal(u.code, 1);
  assert.equal(u.err, 'error: unknown command frobnicate');
});

test('pr needs a title and one body source', { skip }, async () => {
  const usage = 'error: usage: strand pr <bead-id> --title <title> (--body <text> | --body-file <file>) [--base <branch>]';
  assert.equal((await cli(['pr', 't-x', '--body', 'b'], { gitea: true })).err, usage);
  assert.equal((await cli(['pr', 't-x', '--title', 't'], { gitea: true })).err, usage);
  assert.equal((await cli(['pr', 't-x', '--title', 't', '--body', 'b', '--body-file', 'f'], { gitea: true })).err, 'error: pass --body or --body-file, not both');
});

test('pr refuses a bead id in the title or body and opens nothing', { skip }, async () => {
  const b = await beads.create({ title: 'Named', type: 'task', labels: ['repo:orders-service', 'branch:ada/named'] });
  const t = await cli(['pr', b.id, '--title', `Fix ${b.id} now`, '--body', 'Why'], { gitea: true });
  assert.equal(t.code, 1);
  assert.equal(t.err, `error: The PR title names bead ${b.id}. Bead ids stay on this PC.`);
  const bd = await cli(['pr', b.id, '--title', 'Fix it', '--body', `See ${epic}`], { gitea: true });
  assert.equal(bd.err, `error: The PR body names bead ${epic}. Bead ids stay on this PC.`);
  assert.deepEqual(created, []);
});

test('pr needs the bead to have a branch label', { skip }, async () => {
  const b = await beads.create({ title: 'Branchless', type: 'task', labels: ['repo:orders-service'] });
  const r = await cli(['pr', b.id, '--title', 'Fix it', '--body', 'Why'], { gitea: true });
  assert.equal(r.code, 1);
  assert.equal(r.err, `error: bead ${b.id} has no branch: label. Make the branch with but branch new first.`);
});

test('pr pushes, opens the PR with the given title and body, and labels the bead', { skip }, async () => {
  const b = await beads.create({ title: 'Open me', type: 'task', labels: ['repo:orders-service', 'branch:ada/open-me'] });
  const bodyFile = join(ws, 'pr-body.md');
  writeFileSync(bodyFile, 'Adds the thing.\r\n');
  const out: string[] = [];
  const err: string[] = [];
  const pushed: string[] = [];
  const ctx = cliCtx({ gitea: true }, out, err);
  const code = await pr([b.id, '--title', 'Add the thing', '--body-file', bodyFile, '--base', 'main', '--json'], ctx, {
    push: async (_dir, branch) => void pushed.push(branch),
  });
  assert.equal(code, 0, err.join('\n'));
  assert.deepEqual(pushed, ['ada/open-me']);
  assert.deepEqual(created.at(-1), { head: 'ada/open-me', base: 'main', title: 'Add the thing', body: 'Adds the thing.' });
  assert.deepEqual(JSON.parse(out[0]!), { url: 'http://g/acme/orders-service/pulls/9', number: 9, branch: 'ada/open-me', base: 'main' });
  assert.ok((await beads.show(b.id)).labels.includes('pr:acme/orders-service#9'));
  created = [];
});

test('pr is idempotent when the branch already has an open PR, and adds a missing label', { skip }, async () => {
  const b = await beads.create({ title: 'Already open', type: 'task', labels: ['repo:orders-service', 'branch:ada/already'] });
  pulls = [{ number: 7, state: 'open', merged: false, html_url: 'http://g/acme/orders-service/pulls/7', head: { ref: 'ada/already', sha: 'abc' } }];
  try {
    const r = await cli(['pr', b.id, '--title', 'Already', '--body', 'Why'], { gitea: true });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'http://g/acme/orders-service/pulls/7');
    assert.deepEqual(created, []);
    assert.deepEqual((await beads.show(b.id)).labels.filter((l) => l.startsWith('pr:')), ['pr:acme/orders-service#7']);
    const again = await cli(['pr', b.id, '--title', 'Already', '--body', 'Why'], { gitea: true });
    assert.equal(again.code, 0, again.err);
    assert.deepEqual((await beads.show(b.id)).labels.filter((l) => l.startsWith('pr:')), ['pr:acme/orders-service#7']);
  } finally {
    pulls = [];
  }
});

/** A repo folder in the workspace with one commit, a local origin/main ref and the given origin URL. */
async function sideRepo(name: string, origin: string): Promise<string> {
  const dir = join(ws, name);
  mkdirSync(dir);
  const g = (...a: string[]) => run('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: dir });
  await g('init', '-q', '-b', 'main');
  await g('commit', '-q', '--allow-empty', '-m', 'base');
  await g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  await g('remote', 'add', 'origin', origin);
  return dir;
}

test('pr picks the branch that is still open when the bead has two branch labels', { skip }, async () => {
  const dir = await sideRepo('pick-repo', `${giteaUrl}/acme/pick-repo.git`);
  const g = (...a: string[]) => run('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: dir });
  await g('checkout', '-q', '-b', 'ada/a-open');
  await g('commit', '-q', '--allow-empty', '-m', 'work');
  await g('checkout', '-q', 'main');
  await g('branch', 'ada/b-stale');
  // Labels come back sorted by name, so the last one is the stale branch.
  const b = await beads.create({ title: 'Two branches', type: 'task', labels: ['repo:pick-repo', 'branch:ada/a-open', 'branch:ada/b-stale'] });
  const out: string[] = [];
  const err: string[] = [];
  const pushed: string[] = [];
  const code = await pr([b.id, '--title', 'Pick', '--body', 'Why', '--base', 'main'], cliCtx({ gitea: true }, out, err), {
    push: async (_dir, branch) => void pushed.push(branch),
  });
  assert.equal(code, 0, err.join('\n'));
  assert.deepEqual(pushed, ['ada/a-open']);
  assert.equal(created.at(-1)?.head, 'ada/a-open');
  created = [];
});

test('pr on a repo whose origin is github.com opens the PR through the GitHub forge and labels the bead', { skip }, async () => {
  await sideRepo('on-github', 'git@github.com:acme/app.git');
  const b = await beads.create({ title: 'On GitHub', type: 'task', labels: ['repo:on-github', 'branch:ada/t'] });
  const out: string[] = [];
  const err: string[] = [];
  const pushed: string[] = [];
  const asked: { owner: string; repo: string; p: unknown }[] = [];
  const ctx = cliCtx({ gitea: true }, out, err);
  ctx.github = {
    name: 'GitHub',
    findPullForBranch: async () => undefined,
    ciState: async () => 'none',
    createPull: async (owner, repo, p) => {
      asked.push({ owner, repo, p });
      return { number: 7, url: 'https://github.com/acme/app/pull/7', state: 'open', merged: false, headSha: 's', headRef: 'ada/t' };
    },
  };
  const code = await pr([b.id, '--title', 'Fix it', '--body', 'Why', '--base', 'main'], ctx, { push: async (_d, branch) => void pushed.push(branch) });
  assert.equal(code, 0, err.join('\n'));
  assert.equal(out[0], 'https://github.com/acme/app/pull/7');
  assert.deepEqual(pushed, ['ada/t']);
  assert.deepEqual(asked, [{ owner: 'acme', repo: 'app', p: { head: 'ada/t', base: 'main', title: 'Fix it', body: 'Why' } }]);
  assert.ok((await beads.show(b.id)).labels.includes('pr:acme/app#7'));
  assert.deepEqual(created, [], 'Gitea was not asked');
});

test('pr on a Gerrit repo with no Gitea configured says to open the PR by hand', { skip }, async () => {
  await sideRepo('gerrit-nogitea', 'ssh://review.example.org:29418/team/gerrit-nogitea.git');
  const b = await beads.create({ title: 'Gerrit', type: 'task', labels: ['repo:gerrit-nogitea', 'branch:ada/g'] });
  const r = await cli(['pr', b.id, '--title', 'Fix it', '--body', 'Why']);
  assert.equal(r.code, 1);
  assert.match(r.err, /is on review\.example\.org, which strand cannot open PRs on yet\. Open its PR there by hand/);
});

test('pr on the configured Gitea host with no token says Gitea is not configured', { skip }, async () => {
  const b = await beads.create({ title: 'No token', type: 'task', labels: ['repo:orders-service', 'branch:ada/no-token'] });
  const out: string[] = [];
  const err: string[] = [];
  const ctx = cliCtx({ gitea: true }, out, err);
  delete ctx.gitea;
  await assert.rejects(pr([b.id, '--title', 'T', '--body', 'B'], ctx, { push: async () => {} }), /^Error: Gitea is not configured \(run the installer or set STRAND_GITEA_URL and a token\)$/);
});

test('pr on a repo on an unsupported host says to open the PR by hand, and pushes nothing', { skip }, async () => {
  await sideRepo('firmware', 'ssh://review.example.org:29418/team/firmware.git');
  const b = await beads.create({ title: 'Elsewhere', type: 'task', labels: ['repo:firmware', 'branch:ada/elsewhere'] });
  const out: string[] = [];
  const err: string[] = [];
  const pushed: string[] = [];
  await assert.rejects(
    pr([b.id, '--title', 'Fix it', '--body', 'Why'], cliCtx({ gitea: true }, out, err), { push: async (_d, branch) => void pushed.push(branch) }),
    /^Error: repo folder .*firmware is on review\.example\.org, which strand cannot open PRs on yet\. Open its PR there by hand\.$/,
  );
  assert.deepEqual(pushed, []);
  assert.deepEqual(created, []);
});

test('none prints the no-bead line without loading the config', async () => {
  // Sandboxed: every config location is a folder that does not exist, and a bad env value would fail loadConfig.
  const home = join(tmpdir(), 'strand-no-such-home');
  const sandbox = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData'), XDG_CONFIG_HOME: join(home, 'cfg'), STRAND_WIP_MODE: 'bogus' };
  const r = await runWith(process.execPath, [STRAND, 'none'], { env: { ...baseEnv(), ...sandbox } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'No bead for this session.\n');
  assert.equal(r.stderr, '');
});

test('audit on a folder that is not a GitButler project prints nothing', { skip }, async () => {
  const r = await cli(['audit', repoDir]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '');
});

test('work writes the binding for the session it starts', { skip }, async () => {
  const b = await beads.create({ title: 'Bind me', type: 'task', labels: ['repo:orders-service'] });
  const r = await cli(['work', b.id, '--json']);
  assert.equal(r.code, 0, r.err);
  const sid = JSON.parse(r.out).sessionId as string;
  assert.deepEqual(readBinding(tracker, sid), { bead: b.id, lastStage: 'specify' });
});
