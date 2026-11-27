import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/core/exec.ts';
import { butStatus, butCommit, butPush } from '../src/core/but.ts';

process.env.BUT_PAGER = 'cat';
process.env.GIT_PAGER = 'cat';

const hasBut = await run('but', ['--version']).then((r) => r.code === 0, () => false);
const skip = hasBut ? false : 'but not on PATH';

let root: string;
let repo: string;
let bare: string;

async function git(cwd: string, ...args: string[]) {
  const r = await run('git', args, { cwd });
  assert.equal(r.code, 0, r.stderr);
  return r.stdout;
}

before(async () => {
  if (!hasBut) return;
  root = await mkdtemp(join(tmpdir(), 'strand-but-'));
  repo = join(root, 'repo');
  bare = join(root, 'origin.git');
  await git(root, 'init', '-q', '--bare', bare);
  await git(root, 'init', '-q', '-b', 'main', repo);
  await git(repo, 'config', 'user.name', 'Test');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await writeFile(join(repo, 'README.md'), 'hi\n');
  await git(repo, 'add', 'README.md');
  await git(repo, 'commit', '-q', '-m', 'init');
  await git(repo, 'remote', 'add', 'origin', bare);
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test('butCommit puts each bead files on its own branch', { skip }, async () => {
  await writeFile(join(repo, 'a.txt'), 'a\n');
  await writeFile(join(repo, 'b.txt'), 'b\n');
  const before = await butStatus(repo);
  assert.deepEqual(before.uncommitted.sort(), ['a.txt', 'b.txt']);
  await butCommit(repo, { branch: 't-1-a', message: 't-1: add a', files: ['a.txt'] });
  await butCommit(repo, { branch: 't-2-b', message: 't-2: add b', files: ['b.txt'] });
  const st = await butStatus(repo);
  const names = st.branches.map((b) => b.name).sort();
  assert.deepEqual(names, ['t-1-a', 't-2-b']);
  for (const b of st.branches) {
    assert.equal(b.commits.length, 1);
    assert.ok(b.commits[0].message.startsWith(b.name.slice(0, 3)));
  }
  assert.deepEqual(st.uncommitted, []);
});

test('butCommit handles a message starting with a dash', { skip }, async () => {
  await writeFile(join(repo, 'c.txt'), 'c\n');
  await butCommit(repo, { branch: 't-3-c', message: '-weird: message', files: ['c.txt'] });
  const st = await butStatus(repo);
  const b = st.branches.find((x) => x.name === 't-3-c');
  assert.ok(b);
  assert.ok(b.commits[0].message.startsWith('-weird: message'));
});

test('butCommit rejects an empty files list', { skip }, async () => {
  await assert.rejects(butCommit(repo, { branch: 'x', message: 'm', files: [] }), /files/);
});

test('butPush errors clearly without a push remote, then pushes once configured', { skip }, async () => {
  await assert.rejects(butPush(repo, 't-1-a'), /push remote/i);
  const c = await run('but', ['config', 'push-remote', 'origin'], { cwd: repo });
  assert.equal(c.code, 0, c.stderr);
  await butPush(repo, 't-1-a');
  const refs = await git(bare, 'branch', '--list');
  assert.match(refs, /t-1-a/);
});
