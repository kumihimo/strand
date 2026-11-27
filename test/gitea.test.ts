import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGitea, parseRemote } from '../src/core/gitea.ts';

type Seen = { method?: string; url?: string; auth?: string; body: string };
let server: Server | undefined;

async function stub(handler: (req: Seen) => { status?: number; json: unknown; delayMs?: number }, timeoutMs?: number) {
  const seen: Seen[] = [];
  server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const s = { method: req.method, url: req.url, auth: req.headers.authorization, body };
      seen.push(s);
      const r = handler(s);
      const send = () => {
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json));
      };
      if (r.delayMs) setTimeout(send, r.delayMs).unref();
      else send();
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, gitea: createGitea({ baseUrl: baseUrl + '/', token: 'T', timeoutMs }) };
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server!.close(r));
  }
  server = undefined;
});

const pr = (n: number, ref: string, extra = {}) => ({
  number: n, state: 'open', merged: false, html_url: `http://x/pulls/${n}`, head: { ref, sha: `sha${n}` }, ...extra,
});

test('findPullForBranch matches head.ref and sends auth', async () => {
  const { seen, gitea } = await stub((r) => ({
    json: r.url!.includes('state=open') ? [pr(1, 'a')] : [pr(1, 'a'), pr(2, 'b', { state: 'closed', merged: true })],
  }));
  const p = await gitea.findPullForBranch('o', 'r', 'b');
  assert.deepEqual(p, { number: 2, state: 'closed', merged: true, headSha: 'sha2', headRef: 'b', url: 'http://x/pulls/2' });
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].url, '/api/v1/repos/o/r/pulls?state=open&limit=50&page=1');
  assert.equal(seen[1].url, '/api/v1/repos/o/r/pulls?state=all&limit=50&page=1');
  assert.equal(seen[0].auth, 'token T');
});

test('findPullForBranch returns an open PR without paging closed history', async () => {
  const { seen, gitea } = await stub((r) => ({
    json: r.url!.includes('state=open') ? [pr(8, 'b')] : [pr(3, 'b', { state: 'closed' }), pr(8, 'b')],
  }));
  assert.equal((await gitea.findPullForBranch('o', 'r', 'b'))?.number, 8);
  assert.equal(seen.length, 1);
});

test('findPullForBranch prefers a merged PR over a closed one, whatever the order', async () => {
  const { gitea } = await stub((r) => ({
    json: r.url!.includes('state=open') ? [] : [pr(5, 'b', { state: 'closed' }), pr(4, 'b', { state: 'closed', merged: true })],
  }));
  assert.equal((await gitea.findPullForBranch('o', 'r', 'b'))?.number, 4);
});

test('findPullForBranch paginates and returns undefined when absent', async () => {
  const page1 = Array.from({ length: 50 }, (_, i) => pr(i + 1, `x${i}`, { state: 'closed' }));
  const { seen, gitea } = await stub((r) => ({
    json: r.url!.includes('state=open') ? [] : r.url!.includes('page=1') ? page1 : [pr(99, 'want', { state: 'closed' })],
  }));
  assert.equal((await gitea.findPullForBranch('o', 'r', 'want'))?.number, 99);
  assert.equal(seen.length, 3);
  assert.match(seen[2].url!, /state=all.*page=2/);
  assert.equal(await gitea.findPullForBranch('o', 'r', 'nope'), undefined);
});

test('a Gitea that does not answer times out', async () => {
  const { gitea } = await stub(() => ({ json: [], delayMs: 5000 }), 100);
  const t0 = Date.now();
  await assert.rejects(gitea.findPullForBranch('o', 'r', 'b'), /timed out|timeout|abort/i);
  assert.ok(Date.now() - t0 < 2000);
  // Once unreachable, the same client fails fast instead of waiting again for every bead.
  const t1 = Date.now();
  await assert.rejects(gitea.ciState('o', 'r', 'S'), /timed out/);
  assert.ok(Date.now() - t1 < 50);
});

const runs = (...r: object[]) => ({ json: { workflow_runs: r, total_count: r.length } });

