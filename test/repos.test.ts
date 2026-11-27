import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepoCache, listRepos } from '../src/core/repos.ts';
import { repoSet } from '../src/core/create-bead.ts';
import { sameRepoName } from '../src/core/folders.ts';

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), 'strand-repos-'));
  const repo = (name: string, gitFile = false) => {
    mkdirSync(join(ws, name));
    if (gitFile) writeFileSync(join(ws, name, '.git'), 'gitdir: elsewhere');
    else mkdirSync(join(ws, name, '.git'));
  };
  return { ws, repo, done: () => rmSync(ws, { recursive: true, force: true }) };
}

test('listRepos: direct child folders with a .git entry, sorted ignoring case', () => {
  const w = workspace();
  try {
    w.repo('zeta');
    w.repo('Alpha');
    w.repo('beta', true); // a worktree or submodule has a .git file
    mkdirSync(join(w.ws, 'plain'));
    mkdirSync(join(w.ws, 'deep', 'inner', '.git'), { recursive: true });
    writeFileSync(join(w.ws, 'file.txt'), 'x');
    assert.deepEqual(listRepos(w.ws), ['Alpha', 'beta', 'zeta']);
  } finally {
    w.done();
  }
});

test('listRepos: a name that fails isSafeRepoName is left out; a missing root is empty', () => {
  const w = workspace();
  try {
    w.repo('a..b');
    w.repo('ok repo');
    assert.deepEqual(listRepos(w.ws), ['ok repo']);
    assert.deepEqual(listRepos(join(w.ws, 'missing')), []);
  } finally {
    w.done();
  }
});

test('listRepos leaves out excluded folders such as the tracker, by resolved path and ignoring case on win32', () => {
  const w = workspace();
  try {
    w.repo('app');
    w.repo('tracker');
    assert.deepEqual(listRepos(w.ws, [join(w.ws, 'tracker')]), ['app']);
    assert.deepEqual(listRepos(w.ws, [join(w.ws, 'app', '..', 'tracker') + '/']), ['app']);
    if (process.platform === 'win32') assert.deepEqual(listRepos(w.ws, [join(w.ws, 'TRACKER')]), ['app']);
    assert.deepEqual(listRepos(w.ws), ['app', 'tracker']);
  } finally {
    w.done();
  }
});

test('sameRepoName and repoSet: names compare ignoring case on win32 only', () => {
  assert.equal(sameRepoName('Docs', 'docs', 'win32'), true);
  assert.equal(sameRepoName('Docs', 'docs', 'linux'), false);
  assert.deepEqual(repoSet('App', ['app', 'Docs', 'docs'], undefined, { platform: 'win32' }), { repo: 'App', context: ['Docs'] });
  assert.deepEqual(repoSet('App', ['app', 'Docs', 'docs'], undefined, { platform: 'linux' }), { repo: 'App', context: ['app', 'Docs', 'docs'] });
});

test('repoSet: the repo list and kept names compare ignoring case on win32 only', () => {
  assert.deepEqual(repoSet('APP', ['Docs'], ['app', 'docs'], { platform: 'win32' }), { repo: 'APP', context: ['Docs'] });
  assert.throws(() => repoSet('APP', [], ['app'], { platform: 'linux' }), /^Error: unknown repo APP$/);
  assert.deepEqual(repoSet('GONE', [], ['app'], { kept: ['gone'], platform: 'win32' }), { repo: 'GONE', context: [] });
});

test('repoSet: an empty name is refused by name; kept names skip the repo list check', () => {
  assert.throws(() => repoSet('app', ['']), /^Error: invalid repo name: empty$/);
  assert.throws(() => repoSet('gone', ['docs'], ['docs']), /^Error: unknown repo gone$/);
  assert.deepEqual(repoSet('gone', ['docs'], ['docs'], { kept: ['gone'] }), { repo: 'gone', context: ['docs'] });
});

test('createRepoCache reads once, and again only on refresh', () => {
  const w = workspace();
  try {
    w.repo('one');
    let t = 0;
    const cache = createRepoCache(w.ws, () => new Date(Date.UTC(2026, 10, 24, 10, 0, t++)));
    assert.deepEqual(cache.list(), { repos: ['one'], at: '2026-11-24T10:00:00.000Z' });
    w.repo('two');
    assert.deepEqual(cache.list().repos, ['one']);
    assert.deepEqual(cache.refresh(), { repos: ['one', 'two'], at: '2026-11-24T10:00:01.000Z' });
    assert.deepEqual(cache.list().repos, ['one', 'two']);
  } finally {
    w.done();
  }
});
