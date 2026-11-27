import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { get as httpGet } from 'node:http';
import assert from 'node:assert/strict';
import { baseEnv } from './fixtures/env.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildCtx } from '../src/cli/ctx.ts';
import { createServer, REPO_ROOT, uiNotBuiltHint } from '../src/cockpit/server.ts';
import { newToken, tokenMatches } from '../src/cockpit/auth.ts';
import { startCockpit, main, cockpitTerminals } from '../src/cli/commands/cockpit.ts';
import { Terminals, type SpawnPty } from '../src/cockpit/pty.ts';
import { recordEnd, recordStart, sessionsFor, writeEntry } from '../src/core/sessions.ts';
import { instanceFile, readInstance, writeInstance } from '../src/cockpit/instance.ts';
import type { DesktopApp, SpawnDesktop } from '../src/cockpit/desktop.ts';

function sandboxEnv(): NodeJS.ProcessEnv {
  const ws = mkdtempSync(join(tmpdir(), 'strand-'));
  const cfg = join(ws, 'config');
  const env: NodeJS.ProcessEnv = { ...baseEnv(), STRAND_WORKSPACE: ws, XDG_CONFIG_HOME: cfg, APPDATA: cfg, HOME: cfg, USERPROFILE: cfg };
  delete env.STRAND_GITEA_URL;
  delete env.STRAND_GITEA_TOKEN;
  delete env.STRAND_ARTEFACTS_VCS;
  // Transcripts are looked up under <home>/.claude, which is the sandbox: never the real one.
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

const TOKEN = 'a'.repeat(64);
const MSG = 'Open the cockpit using the link printed by strand cockpit';

async function app(uiDir?: string) {
  return createServer({ ctx: buildCtx(sandboxEnv()), token: TOKEN, uiDir, allowedHosts: 'any' });
}

test('newToken is 32 random bytes of hex, fresh each time', () => {
  assert.match(newToken(), /^[0-9a-f]{64}$/);
  assert.notEqual(newToken(), newToken());
});

test('tokenMatches rejects different lengths and wrong values', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches('short', TOKEN), false);
  assert.equal(tokenMatches('b'.repeat(64), TOKEN), false);
  assert.equal(tokenMatches(undefined, TOKEN), false);
});

test('/api/health requires the key', async () => {
  const s = await app();
  const none = await s.inject('/api/health');
  assert.equal(none.statusCode, 401);
  assert.deepEqual(none.json(), { error: 'unauthorized' });
  const wrong = await s.inject({ url: '/api/health', headers: { 'x-strand-key': 'b'.repeat(64) } });
  assert.equal(wrong.statusCode, 401);
  const ok = await s.inject({ url: '/api/health', headers: { 'x-strand-key': TOKEN } });
  assert.equal(ok.statusCode, 200);
  const body = ok.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, 'string');
  await s.close();
});

test('GET /?key= sets the cookie and redirects; the cookie then authorises the API', async () => {
  const s = await app();
  const r = await s.inject(`/?key=${TOKEN}`);
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, '/');
  const cookie = String(r.headers['set-cookie']);
  assert.match(cookie, new RegExp(`strand_key=${TOKEN}`));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Path=\//);
  const api = await s.inject({ url: '/api/health', headers: { cookie: `strand_key=${TOKEN}` } });
  assert.equal(api.statusCode, 200);
  await s.close();
});

test('wrong ?key= is 401 and sets no cookie; / without credentials is the plain-text 401', async () => {
  const s = await app();
  const bad = await s.inject('/?key=nope');
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.headers['set-cookie'], undefined);
  const none = await s.inject('/');
  assert.equal(none.statusCode, 401);
  assert.equal(none.body, MSG);
  assert.match(String(none.headers['content-type']), /text\/plain/);
  await s.close();
});

test('with the cookie, / shows the not-built page when uiDir is missing', async () => {
  const s = await app(join(tmpdir(), 'strand-no-such-ui-dir'));
  const r = await s.inject({ url: '/', headers: { cookie: `strand_key=${TOKEN}` } });
  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers['content-type']), /text\/html/);
  assert.match(r.body, /npm run build:ui/);
  await s.close();
});

test('built UI is served with the cookie and refused without it', async () => {
  const ui = mkdtempSync(join(tmpdir(), 'strand-ui-'));
  writeFileSync(join(ui, 'index.html'), '<h1>cockpit ui</h1>');
  writeFileSync(join(ui, 'app.js'), 'console.log(1)');
  const s = await app(ui);
  const h = { cookie: `strand_key=${TOKEN}` };
  assert.match((await s.inject({ url: '/', headers: h })).body, /cockpit ui/);
  assert.equal((await s.inject({ url: '/app.js', headers: h })).statusCode, 200);
  assert.match((await s.inject({ url: '/some/client/route', headers: h })).body, /cockpit ui/);
  assert.equal((await s.inject('/app.js')).statusCode, 401);
  await s.close();
});

