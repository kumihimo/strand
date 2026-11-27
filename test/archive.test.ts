import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { run } from '../src/core/exec.ts';
import { recordStart, recordEnd, pendingArchives } from '../src/core/sessions.ts';
import { archiveTranscript, archivePending, findTranscript } from '../src/core/archive.ts';

const GIT = { vcs: 'git' } as const;
let dir = '';
let src = '';
const git = (...a: string[]) => run('git', a, { cwd: dir });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'strand-archive-'));
  src = mkdtempSync(join(tmpdir(), 'strand-transcripts-'));
  await git('init', '-q');
  await git('config', 'user.name', 'T');
  await git('config', 'user.email', 't@example.com');
  await git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'x');
  writeFileSync(join(dir, '.gitignore'), '.strand/\n');
  await git('add', 'README.md', '.gitignore');
  await git('commit', '-q', '-m', 'init');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(src, { recursive: true, force: true });
});

const SID = '0123abcd-0123-4abc-8def-0123456789ab';

test('findTranscript looks one level deep under CLAUDE_CONFIG_DIR/projects, else <home>/.claude/projects', () => {
  const cfg = join(src, 'claude-cfg');
  mkdirSync(join(cfg, 'projects', 'C--dev-app'), { recursive: true });
  mkdirSync(join(cfg, 'projects', 'C--dev-other'), { recursive: true });
  writeFileSync(join(cfg, 'projects', 'C--dev-app', `${SID}.jsonl`), '{}\n');
  assert.equal(findTranscript({ CLAUDE_CONFIG_DIR: cfg }, SID), join(cfg, 'projects', 'C--dev-app', `${SID}.jsonl`));
  assert.equal(findTranscript({ CLAUDE_CONFIG_DIR: cfg }, '11111111-2222-3333-4444-555555555555'), undefined);

  const home = join(src, 'home');
  mkdirSync(join(home, '.claude', 'projects', 'x'), { recursive: true });
  writeFileSync(join(home, '.claude', 'projects', 'x', `${SID}.jsonl`), '{}\n');
  assert.equal(findTranscript({ HOME: home, USERPROFILE: home }, SID), join(home, '.claude', 'projects', 'x', `${SID}.jsonl`));
});

test('findTranscript: no projects folder, a relative CLAUDE_CONFIG_DIR or an unsafe id finds nothing', () => {
  assert.equal(findTranscript({ CLAUDE_CONFIG_DIR: join(src, 'none') }, SID), undefined);
  assert.equal(findTranscript({ CLAUDE_CONFIG_DIR: 'rel', HOME: src, USERPROFILE: src }, SID), undefined);
  assert.equal(findTranscript({ CLAUDE_CONFIG_DIR: src }, '../x'), undefined);
});

test('archives gzipped transcript, commits only it, marks archived', async () => {
  const t = join(src, 't.jsonl');
  const bytes = Buffer.from('{"a":1}\n{"b":2}\n');
  writeFileSync(t, bytes);
  recordStart(dir, { sessionId: 's1', beadId: 'bd-a3f8.2' });
  const e = recordEnd(dir, { sessionId: 's1', transcriptPath: t })!;
  writeFileSync(join(dir, 'other.txt'), 'staged');
  await git('add', 'other.txt');

  const out = await archiveTranscript(dir, e, GIT);
  assert.equal(out, join(dir, 'artefacts', 'bd-a3f8.2', 'sessions', 's1.jsonl.gz'));
  assert.deepEqual(gunzipSync(readFileSync(out)), bytes);

  const log = await git('log', '-1', '--format=%s');
  assert.equal(log.stdout.trim(), 'bd-a3f8.2: archive session s1');
  const files = await git('show', '--name-only', '--format=', 'HEAD');
  assert.equal(files.stdout.trim(), 'artefacts/bd-a3f8.2/sessions/s1.jsonl.gz');
  const st = await git('status', '--porcelain');
  assert.match(st.stdout, /^A  other\.txt/m);
  assert.deepEqual(pendingArchives(dir), []);
});

test('archiveTranscript reads, gzips and writes off the event loop: nothing is written before it yields', async () => {
  const t = join(src, 't.jsonl');
  writeFileSync(t, '{"a":1}\n'.repeat(1000));
  recordStart(dir, { sessionId: 's9', beadId: 'bd-1' });
  const e = recordEnd(dir, { sessionId: 's9', transcriptPath: t })!;
  const target = join(dir, 'artefacts', 'bd-1', 'sessions', 's9.jsonl.gz');
  const p = archiveTranscript(dir, e, { vcs: 'none' });
  // Synchronous reads and writes would have made the file before the call returned.
  assert.equal(existsSync(target), false);
  assert.equal(await p, target);
  assert.equal(gunzipSync(readFileSync(target)).toString(), '{"a":1}\n'.repeat(1000));
});

test('missing transcript leaves entry pending and returns empty string', async () => {
  recordStart(dir, { sessionId: 's2', beadId: 'bd-1' });
  const e = recordEnd(dir, { sessionId: 's2', transcriptPath: join(src, 'nope.jsonl') })!;
  assert.equal(await archiveTranscript(dir, e, GIT), '');
  assert.equal(pendingArchives(dir).length, 1);
  const e2 = recordEnd(dir, { sessionId: 's2' })!;
  assert.equal(await archiveTranscript(dir, e2, GIT), '');
  assert.equal(existsSync(join(dir, 'artefacts')), false);
});

