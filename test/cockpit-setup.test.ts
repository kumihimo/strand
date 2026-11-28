import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseEnv } from './fixtures/env.ts';
import { buildCtx, type Ctx } from '../src/cli/ctx.ts';
import { createServer } from '../src/cockpit/server.ts';
import type { SetupDeps } from '../src/cockpit/setup-routes.ts';
import { MINIMUM_VERSIONS, REQUIRED_TOOLS, TOOL_NAMES, type ToolName, type ToolState } from '../src/core/tools.ts';
import type { OfferedTool } from '../src/core/offered.ts';

const TOKEN = 'f'.repeat(64);
const H = { 'x-strand-key': TOKEN };
const HOST = '127.0.0.1:4100';

function sandbox() {
  const ws = mkdtempSync(join(tmpdir(), 'strand-cockpit-setup-'));
  const cfgDir = join(ws, 'cfg');
  mkdirSync(cfgDir);
  mkdirSync(join(ws, 'tracker'));
  const path = join(cfgDir, 'config.json');
  writeFileSync(path, '{}\n');
  const env: NodeJS.ProcessEnv = { ...baseEnv(), STRAND_WORKSPACE: ws, STRAND_CONFIG_DIR: cfgDir, HOME: ws, USERPROFILE: ws, XDG_CONFIG_HOME: join(ws, 'xdg'), APPDATA: join(ws, 'xdg') };
  for (const k of ['STRAND_GITEA_URL', 'STRAND_GITEA_TOKEN', 'STRAND_CLAUDE_PATH', 'STRAND_BUT_PATH', 'STRAND_GH_PATH']) delete env[k];
  const ctx: Ctx = buildCtx(env, { out: () => {}, err: () => {} });
  return { ws, path, ctx };
}

/** A machine where `missing` tools are missing and `old` ones too old; the rest are fine. */
function machine(missing: ToolName[] = [], old: ToolName[] = []) {
  const state = new Map<ToolName, ToolState>();
  for (const name of TOOL_NAMES) {
    const base = { name, min: MINIMUM_VERSIONS[name], required: REQUIRED_TOOLS.includes(name) };
    state.set(
      name,
      missing.includes(name)
        ? { ...base, status: 'missing' }
        : old.includes(name)
          ? { ...base, status: 'old', found: '0.0.1', path: `/bin/${name}` }
          : { ...base, status: 'ok', found: MINIMUM_VERSIONS[name], path: `/bin/${name}` },
    );
  }
  return state;
}

type Installed = { tool: OfferedTool; finish: (r: { path: string } | Error) => void };

/** Deps whose installs wait until the test finishes them. */
function fakes(state: Map<ToolName, ToolState>) {
  const installs: Installed[] = [];
  const deps: SetupDeps = {
    probe: async () => [...state.values()],
    install: (tool, log) =>
      new Promise((resolve, reject) => {
        log(`installing ${tool}`);
        installs.push({
          tool,
          finish: (r) => {
            if (r instanceof Error) return reject(r);
            const s = state.get(tool)!;
            state.set(tool, { ...s, status: 'ok', found: MINIMUM_VERSIONS[tool], path: r.path });
            resolve({ path: r.path, found: MINIMUM_VERSIONS[tool] });
          },
        });
      }),
  };
  return { deps, installs };
}

async function server(ctx: Ctx, setup: SetupDeps, allowedHosts: string[] | 'any' = 'any') {
  return createServer({ ctx, token: TOKEN, allowedHosts, setup });
}

const settle = () => new Promise((r) => setImmediate(r));

