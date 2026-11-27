import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { branchOpen, defaultRemoteBranch, mergedByChangeId, mergedPrNumbers } from '../src/core/gitfacts.ts';

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'gitfacts-'));
});
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

let n = 0;
function commit(dir: string, msg: string): void {
  writeFileSync(join(dir, `f${++n}.txt`), msg);
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', msg);
}

function sync(dir: string, branch = 'main'): void {
  git(dir, 'push', '-q', 'origin', branch);
  git(dir, 'fetch', '-q', 'origin');
}

/** A work repo on `branch` (main) with a bare origin, origin/HEAD set, and one pushed base commit. */
function makeRepo(name: string, withOrigin = true, branch = 'main'): string {
  const dir = join(root, name);
  git(root, 'init', '-q', '-b', branch, dir);
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  commit(dir, 'base');
  if (withOrigin) {
    const bare = join(root, `${name}.git`);
    git(root, 'init', '-q', '--bare', '-b', branch, bare);
    git(dir, 'remote', 'add', 'origin', bare);
    sync(dir, branch);
    git(dir, 'remote', 'set-head', 'origin', '-a');
  }
  return dir;
}

test('defaultRemoteBranch follows origin/HEAD', async () => {
  assert.equal(await defaultRemoteBranch(makeRepo('head')), 'origin/main');
});

test('mergedPrNumbers finds a squash subject', async () => {
  const dir = makeRepo('prs');
  commit(dir, 'Add pause (#12)');
  sync(dir);
  assert.deepEqual(await mergedPrNumbers(dir, [12, 13]), [12]);
});

test('branchOpen is true until the branch is merged by fast-forward', async () => {
  const dir = makeRepo('open');
  git(dir, 'checkout', '-q', '-b', 'topic');
  commit(dir, 'work');
  assert.equal(await branchOpen(dir, 'topic'), true);
  assert.equal(await branchOpen(dir, 'nope'), false);
  git(dir, 'push', '-q', 'origin', 'topic:main');
  git(dir, 'fetch', '-q', 'origin');
  assert.equal(await branchOpen(dir, 'topic'), false);
});

test('mergedByChangeId is true after a rebased cherry-pick that keeps the Change-Id', async () => {
  const dir = makeRepo('cid');
  git(dir, 'checkout', '-q', '-b', 'topic');
  commit(dir, 'one\n\nChange-Id: I111');
  commit(dir, 'two\n\nChange-Id: I222');
  assert.equal(await mergedByChangeId(dir, 'topic'), false);
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'other work');
  git(dir, 'cherry-pick', 'topic~1', 'topic');
  sync(dir);
  assert.equal(await mergedByChangeId(dir, 'topic'), true);
});

test('mergedByChangeId is false when one commit has no Change-Id', async () => {
  const dir = makeRepo('cid-missing');
  git(dir, 'checkout', '-q', '-b', 'topic');
  commit(dir, 'one\n\nChange-Id: I333');
  commit(dir, 'two without id');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'cherry-pick', 'topic~1', 'topic');
  sync(dir);
  assert.equal(await mergedByChangeId(dir, 'topic'), false);
});

test('mergedByChangeId reads a Change-Id trailer that ends in CRLF', async () => {
  const dir = makeRepo('cid-crlf');
  git(dir, 'checkout', '-q', '-b', 'topic');
  writeFileSync(join(dir, 'crlf.txt'), 'x');
  writeFileSync(join(root, 'crlf-msg.txt'), 'one\r\n\r\nChange-Id: I444\r\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '--cleanup=verbatim', '-F', join(root, 'crlf-msg.txt'));
  assert.match(git(dir, 'log', '-1', '--format=%B'), /Change-Id: I444\r\n/, 'the CR is kept in the message');
  git(dir, 'checkout', '-q', 'main');
  // Main moves on first, so the pick gets a new hash even within the same second.
  commit(dir, 'other work');
  git(dir, 'cherry-pick', 'topic');
  sync(dir);
  assert.equal(await mergedByChangeId(dir, 'topic'), true);
});

test('an origin with no origin/HEAD falls back to origin/main', async () => {
  const dir = makeRepo('no-head');
  git(dir, 'remote', 'set-head', 'origin', '-d');
  assert.equal(await defaultRemoteBranch(dir), 'origin/main');
  commit(dir, 'Squash (#21)');
  sync(dir);
  assert.deepEqual(await mergedPrNumbers(dir, [21]), [21]);
});

test('origin/HEAD on a branch that is not main (origin/master) is followed', async () => {
  const dir = makeRepo('master', true, 'master');
  assert.equal(await defaultRemoteBranch(dir), 'origin/master');
  commit(dir, 'Squash (#31)');
  sync(dir, 'master');
  assert.deepEqual(await mergedPrNumbers(dir, [31]), [31]);
  git(dir, 'checkout', '-q', '-b', 'topic');
  commit(dir, 'work');
  assert.equal(await branchOpen(dir, 'topic'), true);
  git(dir, 'push', '-q', 'origin', 'topic:master');
  git(dir, 'fetch', '-q', 'origin');
  assert.equal(await branchOpen(dir, 'topic'), false);
});

test('a repo with no origin answers false, [] and origin/main without throwing', async () => {
  const dir = makeRepo('local', false);
  git(dir, 'branch', 'topic');
  assert.equal(await defaultRemoteBranch(dir), 'origin/main');
  assert.equal(await branchOpen(dir, 'topic'), false);
  assert.deepEqual(await mergedPrNumbers(dir, [1]), []);
  assert.equal(await mergedByChangeId(dir, 'topic'), false);
});

test('a missing directory answers the "not" values', async () => {
  const dir = join(root, 'absent');
  assert.equal(await branchOpen(dir, 'x'), false);
  assert.deepEqual(await mergedPrNumbers(dir, [1]), []);
  assert.equal(await mergedByChangeId(dir, 'x'), false);
});