test('startCockpit listens on 127.0.0.1 and close stops it', async () => {
  const { url, close } = await startCockpit({ ctx: buildCtx(sandboxEnv()), port: 0, open: false });
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?key=[0-9a-f]{64}$/);
  const base = url.split('/?key=')[0];
  assert.equal((await fetch(`${base}/api/health`)).status, 401);
  const key = url.split('key=')[1];
  assert.equal((await fetch(`${base}/api/health`, { headers: { 'x-strand-key': key } })).status, 200);
  await close();
  await assert.rejects(fetch(`${base}/api/health`));
});

test('startCockpit builds terminals from the pty loader and kills them all on close', async (t) => {
  const killAll = t.mock.method(Terminals.prototype, 'killAll');
  const { url, close } = await startCockpit({
    ctx: buildCtx(sandboxEnv()),
    port: 0,
    open: false,
    loadPty: async () => ({ spawn: () => { throw new Error('no spawn in this test'); } }),
  });
  const [base, key] = url.split('/?key=');
  const list = await fetch(`${base}/api/terminals`, { headers: { 'x-strand-key': key! } });
  assert.deepEqual(await list.json(), { available: true, terminals: [] });
  assert.equal(killAll.mock.callCount(), 0);
  await close();
  assert.equal(killAll.mock.callCount(), 1);
});

test('a cockpit terminal that ends, or is stopped with the server, ends its session in the index', () => {
  const ctx = buildCtx(sandboxEnv());
  const exits: (() => void)[] = [];
  const argv: string[][] = [];
  const spawn: SpawnPty = (_file, args) => (argv.push(args), {
    pid: 1,
    write() {},
    resize() {},
    kill() {},
    onData() {},
    onExit(cb) {
      exits.push(() => cb({ exitCode: 0 }));
    },
  });
  const { terminals } = cockpitTerminals(ctx, spawn);
  const dir = ctx.config.trackerDir;
  const SID = '0123abcd-0123-4abc-8def-0123456789ab';
  writeEntry(dir, { sessionId: SID, beadId: 'b-2', startedAt: '2020-01-01T00:00:00.000Z' });
  terminals.start({ beadId: 'b-1', cwd: dir, mode: 'work' });
  terminals.start({ beadId: 'b-2', cwd: dir, mode: 'resume', sessionId: SID });
  // What `strand work --session-id <id>` writes when the new session starts.
  const made = argv[0]![argv[0]!.indexOf('--session-id') + 1]!;
  recordStart(dir, { sessionId: made, beadId: 'b-1' });
  // A desktop session on the same bead, started after the terminal: it must stay live.
  recordStart(dir, { sessionId: 'desktop-1', beadId: 'b-1' });
  exits[0]!();
  const b1 = sessionsFor(dir, 'b-1');
  assert.ok(b1.find((s) => s.sessionId === made)!.endedAt);
  assert.equal(b1.find((s) => s.sessionId === 'desktop-1')!.endedAt, undefined);
  assert.equal(sessionsFor(dir, 'b-2')[0]!.endedAt, undefined);
  terminals.killAll();
  assert.ok(sessionsFor(dir, 'b-2')[0]!.endedAt);
});

/**
 * The cockpit's terminal manager over fake ptys, a sandboxed home for Claude Code's transcripts and a fake
 * bead comment. `start` starts a work terminal for the bead and records its session as `strand work` would.
 */
function transcriptRig() {
  const env = sandboxEnv();
  const ctx = { ...buildCtx(env) };
  const comments: string[] = [];
  ctx.beads = { comment: async (id: string, text: string) => void comments.push(`${id} ${text}`) } as never;
  const exits: (() => void)[] = [];
  const argv: string[][] = [];
  const spawn: SpawnPty = (_file, args) => (argv.push(args), {
    pid: 1,
    write() {},
    resize() {},
    kill() {},
    onData() {},
    onExit(cb) {
      exits.push(() => cb({ exitCode: 0 }));
    },
  });
  const { terminals, settle } = cockpitTerminals(ctx, spawn);
  const dir = ctx.config.trackerDir;
  const projects = join(env.USERPROFILE!, '.claude', 'projects', 'C--x-app');
  mkdirSync(projects, { recursive: true });
  const start = (beadId: string): string => {
    terminals.start({ beadId, cwd: dir, mode: 'work' });
    const a = argv.at(-1)!;
    const sid = a[a.indexOf('--session-id') + 1]!;
    recordStart(dir, { sessionId: sid, beadId });
    return sid;
  };
  /** Claude Code's transcript for a session, under the sandboxed home. */
  const transcript = (sid: string, text = '{"a":1}\n'): string => {
    const file = join(projects, `${sid}.jsonl`);
    writeFileSync(file, text);
    return file;
  };
  const gz = (beadId: string, sid: string) => join(dir, 'artefacts', beadId, 'sessions', `${sid}.jsonl.gz`);
  return { dir, exits, terminals, settle, comments, start, transcript, gz };
}