test('archivePending returns only archived paths and continues past failures', async () => {
  const t = join(src, 't.jsonl');
  writeFileSync(t, 'hi\n');
  recordStart(dir, { sessionId: 'bad', beadId: 'bd-1' });
  recordEnd(dir, { sessionId: 'bad', transcriptPath: join(src, 'missing') });
  recordStart(dir, { sessionId: 'good', beadId: 'bd-1' });
  recordEnd(dir, { sessionId: 'good', transcriptPath: t });
  const out = await archivePending(dir, GIT);
  assert.deepEqual(out, [join(dir, 'artefacts', 'bd-1', 'sessions', 'good.jsonl.gz')]);
  assert.equal(pendingArchives(dir).length, 1);
});

test('archiving twice does not create a second commit and returns the path', async () => {
  const t = join(src, 't.jsonl');
  writeFileSync(t, 'hi\n');
  recordStart(dir, { sessionId: 's1', beadId: 'bd-1' });
  const e = recordEnd(dir, { sessionId: 's1', transcriptPath: t })!;
  const first = await archiveTranscript(dir, e, GIT);
  const count = async () => (await git('rev-list', '--count', 'HEAD')).stdout.trim();
  const n = await count();
  assert.equal(await archiveTranscript(dir, e, GIT), first);
  assert.equal(await count(), n);
});

test('retry after commit succeeded but entry not marked still archives', async () => {
  const t = join(src, 't.jsonl');
  writeFileSync(t, 'hi\n');
  recordStart(dir, { sessionId: 's1', beadId: 'bd-1' });
  const e = recordEnd(dir, { sessionId: 's1', transcriptPath: t })!;
  await archiveTranscript(dir, e, GIT);
  // simulate lost archived flag
  recordStart(dir, { sessionId: 's1', beadId: 'bd-1' });
  recordEnd(dir, { sessionId: 's1', transcriptPath: t });
  assert.equal(pendingArchives(dir).length, 1);
  assert.equal((await archivePending(dir, GIT)).length, 1);
  assert.equal(pendingArchives(dir).length, 0);
});

test('unsafe bead id never writes outside artefacts', async () => {
  const t = join(src, 't.jsonl');
  writeFileSync(t, 'hi\n');
  await assert.rejects(
    archiveTranscript(dir, { sessionId: 's1', beadId: '../x', startedAt: 't', endedAt: 't', transcriptPath: t }, GIT),
  );
  assert.equal(existsSync(join(dir, 'x')), false);
});

test('archivePending logs failures to stderr and keeps going', async () => {
  const t = join(src, 't.jsonl');
  writeFileSync(t, 'hi\n');
  recordStart(dir, { sessionId: 's1', beadId: 'bd-1' });
  recordEnd(dir, { sessionId: 's1', transcriptPath: t });
  rmSync(join(dir, '.git'), { recursive: true, force: true });
  const msgs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void msgs.push(a.join(' '));
  try {
    assert.deepEqual(await archivePending(dir, GIT), []);
  } finally {
    console.error = orig;
  }
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /^strand: archive s1 failed: /);
});

test("vcs 'none' writes the gzip and marks it archived without any git call", async () => {
  const plain = mkdtempSync(join(tmpdir(), 'strand-archive-plain-'));
  try {
    const t = join(src, 't.jsonl');
    writeFileSync(t, 'hi\n');
    recordStart(plain, { sessionId: 's1', beadId: 'bd-1' });
    const e = recordEnd(plain, { sessionId: 's1', transcriptPath: t })!;
    const comments: [string, string][] = [];
    const out = await archiveTranscript(plain, e, { vcs: 'none', comment: async (id, text) => void comments.push([id, text]) });
    assert.equal(out, join(plain, 'artefacts', 'bd-1', 'sessions', 's1.jsonl.gz'));
    assert.deepEqual(gunzipSync(readFileSync(out)).toString(), 'hi\n');
    assert.equal(existsSync(join(plain, '.git')), false);
    assert.deepEqual(pendingArchives(plain), []);
    assert.deepEqual(comments, [['bd-1', 'session s1 archived']]);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test('git mode also comments on the bead; a failing comment is logged, not fatal', async () => {
  const t = join(src, 't.jsonl');
  writeFileSync(t, 'hi\n');
  recordStart(dir, { sessionId: 's1', beadId: 'bd-1' });
  recordEnd(dir, { sessionId: 's1', transcriptPath: t });
  const msgs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void msgs.push(a.join(' '));
  try {
    const out = await archivePending(dir, { vcs: 'git', comment: async () => { throw new Error('bd down'); } });
    assert.equal(out.length, 1);
  } finally {
    console.error = orig;
  }
  assert.deepEqual(pendingArchives(dir), []);
  assert.deepEqual(msgs, ['strand: comment on bd-1 failed: bd down']);
  assert.equal((await git('log', '-1', '--format=%s')).stdout.trim(), 'bd-1: archive session s1');
});
