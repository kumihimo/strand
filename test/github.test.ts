import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolMissingError } from '../src/core/exec.ts';
import { combineCheckRuns, createGitHub, type GhRunner } from '../src/core/github.ts';

type Call = { args: string[]; input?: string };

/** A fake gh: records each call and answers with `answer(args)`. */
function fakeGh(answer: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) {
  const calls: Call[] = [];
  const gh: GhRunner = (args, opts) => {
    calls.push({ args, input: opts.input });
    return answer(args);
  };
  return { gh, calls };
}

const ok = (json: unknown) => Promise.resolve({ code: 0, stdout: JSON.stringify(json), stderr: '' });

const pull = (number: number, state: 'open' | 'closed', merged_at: string | null) => ({
  number,
  state,
  merged_at,
  html_url: `https://github.com/acme/app/pull/${number}`,
  head: { ref: 'ada/t', sha: `sha${number}` },
});

test('findPullForBranch picks the open PR, then the merged one, then a closed one', async () => {
  const closed = pull(3, 'closed', null);
  const merged = pull(2, 'closed', '2026-11-25T10:00:00Z');
  const open = pull(1, 'open', null);
  const find = async (list: unknown[]) => createGitHub({ gh: fakeGh(() => ok(list)).gh }).findPullForBranch('acme', 'app', 'ada/t');

  const a = await find([closed, merged, open]);
  assert.equal(a?.number, 1);
  assert.equal(a?.state, 'open');
  assert.equal(a?.merged, false);
  assert.equal(a?.headSha, 'sha1');
  assert.equal(a?.headRef, 'ada/t');
  assert.equal(a?.url, 'https://github.com/acme/app/pull/1');

  const b = await find([closed, merged]);
  assert.equal(b?.number, 2);
  assert.equal(b?.merged, true);

  const c = await find([closed]);
  assert.equal(c?.number, 3);
  assert.equal(c?.state, 'closed');
  assert.equal(c?.merged, false);

  assert.equal(await find([]), undefined);
});

test('findPullForBranch encodes the head filter', async () => {
  const f = fakeGh(() => ok([]));
  await createGitHub({ gh: f.gh }).findPullForBranch('acme', 'app', 'ada/a b');
  assert.deepEqual(f.calls[0]!.args, [
    'api',
    `repos/acme/app/pulls?state=all&head=${encodeURIComponent('acme:ada/a b')}&per_page=50`,
  ]);
  assert.ok(f.calls[0]!.args[1]!.includes('head=acme%3Aada%2Fa%20b'));
});

test('createPull sends the body as JSON on stdin', async () => {
  const f = fakeGh(() => ok({ ...pull(7, 'open', null), merged: false }));
  const p = await createGitHub({ gh: f.gh }).createPull('acme', 'app', { head: 'ada/t', base: 'main', title: 'T', body: '-x @file' });
  assert.deepEqual(f.calls[0]!.args, ['api', '-X', 'POST', 'repos/acme/app/pulls', '--input', '-']);
  assert.deepEqual(JSON.parse(f.calls[0]!.input!), { head: 'ada/t', base: 'main', title: 'T', body: '-x @file' });
  assert.equal(p.url, 'https://github.com/acme/app/pull/7');
  assert.equal(p.number, 7);
});

test('ciState combines the commit check runs', async () => {
  const f = fakeGh(() => ok({ total_count: 1, check_runs: [{ status: 'in_progress', conclusion: null }] }));
  assert.equal(await createGitHub({ gh: f.gh }).ciState('acme', 'app', 'abc'), 'running');
  assert.deepEqual(f.calls[0]!.args, ['api', 'repos/acme/app/commits/abc/check-runs?per_page=100']);
});

test('combineCheckRuns', () => {
  assert.equal(combineCheckRuns([]), 'none');
  const done = [
    { status: 'completed', conclusion: 'success' },
    { status: 'completed', conclusion: 'skipped' },
  ];
  assert.equal(combineCheckRuns(done), 'success');
  assert.equal(combineCheckRuns([...done, { status: 'in_progress', conclusion: null }]), 'running');
  assert.equal(combineCheckRuns([...done, { status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'failure' }]), 'failure');
  assert.equal(combineCheckRuns([{ status: 'queued', conclusion: null }]), 'pending');
  assert.equal(combineCheckRuns([{ status: 'completed', conclusion: 'neutral' }]), 'success');
  assert.equal(combineCheckRuns([{ status: 'completed', conclusion: 'timed_out' }]), 'failure');
});

test('ghMissing: a gh that cannot start gives the install message, and later calls fail at once', async () => {
  const f = fakeGh(() => Promise.reject(new ToolMissingError('gh', 'Install gh and make sure it is on PATH')));
  const github = createGitHub({ gh: f.gh });
  await assert.rejects(github.findPullForBranch('acme', 'app', 'b'), /GitHub CLI \(gh\) not found: install it and run gh auth login/);
  await assert.rejects(github.ciState('acme', 'app', 's'), /GitHub CLI \(gh\) not found/);
  assert.equal(f.calls.length, 1);
});

test('a gh that is not signed in says to run gh auth login', async () => {
  const f = fakeGh(() => Promise.resolve({ code: 1, stdout: '', stderr: 'HTTP 401: Bad credentials (https://api.github.com/...)\n' }));
  await assert.rejects(createGitHub({ gh: f.gh }).findPullForBranch('acme', 'app', 'b'), /gh is not signed in: run gh auth login/);
});

test('a failure that mentions auth in a branch name is not taken for a sign-in problem', async () => {
  const f = fakeGh(() => Promise.resolve({ code: 1, stdout: '', stderr: 'HTTP 422: Validation Failed: A pull request already exists for acme:ada/oauth-fix.\n' }));
  await assert.rejects(createGitHub({ gh: f.gh }).findPullForBranch('acme', 'app', 'ada/oauth-fix'), /failed: HTTP 422: Validation Failed/);
});

test('any other gh failure names the call and the first stderr line', async () => {
  const f = fakeGh(() => Promise.resolve({ code: 1, stdout: '', stderr: 'HTTP 404: Not Found\nmore\n' }));
  await assert.rejects(createGitHub({ gh: f.gh }).ciState('acme', 'app', 's'), /^Error: gh api repos\/acme\/app\/commits\/s\/check-runs\?per_page=100 failed: HTTP 404: Not Found$/);
});

test('a gh that does not answer in time fails, and later calls fail at once', async () => {
  const f = fakeGh(() => Promise.reject(new Error('gh did not answer within 0.05 s')));
  const github = createGitHub({ gh: f.gh, timeoutMs: 50 });
  await assert.rejects(github.findPullForBranch('acme', 'app', 'b'), /did not answer within/);
  await assert.rejects(github.findPullForBranch('acme', 'app', 'b'), /did not answer within/);
  assert.equal(f.calls.length, 1);
});

test('the timeout reaches gh', async () => {
  let seen: number | undefined;
  const github = createGitHub({ gh: (_a, o) => ((seen = o.timeoutMs), ok([])), timeoutMs: 1234 });
  await github.findPullForBranch('acme', 'app', 'b');
  assert.equal(seen, 1234);
  assert.equal(github.name, 'GitHub');
});
