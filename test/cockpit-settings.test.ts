import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseEnv } from './fixtures/env.ts';
import { buildCtx, type Ctx } from '../src/cli/ctx.ts';
import { createServer } from '../src/cockpit/server.ts';
import { Model } from '../src/cockpit/model.ts';

const TOKEN = 'd'.repeat(64);
const H = { 'x-strand-key': TOKEN };
const HOST = '127.0.0.1:4100';

/** A sandboxed workspace and config folder; the config file starts as `file`. */
function sandbox(file: unknown = { wip: { build: 3, review: 3, mode: 'warn' } }, extra: NodeJS.ProcessEnv = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'strand-cockpit-settings-'));
  const cfgDir = join(ws, 'cfg');
  mkdirSync(cfgDir);
  mkdirSync(join(ws, 'tracker'));
  const path = join(cfgDir, 'config.json');
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
  const env: NodeJS.ProcessEnv = { ...baseEnv(), STRAND_WORKSPACE: ws, STRAND_CONFIG_DIR: cfgDir, HOME: ws, USERPROFILE: ws, XDG_CONFIG_HOME: join(ws, 'xdg'), APPDATA: join(ws, 'xdg'), ...extra };
  delete env.STRAND_GITEA_URL;
  delete env.STRAND_GITEA_TOKEN;
  // No bd: the model lists no beads.
  const ctx: Ctx = { ...buildCtx(env, { out: () => {}, err: () => {} }), beads: { listAll: async () => [] } as unknown as Ctx['beads'] };
  return { ws, path, ctx };
}

async function server(ctx: Ctx, allowedHosts: string[] | 'any' = 'any') {
  return createServer({ ctx, token: TOKEN, allowedHosts, model: new Model(ctx, { github: () => ({}) as never }) });
}

test('AT-1 GET /api/settings lists every value and whether a Gitea token is present', async () => {
  const { ctx, path } = sandbox();
  const s = await server(ctx);
  const r = await s.inject({ url: '/api/settings', headers: H });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.path, path);
  assert.equal(body.fields.length, 16);
  assert.equal(body.giteaToken, false);
  // The workspace is set by STRAND_WORKSPACE in this sandbox.
  assert.equal(body.fields.find((f: { key: string }) => f.key === 'workspaceRoot').envVar, 'STRAND_WORKSPACE');
  await s.close();
});

test('AT-3 an invalid value answers 400 naming the field and leaves the file byte-identical', async () => {
  const { ctx, path } = sandbox();
  const before = readFileSync(path, 'utf8');
  const s = await server(ctx);
  for (const payload of [{ 'wip.mode': 'x' }, { 'cockpit.maxSessions': 0 }, { claudeModel: 'bad model' }, { 'wip.build': 'three' }]) {
    const r = await s.inject({ method: 'PUT', url: '/api/settings', headers: H, payload });
    assert.equal(r.statusCode, 400, JSON.stringify(payload));
    const key = Object.keys(payload)[0] as string;
    assert.equal(typeof r.json().fields[key], 'string', key);
    assert.equal(readFileSync(path, 'utf8'), before);
  }
  await s.close();
});

test('AT-6 a PUT with an unknown key, or a body that is not an object, answers 400 and writes nothing', async () => {
  const { ctx, path } = sandbox();
  const before = readFileSync(path, 'utf8');
  const s = await server(ctx);
  for (const payload of [{ 'wip.build': 4, evil: 1 }, [1], 'x']) {
    const r = await s.inject({ method: 'PUT', url: '/api/settings', headers: { ...H, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    assert.equal(r.statusCode, 400, JSON.stringify(payload));
    assert.ok(!r.body.includes('evil'));
  }
  assert.equal(readFileSync(path, 'utf8'), before);
  await s.close();
});

test('AT-7 a PUT with no key, or from a foreign Origin, is refused and writes nothing', async () => {
  const { ctx, path } = sandbox();
  const before = readFileSync(path, 'utf8');
  const s = await server(ctx, [HOST]);
  const payload = { 'wip.build': 9 };
  const noKey = await s.inject({ method: 'PUT', url: '/api/settings', headers: { host: HOST }, payload });
  assert.equal(noKey.statusCode, 401);
  const foreign = await s.inject({ method: 'PUT', url: '/api/settings', headers: { ...H, host: HOST, origin: 'http://evil.example' }, payload });
  assert.equal(foreign.statusCode, 403);
  const noKeyGet = await s.inject({ url: '/api/settings', headers: { host: HOST } });
  assert.equal(noKeyGet.statusCode, 401);
  assert.equal(readFileSync(path, 'utf8'), before);
  await s.close();
});

test('AT-8 a saved wip.build shows in GET /api/brief without a restart; restart values stay as started', async () => {
  const { ctx, path } = sandbox();
  const s = await server(ctx);
  const brief = async () => (await s.inject({ url: '/api/brief', headers: H })).json();
  assert.equal((await brief()).wip.build.limit, 3);
  const r = await s.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { 'wip.build': 5, 'cockpit.maxSessions': 7 } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().fields.find((f: { key: string }) => f.key === 'wip.build').effective, 5);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).wip, { build: 5, review: 3, mode: 'warn' });
  assert.equal((await brief()).wip.build.limit, 5);
  // maxSessions is read when the cockpit starts: the running server keeps its value.
  assert.equal(ctx.config.cockpit.maxSessions, 4);
  await s.close();
});

test('a malformed config file answers 409 and is not overwritten', async () => {
  const { ctx, path } = sandbox();
  const s = await server(ctx);
  writeFileSync(path, '{ broken');
  const r = await s.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { 'wip.build': 4 } });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /Malformed config file/);
  assert.equal(readFileSync(path, 'utf8'), '{ broken');
  await s.close();
});