test('ciState combines the latest run of each workflow', async () => {
  const cases: [object[], string][] = [
    [[], 'none'],
    [[{ id: 1, status: 'completed', conclusion: 'success' }], 'success'],
    [[{ id: 1, status: 'completed', conclusion: 'failure' }], 'failure'],
    [[{ id: 1, status: 'completed', conclusion: 'cancelled' }], 'failure'],
    [[{ id: 1, status: 'in_progress', conclusion: '' }], 'running'],
    [[{ id: 1, status: 'queued' }], 'pending'],
    [[{ id: 1, status: 'waiting' }], 'pending'],
    [[{ id: 5, status: 'completed', conclusion: 'success' }, { id: 9, status: 'completed', conclusion: 'failure' }, { id: 3, status: 'queued' }], 'failure'],
    // Two workflows: lint failed earlier, test passed later -> still failure.
    [[{ id: 1, path: 'lint.yml@refs/heads/b', status: 'completed', conclusion: 'failure' },
      { id: 2, path: 'test.yml@refs/heads/b', status: 'completed', conclusion: 'success' }], 'failure'],
    // Same workflow re-run: the newer success replaces the older failure.
    [[{ id: 1, path: 'test.yml@refs/heads/b', status: 'completed', conclusion: 'failure' },
      { id: 2, path: 'test.yml@refs/pull/3/head', status: 'completed', conclusion: 'success' }], 'success'],
    [[{ id: 1, path: 'lint.yml', status: 'completed', conclusion: 'success' }, { id: 2, path: 'test.yml', status: 'in_progress' }], 'running'],
    [[{ id: 1, path: 'lint.yml', status: 'queued' }, { id: 2, path: 'test.yml', status: 'in_progress' }], 'running'],
    [[{ id: 1, path: 'lint.yml', status: 'queued' }, { id: 2, path: 'test.yml', status: 'completed', conclusion: 'success' }], 'pending'],
    // workflow_id wins over path; name is the last fallback.
    [[{ id: 1, workflow_id: 7, path: 'a.yml', status: 'completed', conclusion: 'failure' },
      { id: 2, workflow_id: 7, path: 'b.yml', status: 'completed', conclusion: 'success' }], 'success'],
    [[{ id: 1, name: 'ci', status: 'completed', conclusion: 'failure' }, { id: 2, name: 'ci', status: 'completed', conclusion: 'success' }], 'success'],
  ];
  for (const [rs, want] of cases) {
    const { seen, gitea } = await stub(() => runs(...rs));
    assert.equal(await gitea.ciState('o', 'r', 'S'), want, JSON.stringify(rs));
    assert.equal(seen[0].url, '/api/v1/repos/o/r/actions/runs?head_sha=S');
    assert.equal(seen[0].auth, 'token T');
    await new Promise((r) => server!.close(r));
    server = undefined;
  }
});

test('createPull POSTs JSON', async () => {
  const { seen, gitea } = await stub(() => ({ status: 201, json: pr(7, 'h') }));
  const p = await gitea.createPull('o', 'r', { head: 'h', base: 'main', title: 'T', body: 'B' });
  assert.equal(p.number, 7);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, '/api/v1/repos/o/r/pulls');
  assert.equal(seen[0].auth, 'token T');
  assert.deepEqual(JSON.parse(seen[0].body), { head: 'h', base: 'main', title: 'T', body: 'B' });
});

test('non-2xx throws with status, method, path, no token', async () => {
  const { gitea } = await stub(() => ({ status: 500, json: {} }));
  await assert.rejects(gitea.ciState('o', 'r', 'S'), (e: Error) => {
    assert.match(e.message, /500/);
    assert.match(e.message, /GET/);
    assert.match(e.message, /actions\/runs/);
    assert.doesNotMatch(e.message, /token T/);
    return true;
  });
});

test('parseRemote forms', () => {
  const want = { baseUrl: 'https://gitea.acme.local', owner: 'team', repo: 'orders-service' };
  assert.deepEqual(parseRemote('https://gitea.acme.local/team/orders-service.git'), want);
  assert.deepEqual(parseRemote('git@gitea.acme.local:team/orders-service.git'), want);
  assert.deepEqual(parseRemote('ssh://git@gitea.acme.local:2222/team/orders-service.git'), want);
  assert.deepEqual(parseRemote('ssh://git@gitea.acme.local/team/orders-service'), want);
  assert.deepEqual(parseRemote('http://localhost:3000/team/orders-service'), { baseUrl: 'http://localhost:3000', owner: 'team', repo: 'orders-service' });
  assert.throws(() => parseRemote('nonsense'), /nonsense/);
});