test('a stop archives a transcript only after the terminal has exited', async () => {
  const r = transcriptRig();
  const s1 = r.start('b-1');
  r.transcript(s1);
  r.terminals.killAll();
  // The end is recorded at once, with the path; Claude may still be writing, so nothing is archived yet.
  assert.ok(sessionsFor(r.dir, 'b-1')[0]!.endedAt);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(existsSync(r.gz('b-1', s1)), false);
  r.exits[0]!();
  await r.settle(2000);
  assert.equal(sessionsFor(r.dir, 'b-1')[0]!.archived, true);
  assert.ok(existsSync(r.gz('b-1', s1)));
});

test('a terminal that exits after a /clear ends and archives the session that replaced its first one', async () => {
  const r = transcriptRig();
  const s1 = r.start('b-1');
  // What the hooks write on /clear: the end of s1, then s2 linked to it.
  recordEnd(r.dir, { sessionId: s1 });
  const s2 = '11111111-2222-4333-8444-555555555555';
  recordStart(r.dir, { sessionId: s2, beadId: 'b-1', replaces: s1 });
  r.transcript(s2);
  r.exits[0]!();
  await r.settle(2000);
  const e2 = sessionsFor(r.dir, 'b-1').find((e) => e.sessionId === s2)!;
  assert.ok(e2.endedAt);
  assert.equal(e2.archived, true);
  assert.ok(existsSync(r.gz('b-1', s2)));
});

test('a stop whose terminal does not exit in time leaves the transcript for strand archive', async () => {
  const r = transcriptRig();
  const s1 = r.start('b-1');
  const file = r.transcript(s1);
  r.terminals.killAll();
  await r.settle(30);
  const e = sessionsFor(r.dir, 'b-1')[0]!;
  assert.equal(e.transcriptPath, file);
  assert.equal(e.archived, undefined);
  // A late exit after the bound does not archive either: the server is going away.
  r.exits[0]!();
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(existsSync(r.gz('b-1', s1)), false);
  assert.equal(sessionsFor(r.dir, 'b-1')[0]!.archived, undefined);
});

test('a session the cockpit ends gets its transcript path and is archived off the request path', async () => {
  const { dir, exits, settle, comments, start, transcript: write } = transcriptRig();
  const s1 = start('b-1');
  start('b-2');
  // A transcript for s1 only.
  const transcript = write(s1);
  exits[0]!();
  exits[1]!();
  const e1 = sessionsFor(dir, 'b-1')[0]!;
  assert.equal(e1.transcriptPath, transcript);
  assert.equal(sessionsFor(dir, 'b-2')[0]!.transcriptPath, undefined, 'no file: no path');
  await settle(2000);
  const gz = join(dir, 'artefacts', 'b-1', 'sessions', `${s1}.jsonl.gz`);
  assert.equal(gunzipSync(readFileSync(gz)).toString(), '{"a":1}\n');
  assert.equal(sessionsFor(dir, 'b-1')[0]!.archived, true);
  assert.deepEqual(comments, [`b-1 session ${s1} archived`]);
});

test('startCockpit stays up when the pty module cannot load, and says why', async () => {
  const { url, close } = await startCockpit({ ctx: buildCtx(sandboxEnv()), port: 0, open: false, loadPty: async () => ({ error: 'no binary' }) });
  const [base, key] = url.split('/?key=');
  const list = await fetch(`${base}/api/terminals`, { headers: { 'x-strand-key': key! } });
  assert.deepEqual(await list.json(), { available: false, reason: 'node-pty could not load: no binary', terminals: [] });
  await close();
});

test('strand cockpit prints exactly one Cockpit: line and returns 0 on abort', async () => {
  const lines: string[] = [];
  const ctx = { ...buildCtx(sandboxEnv()), out: (l: string) => lines.push(l) };
  const ac = new AbortController();
  const done = main(['--port', '0', '--no-open'], ctx, { signal: ac.signal });
  while (lines.length === 0) await new Promise((r) => setTimeout(r, 10));
  ac.abort();
  assert.equal(await done, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Cockpit: http:\/\/127\.0\.0\.1:\d+\/\?key=[0-9a-f]{64}$/);
});

test('a bad --port is rejected', async () => {
  const ctx = buildCtx(sandboxEnv());
  await assert.rejects(main(['--port', 'abc'], ctx), /port/);
  for (const bad of ['', ' ', '1e3', '0x10', '+80', '-1', '80.0', '65536', ' 80']) {
    await assert.rejects(main([`--port=${bad}`], ctx), /^Error: usage: strand cockpit \[--port <0-65535>\] \[--no-open\] \[--window app\|tab\|none\] \[--ipc\]$/, JSON.stringify(bad));
  }
});

