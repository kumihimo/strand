import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseEnv } from './fixtures/env.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCtx } from '../src/cli/ctx.ts';
import { createServer } from '../src/cockpit/server.ts';
import { WorkQueue } from '../src/cockpit/queue-runner.ts';
import { BdError, type ListedBead } from '../src/core/bd.ts';
import { readQueue } from '../src/core/queue-store.ts';

const TOKEN = 'q'.repeat(64);
const H = { 'x-strand-key': TOKEN };

const row = (id: string, status: string): ListedBead => ({ id, title: id, status, priority: 2, issue_type: 'task', labels: ['repo:app'], dependencies: [] });

function sandboxEnv(): NodeJS.ProcessEnv {
  const ws = mkdtempSync(join(tmpdir(), 'strand-queue-api-'));
  const cfg = join(ws, 'config');
  const env: NodeJS.ProcessEnv = { ...baseEnv(), STRAND_WORKSPACE: ws, XDG_CONFIG_HOME: cfg, APPDATA: cfg, HOME: cfg, USERPROFILE: cfg };
  delete env.STRAND_GITEA_URL;
  delete env.STRAND_GITEA_TOKEN;
  return env;
}

async function setup(o: { beadsDown?: boolean; noQueue?: boolean } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'strand-queue-api-')), 'queue.json');
  const beads = new Map([row('t-1', 'open'), row('t-2', 'open'), row('t-3', 'open'), row('t-wip', 'in_progress')].map((b) => [b.id, b]));
  const queue = new WorkQueue({
    file,
    // No room: the routes are tested without anything starting.
    limit: () => 0,
    beads: async () => {
      if (o.beadsDown) throw new BdError('bd list failed', 'database locked');
      return beads;
    },
    cwdFor: () => '/ws/app',
    terminals: { list: () => [], start: () => assert.fail('nothing starts') },
    comment: async () => {},
    warn: () => {},
  });
  const ctx = { ...buildCtx(sandboxEnv()), err: () => {} };
  const app = await createServer({ ctx, token: TOKEN, allowedHosts: 'any', queue: o.noQueue ? undefined : queue });
  const send = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = H) =>
    app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body as object }) });
  return { app, file, queue, send };
}

test('AT-9 POST appends, PUT reorders and removes, DELETE removes one, GET shows the queue', async () => {
  const s = await setup();
  assert.deepEqual((await s.send('GET', '/api/queue')).json(), { available: true, ids: [] });
  let r = await s.send('POST', '/api/queue', { ids: ['t-2', 't-1'] });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ids: ['t-2', 't-1'] });
  r = await s.send('POST', '/api/queue', { ids: ['t-3'] });
  assert.deepEqual(r.json(), { ids: ['t-2', 't-1', 't-3'] });
  r = await s.send('PUT', '/api/queue', { ids: ['t-3', 't-2'] });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ids: ['t-3', 't-2'] });
  r = await s.send('DELETE', '/api/queue/t-3');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ids: ['t-2'] });
  assert.deepEqual((await s.send('GET', '/api/queue')).json(), { available: true, ids: ['t-2'] });
  assert.deepEqual(readQueue(s.file), ['t-2']);
});

test('AT-9 an unknown id is 404 and a bead not in Backlog is 409, and nothing is queued', async () => {
  const s = await setup();
  let r = await s.send('POST', '/api/queue', { ids: ['t-1', 'nope'] });
  assert.equal(r.statusCode, 404);
  assert.match(r.json().error, /nope not found/);
  r = await s.send('POST', '/api/queue', { ids: ['t-1', 't-wip'] });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /t-wip is not in Backlog/);
  assert.deepEqual(s.queue.ids(), []);
  // A PUT may only reorder or drop queued ids: anything else is a stale client.
  await s.send('POST', '/api/queue', { ids: ['t-1'] });
  r = await s.send('PUT', '/api/queue', { ids: ['t-1', 't-2'] });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /not queued: t-2/);
  r = await s.send('DELETE', '/api/queue/--help');
  assert.equal(r.statusCode, 404);
});

test('AT-9 a malformed body is 400', async () => {
  const s = await setup();
  const bad: unknown[] = [
    {},
    [],
    { ids: 't-1' },
    { ids: [] },
    { ids: [1] },
    { ids: ['--help'] },
    { ids: ['t-1'], extra: true },
    { ids: Array.from({ length: 201 }, (_, i) => `t-${i}`) },
  ];
  for (const body of bad) {
    const r = await s.send('POST', '/api/queue', body);
    assert.equal(r.statusCode, 400, JSON.stringify(body).slice(0, 60));
    // A PUT may empty the queue, so only its empty list is allowed.
    if (JSON.stringify(body) !== '{"ids":[]}') assert.equal((await s.send('PUT', '/api/queue', body)).statusCode, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await s.send('PUT', '/api/queue', { ids: [] })).statusCode, 200);
});

test('AT-9 every queue route is refused without the key', async () => {
  const s = await setup();
  for (const [method, url] of [['GET', '/api/queue'], ['POST', '/api/queue'], ['PUT', '/api/queue'], ['DELETE', '/api/queue/t-1']] as const) {
    const r = await s.send(method, url, method === 'POST' || method === 'PUT' ? { ids: ['t-1'] } : undefined, {});
    assert.equal(r.statusCode, 401, `${method} ${url}`);
  }
  assert.deepEqual(s.queue.ids(), []);
});

test('a Beads outage is 503', async () => {
  const s = await setup({ beadsDown: true });
  const r = await s.send('POST', '/api/queue', { ids: ['t-1'] });
  assert.equal(r.statusCode, 503);
  assert.match(r.json().error, /Beads unavailable/);
});

test('without a queue (no terminals) GET says so and writes are 503', async () => {
  const s = await setup({ noQueue: true });
  const g = (await s.send('GET', '/api/queue')).json();
  assert.equal(g.available, false);
  assert.deepEqual(g.ids, []);
  assert.equal((await s.send('POST', '/api/queue', { ids: ['t-1'] })).statusCode, 503);
  assert.equal((await s.send('DELETE', '/api/queue/t-1')).statusCode, 503);
});
