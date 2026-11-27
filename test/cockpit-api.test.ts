import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseEnv, runWith } from './fixtures/env.ts';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/core/exec.ts';
import { Beads } from '../src/core/bd.ts';
import { buildCtx } from '../src/cli/ctx.ts';
import { createServer, type CockpitModel } from '../src/cockpit/server.ts';
import { startCockpit } from '../src/cli/commands/cockpit.ts';

const TOKEN = 'c'.repeat(64);
const H = { 'x-strand-key': TOKEN };

function sandboxEnv(ws = mkdtempSync(join(tmpdir(), 'strand-api-'))): NodeJS.ProcessEnv {
  const cfg = join(ws, 'config');
  const env: NodeJS.ProcessEnv = { ...baseEnv(), STRAND_WORKSPACE: ws, XDG_CONFIG_HOME: cfg, APPDATA: cfg, HOME: cfg, USERPROFILE: cfg };
  delete env.STRAND_GITEA_URL;
  delete env.STRAND_GITEA_TOKEN;
  return env;
}

const board = { cards: [{ id: 't-1' }], wip: { build: 1, review: 0, limits: { build: 3, review: 3 }, mode: 'warn' } };
const fake = (over: Partial<Record<keyof CockpitModel, unknown>> = {}) =>
  ({
    board: async () => board,
    detail: async (id: string) => {
      if (id === 'nope') throw Object.assign(new Error('bead nope not found'), { code: 'NOT_FOUND' });
      return { id, title: 'T' };
    },
    epics: async () => [{ id: 'e-1' }],
    reviewQueue: async () => [{ id: 't-2' }],
    brief: async () => ({ lines: [] }),
    invalidate: () => {},
    ...over,
  }) as unknown as CockpitModel;

async function app(model: CockpitModel, errs: string[] = []) {
  const ctx = { ...buildCtx(sandboxEnv()), err: (l: string) => errs.push(l) };
  return createServer({ ctx, token: TOKEN, allowedHosts: 'any', model });
}

const ROUTES = ['/api/board', '/api/beads/t-1', '/api/epics', '/api/review', '/api/brief'];

test('every read route is 401 without the key', async () => {
  const s = await app(fake());
  for (const url of ROUTES) assert.equal((await s.inject(url)).statusCode, 401, url);
  await s.close();
});

test('routes return the model JSON with no-store', async () => {
  const s = await app(fake());
  const want: Record<string, unknown> = {
    '/api/board': board,
    '/api/beads/t-1': { id: 't-1', title: 'T' },
    '/api/epics': [{ id: 'e-1' }],
    '/api/review': [{ id: 't-2' }],
    '/api/brief': { lines: [] },
  };
  for (const url of ROUTES) {
    const r = await s.inject({ url, headers: H });
    assert.equal(r.statusCode, 200, url);
    assert.deepEqual(r.json(), want[url]);
    assert.equal(r.headers['cache-control'], 'no-store');
  }
  assert.equal((await s.inject({ url: '/api/health', headers: H })).headers['cache-control'], 'no-store');
  await s.close();
});

test('unknown bead is 404', async () => {
  const s = await app(fake());
  const r = await s.inject({ url: '/api/beads/nope', headers: H });
  assert.equal(r.statusCode, 404);
  assert.deepEqual(r.json(), { error: 'bead nope not found' });
  await s.close();
});

test('Beads unavailable is 503 with its message; anything else is 500 and logged', async () => {
  const errs: string[] = [];
  const s = await app(
    fake({
      board: async () => {
        throw new Error('Beads unavailable: x');
      },
      epics: async () => {
        throw new Error('secret detail');
      },
    }),
    errs,
  );
  const a = await s.inject({ url: '/api/board', headers: H });
  assert.equal(a.statusCode, 503);
  assert.deepEqual(a.json(), { error: 'Beads unavailable: x' });
  const b = await s.inject({ url: '/api/epics', headers: H });
  assert.equal(b.statusCode, 500);
  assert.deepEqual(b.json(), { error: 'internal error' });
  assert.ok(errs.some((e) => e === 'cockpit: GET /api/epics failed: secret detail'));
  await s.close();
});