test('STRAND_COCKPIT_PORT sets the default port; --port wins; a bad value is rejected', async () => {
  const env = { ...sandboxEnv(), STRAND_COCKPIT_PORT: '0' };
  const lines: string[] = [];
  const ac = new AbortController();
  const done = main(['--window', 'none'], { ...buildCtx(env), out: (l) => lines.push(l) }, { signal: ac.signal });
  await untilLine(lines);
  assert.notEqual(new URL(lines[0]!.replace(/^Cockpit: /, '')).port, '4747');
  ac.abort();
  assert.equal(await done, 0);
  for (const bad of ['abc', '-1', '65536']) {
    await assert.rejects(main([], buildCtx({ ...env, STRAND_COCKPIT_PORT: bad }), { start: () => assert.fail('no server') }), /^Error: usage: strand cockpit/, bad);
  }
});

test('a bad --window is rejected before anything starts', async () => {
  const ctx = buildCtx(sandboxEnv());
  for (const bad of ['', 'App', 'kiosk', 'app ']) {
    await assert.rejects(main([`--window=${bad}`], ctx, { start: () => assert.fail('no server') }), /^Error: usage: strand cockpit/, JSON.stringify(bad));
  }
});

test('a port in use says a cockpit may be running, and does not suggest a second server', async () => {
  const ctx = buildCtx(sandboxEnv());
  const first = await startCockpit({ ctx, port: 0, open: false });
  const port = Number(new URL(first.url).port);
  try {
    await assert.rejects(startCockpit({ ctx, port, open: false }), (e: Error) => {
      assert.equal(e.message, `port ${port} is in use; a cockpit may already be running`);
      return true;
    });
    // Through strand cockpit with no key file to find: the same message.
    await assert.rejects(main(['--port', String(port), '--window', 'none'], ctx), /^Error: port \d+ is in use; a cockpit may already be running$/);
  } finally {
    await first.close();
  }
});

test('on a busy port strand cockpit reads the key file again and attaches to a server that answers', async () => {
  const env = sandboxEnv();
  const live = await startCockpit({ ctx: buildCtx(env), port: 0, open: false });
  const port = Number(new URL(live.url).port);
  const key = new URL(live.url).searchParams.get('key')!;
  try {
    const lines: string[] = [];
    // A start that raced another one: the other wrote its file while this one failed to listen.
    const code = await main(['--port', String(port), '--window', 'none'], { ...buildCtx(env), out: (l) => lines.push(l) }, {
      start: async () => {
        writeInstance(fileOf(env), { port, pid: process.pid, key });
        throw Object.assign(new Error(`port ${port} is in use; a cockpit may already be running`), { code: 'EADDRINUSE' });
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(lines, [`Cockpit already running: ${live.url}`]);
  } finally {
    await live.close();
  }
});

test('Host and Origin are validated against the listening port', async () => {
  const { url, close } = await startCockpit({ ctx: buildCtx(sandboxEnv()), port: 0, open: false });
  const key = url.split('key=')[1];
  const port = new URL(url).port;
  // fetch() refuses to override Host, so use node:http.
  const get = (headers: Record<string, string>) =>
    new Promise<{ status: number; json: () => unknown }>((resolve, reject) => {
      httpGet(`http://127.0.0.1:${port}/api/health`, { headers: { 'x-strand-key': key, ...headers }, agent: false }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(body) }));
      }).on('error', reject);
    });
  assert.equal((await get({})).status, 200);
  assert.equal((await get({ host: `localhost:${port}` })).status, 200);
  assert.equal((await get({ origin: `http://localhost:${port}` })).status, 200);
  const badHost = await get({ host: 'evil.example:80' });
  assert.equal(badHost.status, 403);
  assert.deepEqual(badHost.json(), { error: 'forbidden host' });
  const badPort = await get({ host: `127.0.0.1:${Number(port) + 1}` });
  assert.equal(badPort.status, 403);
  const badOrigin = await get({ origin: 'http://127.0.0.1:1' });
  assert.equal(badOrigin.status, 403);
  assert.deepEqual(badOrigin.json(), { error: 'forbidden origin' });
  await close();
});

test('a failing browser opener only prints a hint, including async child errors', async () => {
  for (const opener of [
    () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('spawn xdg-open ENOENT')));
      return child;
    },
    () => Promise.reject(new Error('boom')),
  ]) {
    const errs: string[] = [];
    const ctx = { ...buildCtx(sandboxEnv()), err: (l: string) => errs.push(l) };
    const { close } = await startCockpit({ ctx, port: 0, open: true, window: 'tab', opener });
    await new Promise((r) => setTimeout(r, 20));
    await close();
    assert.deepEqual(errs, ['Could not open a browser. Open the URL above yourself.']);
  }
});