test('GET /api/setup lists each tool, the offers with their licence links, and whether setup is needed', async () => {
  const { ctx } = sandbox();
  const s = await server(ctx, fakes(machine(['but'])).deps);
  const r = await s.inject({ url: '/api/setup', headers: H });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.deepEqual(body.tools.map((t: ToolState) => t.name), [...TOOL_NAMES]);
  assert.equal(body.ready, false);
  const but = body.offers.find((o: { tool: string }) => o.tool === 'but');
  assert.match(but.licence.url, /^https:\/\//);
  assert.equal(typeof but.action, 'string');
  assert.equal(but.available, true);
  assert.equal(but.plan, undefined, 'the plan stays on the server');
  await s.close();
});

test('GET /api/setup is ready when every required tool is ok, even with gh missing', async () => {
  const { ctx } = sandbox();
  const s = await server(ctx, fakes(machine(['gh'])).deps);
  assert.equal((await s.inject({ url: '/api/setup', headers: H })).json().ready, true);
  await s.close();
});

test('AT-6 no consent, an unknown tool, a bad body or an installed tool: 400 or 409, and nothing runs', async () => {
  const { ctx } = sandbox();
  const { deps, installs } = fakes(machine(['claude'], ['but']));
  const s = await server(ctx, deps);
  const post = (payload: unknown) => s.inject({ method: 'POST', url: '/api/setup/install', headers: H, payload: payload as object });
  for (const payload of [{ tool: 'claude' }, { tool: 'claude', consent: false }, { tool: 'claude', consent: 'yes' }]) {
    const r = await post(payload);
    assert.equal(r.statusCode, 400, JSON.stringify(payload));
    assert.match(r.json().error, /consent/);
  }
  for (const payload of [{ tool: 'git', consent: true }, { tool: '__proto__', consent: true }, { tool: 'rm -rf /', consent: true }]) {
    const r = await post(payload);
    assert.equal(r.statusCode, 400, JSON.stringify(payload));
    assert.doesNotMatch(r.body, /rm -rf/, 'an unknown tool name is never echoed');
  }
  assert.equal((await post([1, 2])).statusCode, 400);
  // Installed at any version: an old but gets its upgrade instruction, not an install.
  const old = await post({ tool: 'but', consent: true });
  assert.equal(old.statusCode, 409);
  assert.match(old.json().error, /already installed/);
  assert.match(old.json().error, /but update/);
  const ok = await post({ tool: 'gh', consent: true });
  assert.equal(ok.statusCode, 409);
  assert.equal(installs.length, 0);
  await s.close();
});

test('AT-7 a second install while one runs answers 409', async () => {
  const { ctx } = sandbox();
  const { deps, installs } = fakes(machine(['claude', 'gh']));
  const s = await server(ctx, deps);
  const first = await s.inject({ method: 'POST', url: '/api/setup/install', headers: H, payload: { tool: 'claude', consent: true } });
  assert.equal(first.statusCode, 202);
  assert.equal(first.json().install.state, 'running');
  const second = await s.inject({ method: 'POST', url: '/api/setup/install', headers: H, payload: { tool: 'gh', consent: true } });
  assert.equal(second.statusCode, 409);
  assert.match(second.json().error, /running/);
  assert.equal(installs.length, 1);
  installs[0]!.finish(new Error('stop'));
  await settle();
  await s.close();
});

test('AT-10 a failed install shows its reason and log, and the tool stays missing', async () => {
  const { ctx, path } = sandbox();
  const { deps, installs } = fakes(machine(['but']));
  const s = await server(ctx, deps);
  await s.inject({ method: 'POST', url: '/api/setup/install', headers: H, payload: { tool: 'but', consent: true } });
  installs[0]!.finish(new Error('the GitButler installer exited with code 3'));
  await settle();
  const r = await s.inject({ url: '/api/setup/install/but', headers: H });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().state, 'failed');
  assert.match(r.json().error, /exited with code 3/);
  assert.deepEqual(r.json().log, ['installing but']);
  const setup = (await s.inject({ url: '/api/setup', headers: H })).json();
  assert.equal(setup.tools.find((t: ToolState) => t.name === 'but').status, 'missing');
  assert.equal(setup.install.state, 'failed');
  assert.equal(readFileSync(path, 'utf8'), '{}\n', 'nothing saved');
  // The tool can be tried again.
  const again = await s.inject({ method: 'POST', url: '/api/setup/install', headers: H, payload: { tool: 'but', consent: true } });
  assert.equal(again.statusCode, 202);
  installs[1]!.finish(new Error('again'));
  await settle();
  await s.close();
});

test('AT-11 a finished install saves the absolute path to the config and puts its folder on PATH', async () => {
  const { ctx, path, ws } = sandbox();
  const exe = join(ws, 'tools', 'gh', 'bin', 'gh');
  mkdirSync(join(ws, 'tools', 'gh', 'bin'), { recursive: true });
  writeFileSync(exe, '');
  const { deps, installs } = fakes(machine(['gh']));
  const s = await server(ctx, deps);
  await s.inject({ method: 'POST', url: '/api/setup/install', headers: H, payload: { tool: 'gh', consent: true } });
  installs[0]!.finish({ path: exe });
  await settle();
  const r = (await s.inject({ url: '/api/setup/install/gh', headers: H })).json();
  assert.equal(r.state, 'done', JSON.stringify(r));
  assert.equal(r.path, exe);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { ghPath: exe });
  assert.equal(ctx.config.ghPath, exe);
  const key = Object.keys(ctx.env).find((k) => k.toUpperCase() === 'PATH')!;
  assert.ok(ctx.env[key]!.split(process.platform === 'win32' ? ';' : ':').includes(join(ws, 'tools', 'gh', 'bin')));
  await s.close();
});

test('GET /api/setup/install/:tool is 404 for an unknown tool or one never installed', async () => {
  const { ctx } = sandbox();
  const s = await server(ctx, fakes(machine()).deps);
  assert.equal((await s.inject({ url: '/api/setup/install/git', headers: H })).statusCode, 404);
  assert.equal((await s.inject({ url: '/api/setup/install/claude', headers: H })).statusCode, 404);
  await s.close();
});

test('AT-12 the setup routes refuse a request with no key cookie or a foreign Origin, and nothing runs', async () => {
  const { ctx } = sandbox();
  const { deps, installs } = fakes(machine(['claude']));
  const s = await server(ctx, deps, [HOST]);
  const payload = { tool: 'claude', consent: true };
  const noKey = await s.inject({ method: 'POST', url: '/api/setup/install', headers: { host: HOST }, payload });
  assert.equal(noKey.statusCode, 401);
  const foreign = await s.inject({ method: 'POST', url: '/api/setup/install', headers: { ...H, host: HOST, origin: 'http://evil.example' }, payload });
  assert.equal(foreign.statusCode, 403);
  assert.equal((await s.inject({ url: '/api/setup', headers: { host: HOST } })).statusCode, 401);
  assert.equal(installs.length, 0);
  await s.close();
});