const hasBd = await run('bd', ['--version']).then((r) => r.code === 0, () => false);

test('startCockpit serves /api/board from a real Model', { skip: hasBd ? false : 'bd not on PATH' }, async () => {
  const ws = mkdtempSync(join(tmpdir(), 'strand-api-real-'));
  const tracker = join(ws, 'tracker');
  mkdirSync(tracker, { recursive: true });
  await run('git', ['init', '-q'], { cwd: tracker });
  const init = await runWith('bd', ['init', '--prefix', 't'], { cwd: tracker, env: { ...baseEnv(), BD_NON_INTERACTIVE: '1' } });
  assert.equal(init.code, 0, init.stderr);
  await new Beads(tracker).create({ title: 'A task', type: 'task', priority: 2 });
  const { url, close } = await startCockpit({ ctx: buildCtx(sandboxEnv(ws)), port: 0, open: false });
  try {
    const base = url.split('/?key=')[0];
    const r = await fetch(`${base}/api/board`, { headers: { 'x-strand-key': url.split('key=')[1] } });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { cards: { title: string }[] };
    assert.deepEqual(body.cards.map((c) => c.title), ['A task']);
  } finally {
    await close();
  }
});

test('malformed bead ids are 404 without reaching the model or being echoed', async () => {
  const seen: string[] = [];
  const s = await app(fake({ detail: async (id: string) => (seen.push(id), { id }) }));
  for (const id of ['--help', 'a%2Fb', '%00', 'x'.repeat(200)]) {
    const r = await s.inject({ url: `/api/beads/${id}`, headers: H });
    assert.equal(r.statusCode, 404, id);
    assert.deepEqual(r.json(), { error: 'bead not found' });
  }
  assert.deepEqual(seen, []);
  await s.close();
});

test('no-store is on every /api response: 401, 403, 404, 500, 503', async () => {
  const hostile = await createServer({ ctx: buildCtx(sandboxEnv()), token: TOKEN, allowedHosts: ['127.0.0.1:1'], model: fake() });
  const r403 = await hostile.inject({ url: '/api/board', headers: { ...H, host: 'evil.example' } });
  assert.equal(r403.statusCode, 403);
  assert.equal(r403.headers['cache-control'], 'no-store');
  await hostile.close();
  const s = await app(
    fake({
      board: async () => {
        throw new Error('Beads unavailable: x');
      },
      epics: async () => {
        throw new Error('boom');
      },
    }),
  );
  const cases: [string, Record<string, string>, number][] = [
    ['/api/board', {}, 401],
    ['/api/beads/nope', H, 404],
    ['/api/beads/--help', H, 404],
    ['/api/unknown', H, 404],
    ['/api/epics', H, 500],
    ['/api/board', H, 503],
  ];
  for (const [url, headers, code] of cases) {
    const r = await s.inject({ url, headers });
    assert.equal(r.statusCode, code, url);
    assert.equal(r.headers['cache-control'], 'no-store', `${url} ${code}`);
  }
  await s.close();
});

test('a non-Fastify error carrying statusCode 404 is still a 500 with no leak', async () => {
  const errs: string[] = [];
  const ctx = { ...buildCtx(sandboxEnv()), err: (l: string) => errs.push(l) };
  const s = await createServer({
    ctx,
    token: TOKEN,
    allowedHosts: 'any',
    routes: (a) => {
      a.get('/api/leak', async () => {
        throw Object.assign(new Error('secret-path /etc/x'), { statusCode: 404 });
      });
    },
  });
  const r = await s.inject({ url: '/api/leak', headers: H });
  assert.equal(r.statusCode, 500);
  assert.deepEqual(r.json(), { error: 'internal error' });
  assert.ok(!r.body.includes('secret'));
  assert.equal(errs.length, 1);
  await s.close();
});