test('a 500 is logged without the query string and replies with a generic body', async () => {
  const errs: string[] = [];
  const ctx = { ...buildCtx(sandboxEnv()), err: (l: string) => errs.push(l) };
  const s = await createServer({
    ctx,
    token: TOKEN,
    allowedHosts: 'any',
    routes: (a) => {
      a.get('/api/boom', async () => {
        throw new Error('kaboom');
      });
    },
  });
  const r = await s.inject({ url: `/api/boom?key=${TOKEN}`, headers: { 'x-strand-key': TOKEN } });
  assert.equal(r.statusCode, 500);
  assert.deepEqual(r.json(), { error: 'internal error' });
  assert.deepEqual(errs, ['cockpit: GET /api/boom failed: kaboom']);
  await s.close();
});

test('Fastify 4xx errors pass through instead of becoming 500', async () => {
  const s = await createServer({
    ctx: buildCtx(sandboxEnv()),
    token: TOKEN,
    allowedHosts: 'any',
    routes: (a) => {
      a.post('/api/echo', async (req) => req.body);
    },
  });
  const h = { 'x-strand-key': TOKEN, 'content-type': 'application/json' };
  const bad = await s.inject({ method: 'POST', url: '/api/echo', headers: h, payload: '{nope' });
  assert.equal(bad.statusCode, 400);
  assert.equal(typeof bad.json().error, 'string');
  const missing = await s.inject({ url: '/api/nothing', headers: h });
  assert.equal(missing.statusCode, 404);
  await s.close();
});

test('Host matching is case-insensitive and a hosts list is enforced (fails closed)', async () => {
  const s = await createServer({ ctx: buildCtx(sandboxEnv()), token: TOKEN, allowedHosts: ['127.0.0.1:1234'] });
  const h = { 'x-strand-key': TOKEN };
  assert.equal((await s.inject({ url: '/api/health', headers: { ...h, host: '127.0.0.1:1234' } })).statusCode, 200);
  assert.equal((await s.inject({ url: '/api/health', headers: { ...h, host: 'LOCALHOST:1234' } })).statusCode, 403);
  const t = await createServer({ ctx: buildCtx(sandboxEnv()), token: TOKEN, allowedHosts: ['localhost:1234'] });
  assert.equal((await t.inject({ url: '/api/health', headers: { ...h, host: 'LocalHost:1234' } })).statusCode, 200);
  const empty = await createServer({ ctx: buildCtx(sandboxEnv()), token: TOKEN, allowedHosts: [] });
  assert.equal((await empty.inject({ url: '/api/health', headers: h })).statusCode, 403);
  await s.close();
  await t.close();
  await empty.close();
});

test('framing is refused: pages, static assets, 401s and API replies carry X-Frame-Options DENY', async () => {
  const ui = mkdtempSync(join(tmpdir(), 'strand-ui-'));
  writeFileSync(join(ui, 'index.html'), '<h1>cockpit ui</h1>');
  writeFileSync(join(ui, 'app.js'), 'console.log(1)');
  const board = { cards: [], wip: { build: 0, review: 0, limits: { build: 3, review: 3 } } };
  const model = { board: async () => board, invalidate: () => {} } as never;
  const s = await createServer({ ctx: buildCtx(sandboxEnv()), token: TOKEN, uiDir: ui, allowedHosts: 'any', model });
  const h = { cookie: `strand_key=${TOKEN}` };
  for (const url of ['/', '/app.js', '/some/client/route']) {
    for (const headers of [h, {}]) {
      const r = await s.inject({ url, headers });
      assert.equal(r.headers['x-frame-options'], 'DENY', url);
      assert.equal(r.headers['content-security-policy'], "frame-ancestors 'none'", url);
    }
  }
  const api = await s.inject({ url: '/api/board', headers: h });
  assert.equal(api.statusCode, 200);
  assert.equal(api.headers['x-frame-options'], 'DENY');
  await s.close();
  const nb = await app(join(tmpdir(), 'strand-no-such-ui-dir'));
  const page = await nb.inject({ url: '/', headers: h });
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['content-security-policy'], "frame-ancestors 'none'");
  await nb.close();
});

test('UI not built: the page and strand cockpit both say exactly how to build it', async () => {
  const hint = `UI not built yet — run: cd "${REPO_ROOT}" && npm run build:ui`;
  assert.equal(uiNotBuiltHint(), hint);
  assert.ok(!REPO_ROOT.endsWith('/') && !REPO_ROOT.endsWith('\\'));
  const s = await app(join(tmpdir(), 'strand-no-such-ui-dir'));
  const r = await s.inject({ url: '/', headers: { cookie: `strand_key=${TOKEN}` } });
  const text = r.body.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  assert.ok(text.includes(hint), r.body);
  await s.close();

  const errs: string[] = [];
  const ctx = { ...buildCtx(sandboxEnv()), err: (l: string) => errs.push(l) };
  const { close } = await startCockpit({ ctx, port: 0, open: false, uiDir: join(tmpdir(), 'strand-no-such-ui-dir') });
  await close();
  assert.deepEqual(errs, [hint]);
  const ui = mkdtempSync(join(tmpdir(), 'strand-ui-'));
  writeFileSync(join(ui, 'index.html'), '<h1>ui</h1>');
  const built = await startCockpit({ ctx, port: 0, open: false, uiDir: ui });
  await built.close();
  assert.equal(errs.length, 1, 'no hint when built');
});

// --- single instance: ping, quit and the key file ---

const cookie = { cookie: `strand_key=${TOKEN}` };

test('GET /api/ping answers this process id, behind the key', async () => {
  const s = await app();
  assert.equal((await s.inject('/api/ping')).statusCode, 401);
  assert.equal((await s.inject({ url: '/api/ping', headers: { cookie: `strand_key=${'b'.repeat(64)}` } })).statusCode, 401);
  const r = await s.inject({ url: '/api/ping', headers: cookie });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { pid: process.pid });
  await s.close();
});

function fakeTerminals(live: number, exited: number) {
  const list = [
    ...Array.from({ length: live }, (_, i) => ({ id: `l${i}`, beadId: 'b', mode: 'work', startedAt: '' })),
    ...Array.from({ length: exited }, (_, i) => ({ id: `e${i}`, beadId: 'b', mode: 'work', startedAt: '', exited: { code: 0, at: '' } })),
  ];
  return { list: () => list, killAll: () => {} } as unknown as Terminals;
}

test('POST /api/quit is behind the key, answers the live terminal count, then quits on a later tick', async () => {
  let quits = 0;
  const s = await createServer({ ctx: buildCtx(sandboxEnv()), token: TOKEN, allowedHosts: 'any', terminals: fakeTerminals(2, 1), onQuit: () => quits++ });
  assert.equal((await s.inject({ method: 'POST', url: '/api/quit' })).statusCode, 401);
  assert.equal((await s.inject({ method: 'GET', url: '/api/quit', headers: cookie })).statusCode, 404);
  assert.equal(quits, 0);
  const r = await s.inject({ method: 'POST', url: '/api/quit', headers: cookie });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ending: 2 });
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
  assert.equal(quits, 1);
  await s.close();
});

test('POST /api/quit ignores any body, JSON or not', async () => {
  let quits = 0;
  const s = await createServer({ ctx: buildCtx(sandboxEnv()), token: TOKEN, allowedHosts: 'any', onQuit: () => quits++ });
  for (const [type, payload] of [
    ['application/json', '{"force":true}'],
    ['application/json', '{nope'],
    ['text/plain', 'hello'],
    ['application/octet-stream', 'x'.repeat(10_000)],
  ]) {
    const r = await s.inject({ method: 'POST', url: '/api/quit', headers: { ...cookie, 'content-type': type! }, payload });
    assert.equal(r.statusCode, 200, `${type} ${r.body}`);
    assert.deepEqual(r.json(), { ending: 0 });
  }
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(quits, 4);
  // Other routes keep refusing non-JSON bodies.
  const other = await s.inject({ method: 'POST', url: '/api/open', headers: { ...cookie, 'content-type': 'text/plain' }, payload: 'x' });
  assert.notEqual(other.statusCode, 200);
  await s.close();
});

test('without an onQuit there is no quit route', async () => {
  const s = await app();
  assert.equal((await s.inject({ method: 'POST', url: '/api/quit', headers: cookie })).statusCode, 404);
  await s.close();
});

function fileOf(env: NodeJS.ProcessEnv): string {
  return instanceFile(env, process.platform, env.HOME!);
}

async function untilLine(lines: string[]): Promise<void> {
  while (lines.length === 0) await new Promise((r) => setTimeout(r, 10));
}

test('a closed console (SIGHUP) stops strand cockpit cleanly; on Windows Ctrl+Break (SIGBREAK) does too', async () => {
  const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGHUP', 'SIGBREAK'] : ['SIGHUP'];
  for (const sig of signals) {
    const env = sandboxEnv();
    const lines: string[] = [];
    const before = process.listenerCount(sig);
    // The abort only ends a server the signal did not stop, so a failing test does not hang.
    const ac = new AbortController();
    const done = main(['--port', '0', '--window', 'none'], { ...buildCtx(env), out: (l) => lines.push(l) }, { signal: ac.signal });
    await untilLine(lines);
    const listened = process.listenerCount(sig);
    process.emit(sig, sig);
    const stopped = await Promise.race([done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
    ac.abort();
    await done;
    assert.equal(listened, before + 1, sig);
    assert.equal(stopped, true, `${sig} stops the server`);
    assert.equal(existsSync(fileOf(env)), false);
    assert.equal(process.listenerCount(sig), before);
  }
});

test('strand cockpit writes the key file while it runs and removes it on abort', async () => {
  const env = sandboxEnv();
  const lines: string[] = [];
  const ctx = { ...buildCtx(env), out: (l: string) => lines.push(l) };
  const ac = new AbortController();
  const done = main(['--port', '0', '--window', 'none'], ctx, { signal: ac.signal });
  await untilLine(lines);
  const url = new URL(lines[0]!.replace(/^Cockpit: /, ''));
  const i = readInstance(fileOf(env));
  assert.deepEqual(i, { port: Number(url.port), pid: process.pid, key: url.searchParams.get('key') });
  ac.abort();
  assert.equal(await done, 0);
  assert.equal(existsSync(fileOf(env)), false);
});

/** A desktop app that records its launches instead of starting. */
function fakeDesktop(app: DesktopApp | undefined = { cmd: '/opt/Strand/strand', args: [] }) {
  const launched: Array<{ cmd: string; args: readonly string[] }> = [];
  const spawn: SpawnDesktop = (cmd, args) => {
    launched.push({ cmd, args });
    return Object.assign(new EventEmitter(), { unref() {} });
  };
  return { launched, deps: { findApp: () => app, spawn, opener: () => assert.fail('no tab while the desktop app exists') } };
}

test('AT-4 a second strand cockpit finds the live server, launches the desktop app with no key and starts nothing', async () => {
  const env = sandboxEnv();
  const first: string[] = [];
  const ac = new AbortController();
  const running = main(['--port', '0', '--window', 'none'], { ...buildCtx(env), out: (l) => first.push(l) }, { signal: ac.signal });
  await untilLine(first);
  const link = first[0]!.replace(/^Cockpit: /, '');
  const before = readFileSync(fileOf(env), 'utf8');
  try {
    const lines: string[] = [];
    const d = fakeDesktop();
    const code = await main(['--window', 'app'], { ...buildCtx(env), out: (l) => lines.push(l) }, {
      start: () => assert.fail('a second server must not start'),
      ...d.deps,
    });
    assert.equal(code, 0);
    const port = new URL(link).port;
    assert.deepEqual(lines, [`Cockpit already running: http://127.0.0.1:${port}/`]);
    assert.deepEqual(d.launched, [{ cmd: '/opt/Strand/strand', args: [] }]);
    assert.equal(readFileSync(fileOf(env), 'utf8'), before, 'the running server and its file are untouched');
    const health = await fetch(new URL('/api/health', link), { headers: { cookie: `strand_key=${new URL(link).searchParams.get('key')}` } });
    assert.equal(health.status, 200);
  } finally {
    ac.abort();
    await running;
  }
});

test('AT-4 strand cockpit in app mode starts the server, prints the link without the key and launches the desktop app', async () => {
  const env = sandboxEnv();
  const lines: string[] = [];
  const ac = new AbortController();
  const d = fakeDesktop({ cmd: '/e/electron', args: [REPO_ROOT] });
  const done = main(['--port', '0', '--window', 'app'], { ...buildCtx(env), out: (l) => lines.push(l) }, { signal: ac.signal, ...d.deps });
  await untilLine(lines);
  const i = readInstance(fileOf(env))!;
  assert.deepEqual(lines, [`Cockpit: http://127.0.0.1:${i.port}/`]);
  assert.deepEqual(d.launched, [{ cmd: '/e/electron', args: [REPO_ROOT] }]);
  ac.abort();
  assert.equal(await done, 0);
});

test('AT-4 with no desktop app, app mode prints the keyed link and opens it in a tab', async () => {
  const env = sandboxEnv();
  const lines: string[] = [];
  const opened: string[] = [];
  const ac = new AbortController();
  const done = main(['--port', '0', '--window', 'app'], { ...buildCtx(env), out: (l) => lines.push(l) }, {
    signal: ac.signal,
    findApp: () => undefined,
    spawn: () => assert.fail('nothing to launch'),
    opener: (u) => void opened.push(u),
  });
  await untilLine(lines);
  const i = readInstance(fileOf(env))!;
  const keyed = `http://127.0.0.1:${i.port}/?key=${i.key}`;
  assert.deepEqual(lines, [`Cockpit: ${keyed}`]);
  assert.deepEqual(opened, [keyed]);
  ac.abort();
  assert.equal(await done, 0);
});

test('a stale or forged key file is replaced by a new server', async () => {
  const env = sandboxEnv();
  const file = fileOf(env);
  // A port nobody listens on any more.
  const gone = await startCockpit({ ctx: buildCtx(env), port: 0, open: false });
  const gonePort = Number(new URL(gone.url).port);
  await gone.close();
  for (const stale of [
    { port: gonePort, pid: process.pid, key: 'e'.repeat(64) },
    'not json at all',
  ]) {
    if (typeof stale === 'string') writeFileSync(file, stale);
    else writeInstance(file, stale);
    const lines: string[] = [];
    const ac = new AbortController();
    const done = main(['--port', '0', '--window', 'none'], { ...buildCtx(env), out: (l) => lines.push(l) }, { signal: ac.signal });
    await untilLine(lines);
    assert.match(lines[0]!, /^Cockpit: http:\/\/127\.0\.0\.1:\d+\/\?key=[0-9a-f]{64}$/);
    const url = new URL(lines[0]!.replace(/^Cockpit: /, ''));
    assert.deepEqual(readInstance(file), { port: Number(url.port), pid: process.pid, key: url.searchParams.get('key') });
    ac.abort();
    assert.equal(await done, 0);
    assert.equal(existsSync(file), false);
  }
});

test('the quit route ends strand cockpit: terminals killed, key file removed, exit 0', async (t) => {
  const killAll = t.mock.method(Terminals.prototype, 'killAll');
  const env = sandboxEnv();
  const lines: string[] = [];
  const done = main(['--port', '0', '--window', 'none'], { ...buildCtx(env), out: (l) => lines.push(l) }, {
    start: (o) => startCockpit({ ...o, loadPty: async () => ({ spawn: () => assert.fail('no spawn') }) }),
  });
  await untilLine(lines);
  const url = new URL(lines[0]!.replace(/^Cockpit: /, ''));
  const r = await fetch(new URL('/api/quit', url), { method: 'POST', headers: { cookie: `strand_key=${url.searchParams.get('key')}` } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ending: 0 });
  assert.equal(await done, 0);
  assert.equal(killAll.mock.callCount(), 1);
  assert.equal(existsSync(fileOf(env)), false);
  await assert.rejects(fetch(new URL('/api/health', url)));
});

test('a failure after the key file is written removes it and stops the server', async () => {
  const env = sandboxEnv();
  const lines: string[] = [];
  let closed = 0;
  await assert.rejects(
    main(['--port', '0', '--window', 'none'], { ...buildCtx(env), out: (l) => {
      lines.push(l);
      throw new Error('stdout is gone');
    } }, {
      start: async (o) => {
        const s = await startCockpit(o);
        return { ...s, close: () => (closed++, s.close()) };
      },
    }),
    /stdout is gone/,
  );
  assert.equal(lines.length, 1);
  assert.equal(closed, 1);
  assert.equal(existsSync(fileOf(env)), false);
});

test('a file naming another pid survives this server stopping', async () => {
  const env = sandboxEnv();
  const lines: string[] = [];
  const ac = new AbortController();
  const done = main(['--port', '0', '--window', 'none'], { ...buildCtx(env), out: (l) => lines.push(l) }, { signal: ac.signal });
  await untilLine(lines);
  // A newer server took over the file meanwhile.
  writeInstance(fileOf(env), { port: 1, pid: process.pid + 1, key: 'f'.repeat(64) });
  ac.abort();
  assert.equal(await done, 0);
  assert.equal(readInstance(fileOf(env))?.pid, process.pid + 1);
});

test('--no-open means none and wins over --window', async () => {
  const env = sandboxEnv();
  const lines: string[] = [];
  const ac = new AbortController();
  const done = main(['--port', '0', '--no-open', '--window', 'app'], { ...buildCtx(env), out: (l) => lines.push(l) }, {
    signal: ac.signal,
    findApp: () => ({ cmd: '/opt/Strand/strand', args: [] }),
    spawn: () => assert.fail('no desktop app'),
    opener: () => assert.fail('no tab'),
  });
  await untilLine(lines);
  ac.abort();
  assert.equal(await done, 0);
});

test('creating the server prints no Fastify deprecation warning', async () => {
  // Fastify prints each deprecation once per process, so check in a fresh one.
  const { spawnSync } = await import('node:child_process');
  const script = [
    "import { buildCtx } from './src/cli/ctx.ts';",
    "import { createServer } from './src/cockpit/server.ts';",
    "const app = await createServer({ ctx: buildCtx(JSON.parse(process.env.CTX_ENV)), token: 'a'.repeat(64), uiDir: '/nonexistent', allowedHosts: 'any' });",
    "await app.ready(); await app.close();",
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO_ROOT,
    env: { ...baseEnv(), CTX_ENV: JSON.stringify(sandboxEnv()) },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /FSTDEP|DeprecationWarning|FastifyWarning/);
});
