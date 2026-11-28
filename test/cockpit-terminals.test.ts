import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { baseEnv } from './fixtures/env.ts';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { buildCtx } from '../src/cli/ctx.ts';
import { createServer } from '../src/cockpit/server.ts';
import { Terminals, type PtyProcess, type SpawnPty } from '../src/cockpit/pty.ts';
import { BdError, type ListedBead } from '../src/core/bd.ts';

const TOKEN = 'e'.repeat(64);
const COOKIE = `strand_key=${TOKEN}`;
const SID = '0123abcd-0123-4abc-8def-0123456789ab';

class FakePty implements PtyProcess {
  pid = 1;
  written: string[] = [];
  sizes: [number, number][] = [];
  killed = 0;
  dataCbs: ((d: string) => void)[] = [];
  exitCbs: ((e: { exitCode: number }) => void)[] = [];
  write(d: string) {
    this.written.push(d);
  }
  resize(c: number, r: number) {
    this.sizes.push([c, r]);
  }
  kill() {
    this.killed++;
  }
  onData(cb: (d: string) => void) {
    this.dataCbs.push(cb);
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb);
  }
  emit(d: string) {
    for (const cb of this.dataCbs) cb(d);
  }
  exit(code: number) {
    for (const cb of this.exitCbs) cb({ exitCode: code });
  }
}

const row = (id: string, labels: string[]): ListedBead => ({
  id, title: id, status: 'open', priority: 2, issue_type: 'task', labels, dependencies: [], acceptance_criteria: '',
});

type Started = { file: string; args: string[]; cwd: string; pty: FakePty };

/** The real manager, counting the listeners it hands out and takes back. */
class RecordingTerminals extends Terminals {
  attaches = 0;
  detaches = 0;
  writeThrows = false;
  attach(id: string, onData: (chunk: Buffer) => void, onExit: (code: number) => void) {
    const a = super.attach(id, onData, onExit);
    if (!a) return a;
    this.attaches++;
    return {
      scrollback: a.scrollback,
      detach: () => {
        this.detaches++;
        a.detach();
      },
    };
  }
  write(id: string, data: string): boolean {
    if (this.writeThrows) throw new Error('boom');
    return super.write(id, data);
  }
}

/** A real server on 127.0.0.1 port 0 over the real Terminals class and a fake spawn. */
async function setup(t: TestContext, o: { maxSessions?: number; unavailable?: string; spawnError?: Error; listError?: Error } = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'strand-term-'));
  mkdirSync(join(ws, 'app'));
  const cfg = join(ws, 'config');
  const env: NodeJS.ProcessEnv = { ...baseEnv(), STRAND_WORKSPACE: ws, XDG_CONFIG_HOME: cfg, APPDATA: cfg, HOME: cfg, USERPROFILE: cfg };
  delete env.STRAND_GITEA_URL;
  delete env.STRAND_GITEA_TOKEN;
  const rows = [row('t-1', ['repo:app']), row('t-2', ['repo:app']), row('t-3', ['repo:app']), row('t-nolabel', []), row('t-gone', ['repo:missing'])];
  const errs: string[] = [];
  const listAll = async () => {
    if (o.listError) throw o.listError;
    return rows;
  };
  const ctx = { ...buildCtx(env), err: (l: string) => errs.push(l), beads: { listAll } as never };
  const started: Started[] = [];
  const spawn: SpawnPty = (file, args, opts) => {
    if (o.spawnError) throw o.spawnError;
    const pty = new FakePty();
    started.push({ file, args, cwd: opts.cwd, pty });
    return pty;
  };
  const terminals = o.unavailable
    ? undefined
    : new RecordingTerminals({ spawn, nodePath: 'NODE', cliPath: 'CLI', maxSessions: o.maxSessions ?? 4, env: { PATH: 'p' } });
  const hosts: string[] = [];
  // A UI folder that does not exist, so unknown paths get Fastify's own 404 on every PC.
  const uiDir = join(ws, 'no-ui');
  const app = await createServer({ ctx, token: TOKEN, uiDir, allowedHosts: hosts, model: { invalidate() {} } as never, terminals, terminalsUnavailable: o.unavailable });
  await app.listen({ host: '127.0.0.1', port: 0 });
  // Close even when an assertion fails, so a failing test cannot keep the process alive.
  t.after(() => app.close());
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  hosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
  const base = `http://127.0.0.1:${port}`;
  const origin = base;
  const H = { cookie: COOKIE, origin };
  const api = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    fetch(base + path, {
      method: init.method ?? 'GET',
      headers: { ...H, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  const start = async (id: string, body: unknown) => api(`/api/beads/${id}/session`, { method: 'POST', body });
  const connections = () => new Promise<number>((res, rej) => app.server.getConnections((e, n) => (e ? rej(e) : res(n))));
  /** Wait until the server holds no more connections than `before`; fail if it keeps more. */
  const settled = async (before: number) => {
    let held = Infinity;
    for (let i = 0; i < 300 && held > before; i++) {
      held = await connections();
      if (held > before) await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(held <= before, `server still holds ${held} connections, had ${before}`);
  };
  return { app, ws, port, base, origin, terminals, started, api, start, errs, connections, settled, rows };
}

/** The first terminal started for t-1, with its fake pty and the recording manager. */
async function startOne(s: Awaited<ReturnType<typeof setup>>) {
  const { terminal } = (await (await s.start('t-1', { mode: 'work' })).json()) as { terminal: { id: string } };
  return { tid: terminal.id, pty: s.started[0]!.pty, term: s.terminals! };
}

type Frame = { binary: boolean; data: Buffer };
type Conn = { sock: WebSocket; frames: Frame[]; closed: Promise<{ code: number; reason: string }> };

/** Open a socket; resolve once open, or with the HTTP status when the upgrade is refused. */
function connect(url: string, headers: Record<string, string>): Promise<Conn | { status: number; upgraded: boolean }> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url, { headers });
    const frames: Frame[] = [];
    let upgraded = false;
    sock.on('upgrade', () => (upgraded = true));
    sock.on('message', (data, binary) => frames.push({ binary, data: Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer) }));
    const closed = new Promise<{ code: number; reason: string }>((r) => sock.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    sock.on('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0, upgraded });
      res.resume();
      sock.terminate();
    });
    sock.on('open', () => resolve({ sock, frames, closed }));
    sock.on('error', (e) => {
      if (!upgraded) reject(e);
    });
  });
}

async function open(s: Awaited<ReturnType<typeof setup>>, tid: string): Promise<Conn> {
  const c = await connect(`ws://127.0.0.1:${s.port}/api/terminals/${tid}/io`, { cookie: COOKIE, origin: s.origin });
  if (!('sock' in c)) throw new Error(`upgrade refused with ${c.status}`);
  return c;
}

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const text = (f: Frame) => f.data.toString('utf8');

test('GET /api/terminals lists terminals and says they are available', async (t) => {
  const s = await setup(t);
  const empty = await s.api('/api/terminals');
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { available: true, terminals: [] });
  assert.equal((await s.start('t-1', { mode: 'work' })).status, 201);
  const list = (await (await s.api('/api/terminals')).json()) as { available: boolean; terminals: { beadId: string; mode: string }[] };
  assert.equal(list.available, true);
  assert.deepEqual(list.terminals.map((t) => [t.beadId, t.mode]), [['t-1', 'work']]);
});

test('POST session: a pty that fails to spawn is 503 with one line of the reason', async (t) => {
  const s = await setup(t, { spawnError: new Error('File not found: \n  conpty.dll') });
  const r = await s.start('t-1', { mode: 'work' });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'could not start the terminal: File not found: conpty.dll' });
  assert.deepEqual((await (await s.api('/api/terminals')).json()).terminals, []);
});

test('POST session: a bd failure while loading the bead is 503 Beads unavailable', async (t) => {
  const s = await setup(t, { listError: new BdError('bd list failed (exit 1): database is locked', 'Error: database is locked\n') });
  const r = await s.start('t-1', { mode: 'work' });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'Beads unavailable: Error: database is locked' });
});

test('POST session starts the fixed command in the bead repo folder for each mode', async (t) => {
  const s = await setup(t);
  const r = await s.start('t-1', { mode: 'work' });
  assert.equal(r.status, 201);
  const body = (await r.json()) as { terminal: { id: string; beadId: string; mode: string; startedAt: string } };
  assert.equal(body.terminal.beadId, 't-1');
  assert.equal(body.terminal.mode, 'work');
  assert.match(body.terminal.id, /^[0-9a-f-]{36}$/);
  assert.equal((await s.start('t-2', { mode: 'specify' })).status, 201);
  assert.equal((await s.start('t-3', { mode: 'resume', sessionId: SID })).status, 201);
  // A new session gets a session id made by the server, never one from the request.
  const made = s.started.slice(0, 2).map((x) => x.args[4]!);
  for (const id of made) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(s.started.map((x) => [x.file, x.args]), [
    ['NODE', ['CLI', 'work', 't-1', '--session-id', made[0]]],
    ['NODE', ['CLI', 'work', 't-2', '--session-id', made[1], '--specify']],
    ['NODE', ['CLI', 'work', 't-3', '--resume', SID]],
  ]);
  for (const x of s.started) assert.equal(x.cwd, join(s.ws, 'app'));
});

test('POST session specify: only a Backlog bead starts; any other stage is 409 and starts nothing', async (t) => {
  const s = await setup(t);
  const ok = await s.start('t-1', { mode: 'specify' });
  assert.equal(ok.status, 201);
  assert.equal(s.started.length, 1);
  // Changed behind the board's back: claimed (specify), approved (build) and closed (done).
  const approved = 'plan-approved 2026-11-01T10:00:00.000Z';
  s.rows.push(
    { ...row('t-spec', ['repo:app']), status: 'in_progress' },
    { ...row('t-build', ['repo:app']), status: 'in_progress', notes: approved },
    { ...row('t-done', ['repo:app']), status: 'closed', notes: approved },
  );
  for (const id of ['t-spec', 't-build', 't-done']) {
    const r = await s.start(id, { mode: 'specify' });
    assert.deepEqual([r.status, await r.json()], [409, { error: `bead ${id} is not in Backlog` }], id);
  }
  assert.equal(s.started.length, 1);
});

test('POST session specify: a held Backlog bead is 409; work and resume are not gated by stage', async (t) => {
  const s = await setup(t);
  s.rows.push(
    { ...row('t-held', ['repo:app']), status: 'blocked' },
    { ...row('t-deferred', ['repo:app']), status: 'deferred' },
    { ...row('t-spec', ['repo:app']), status: 'in_progress' },
  );
  for (const id of ['t-held', 't-deferred']) {
    const r = await s.start(id, { mode: 'specify' });
    assert.deepEqual([r.status, await r.json()], [409, { error: `bead ${id} is on hold` }], id);
  }
  assert.equal(s.started.length, 0);
  assert.equal((await s.start('t-spec', { mode: 'work' })).status, 201);
  assert.equal((await s.start('t-held', { mode: 'resume', sessionId: SID })).status, 201);
});

test('POST session: a live terminal for the bead and the limit are 409', async (t) => {
  const s = await setup(t, { maxSessions: 1 });
  assert.equal((await s.start('t-1', { mode: 'work' })).status, 201);
  const busy = await s.start('t-1', { mode: 'specify' });
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { error: 'this bead already has a live terminal' });
  const full = await s.start('t-2', { mode: 'work' });
  assert.equal(full.status, 409);
  assert.deepEqual(await full.json(), { error: 'terminal limit reached (1)' });
  assert.equal(s.started.length, 1);
});

test('POST session: bad bodies are 400 and nothing starts', async (t) => {
  const s = await setup(t);
  const bad: unknown[] = [
    {}, [], 'work', { mode: 'shell' }, { mode: 5 }, { mode: 'WORK' },
    { mode: 'resume' }, { mode: 'resume', sessionId: 5 }, { mode: 'resume', sessionId: '-x' }, { mode: 'resume', sessionId: `${SID} --x` },
    { mode: 'resume', sessionId: SID.toUpperCase() }, { mode: 'resume', sessionId: `--${SID.slice(2)}` }, { mode: 'resume', sessionId: '-'.repeat(36) },
    { mode: 'work', sessionId: SID }, { mode: 'specify', sessionId: SID }, { mode: 'work', cwd: 'C:/' }, { mode: 'work', args: ['--x'] },
  ];
  for (const body of bad) {
    const r = await s.start('t-1', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof ((await r.json()) as { error: unknown }).error, 'string');
  }
  assert.equal((await s.api('/api/beads/t-1/session', { method: 'POST' })).status, 400, 'no body');
  // An unknown key is never echoed back.
  assert.deepEqual(await (await s.start('t-1', { mode: 'work', '<script>': 1 })).json(), { error: 'unknown field in body' });
  assert.deepEqual(s.started, []);
});

test('POST session: unknown, malformed and smuggled ids, and beads without a repo folder are 404; nothing starts', async (t) => {
  const s = await setup(t);
  const cases: [string, string][] = [
    ['t-nope', 'bead t-nope not found'],
    [encodeURIComponent('t-1 --resume x'), 'bead not found'],
    [encodeURIComponent('--help'), 'bead not found'],
    [encodeURIComponent('t-1;calc'), 'bead not found'],
    ['t-nolabel', 'bead t-nolabel has no repo: label'],
    ['t-gone', `repo folder ${join(s.ws, 'missing')} not found`],
  ];
  for (const [id, error] of cases) {
    const r = await s.start(id, { mode: 'work' });
    assert.equal(r.status, 404, id);
    assert.deepEqual(await r.json(), { error }, id);
  }
  assert.deepEqual(s.started, []);
});

test('DELETE /api/terminals/:tid stops a terminal; an unknown one is 404', async (t) => {
  const s = await setup(t);
  const { terminal } = (await (await s.start('t-1', { mode: 'work' })).json()) as { terminal: { id: string } };
  const r = await s.api(`/api/terminals/${terminal.id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { stopping: true });
  assert.equal(s.started[0]!.pty.killed, 1);
  const missing = await s.api(`/api/terminals/${SID}`, { method: 'DELETE' });
  assert.equal(missing.status, 404);
  assert.equal((await s.api('/api/terminals/x', { method: 'DELETE' })).status, 404);
});

test('terminals unavailable: list says why, session is 503, the socket closes 1008', async (t) => {
  const s = await setup(t, { unavailable: 'node-pty failed to load' });
  const list = await s.api('/api/terminals');
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { available: false, reason: 'node-pty failed to load', terminals: [] });
  const r = await s.start('t-1', { mode: 'work' });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'node-pty failed to load' });
  const c = await open(s, SID);
  assert.equal((await c.closed).code, 1008);
});

test('the socket gets the scrollback as one binary frame, then live output', async (t) => {
  const s = await setup(t);
  const { terminal } = (await (await s.start('t-1', { mode: 'work' })).json()) as { terminal: { id: string } };
  const pty = s.started[0]!.pty;
  pty.emit('hello ');
  pty.emit('world');
  const c = await open(s, terminal.id);
  await until(() => c.frames.length >= 1, 'scrollback');
  assert.equal(c.frames[0]!.binary, true);
  assert.equal(text(c.frames[0]!), 'hello world');
  pty.emit('live');
  await until(() => c.frames.length >= 2, 'live output');
  assert.deepEqual([c.frames[1]!.binary, text(c.frames[1]!)], [true, 'live']);
  c.sock.close();
});

test('input and resize frames reach the terminal', async (t) => {
  const s = await setup(t);
  const { terminal } = (await (await s.start('t-1', { mode: 'work' })).json()) as { terminal: { id: string } };
  const pty = s.started[0]!.pty;
  const c = await open(s, terminal.id);
  c.sock.send(JSON.stringify({ type: 'input', data: 'ls\r' }));
  c.sock.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  await until(() => pty.written.length === 1 && pty.sizes.length === 1, 'input and resize');
  assert.deepEqual(pty.written, ['ls\r']);
  assert.deepEqual(pty.sizes, [[120, 40]]);
  c.sock.close();
});

test('bad frames close the socket with 1003 and write nothing', async (t) => {
  const s = await setup(t);
  const { terminal } = (await (await s.start('t-1', { mode: 'work' })).json()) as { terminal: { id: string } };
  const pty = s.started[0]!.pty;
  const bad: (string | Buffer)[] = [
    'not json', '5', 'null', '[]', '{}', JSON.stringify({ type: 'input' }), JSON.stringify({ type: 'input', data: 5 }),
    JSON.stringify({ type: 'input', data: 'x', extra: 1 }), JSON.stringify({ type: 'resize', cols: 1.5, rows: 10 }),
    JSON.stringify({ type: 'resize', cols: 80, rows: 0 }), JSON.stringify({ type: 'resize', cols: 501, rows: 10 }),
    JSON.stringify({ type: 'resize', cols: '80', rows: 24 }), JSON.stringify({ type: 'exec', data: 'x' }), Buffer.from('ls\r'),
  ];
  for (const frame of bad) {
    const c = await open(s, terminal.id);
    c.sock.send(frame);
    assert.equal((await c.closed).code, 1003, String(frame));
  }
  assert.deepEqual(pty.written, []);
  assert.deepEqual(pty.sizes, []);
});

test('a frame over 64 KB closes the socket with 1009', async (t) => {
  const s = await setup(t);
  const { terminal } = (await (await s.start('t-1', { mode: 'work' })).json()) as { terminal: { id: string } };
  const c = await open(s, terminal.id);
  c.sock.send(JSON.stringify({ type: 'input', data: 'x'.repeat(64 * 1024) }));
  assert.equal((await c.closed).code, 1009);
  assert.deepEqual(s.started[0]!.pty.written, []);
});

test('an unknown terminal closes with 1008 right after open', async (t) => {
  const s = await setup(t);
  for (const tid of [SID, 'x', encodeURIComponent('../t')]) {
    const c = await open(s, tid);
    assert.equal((await c.closed).code, 1008, tid);
    assert.deepEqual(c.frames, []);
  }
});

test('on exit the socket gets an exit frame and closes 1000; a late socket gets scrollback, then exit', async (t) => {
  const s = await setup(t);
  const { terminal } = (await (await s.start('t-1', { mode: 'work' })).json()) as { terminal: { id: string } };
  const pty = s.started[0]!.pty;
  const c = await open(s, terminal.id);
  pty.emit('bye');
  pty.exit(3);
  const closed = await c.closed;
  assert.equal(closed.code, 1000);
  const last = c.frames.at(-1)!;
  assert.equal(last.binary, false);
  assert.deepEqual(JSON.parse(text(last)), { type: 'exit', code: 3 });
  const late = await open(s, terminal.id);
  assert.equal((await late.closed).code, 1000);
  assert.deepEqual(late.frames.map((f) => [f.binary, text(f)]), [[true, 'bye'], [false, '{"type":"exit","code":3}']]);
});

/** Do a WebSocket handshake by hand and return the raw socket, so a test can send frames ws would never send. */
function rawUpgrade(s: Awaited<ReturnType<typeof setup>>, path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: s.port,
      path,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        cookie: COOKIE,
        origin: s.origin,
      },
    });
    req.on('upgrade', (_res, socket) => resolve(socket as Socket));
    req.on('response', (res) => reject(new Error(`upgrade refused with ${res.statusCode}`)));
    req.on('error', reject);
    req.end();
  });
}

test('every socket that goes away is detached exactly once, whatever way it goes; nothing throws', async (t) => {
  const s = await setup(t);
  const errors = t.mock.method(console, 'error', () => {});
  const { tid, pty, term } = await startOne(s);

  // A clean close from the client while output is in flight.
  const a = await open(s, tid);
  pty.emit('x'.repeat(1000));
  a.sock.close();
  assert.equal((await a.closed).code, 1005);
  await until(() => term.detaches === 1, 'detach after a client close');

  // The client drops the connection.
  const b = await open(s, tid);
  pty.emit('x'.repeat(1000));
  b.sock.terminate();
  await b.closed;
  await until(() => term.detaches === 2, 'detach after a client terminate');

  // A protocol error: an unmasked client frame makes ws emit 'error' on the server socket.
  const raw = await rawUpgrade(s, `/api/terminals/${tid}/io`);
  raw.on('error', () => {});
  raw.write(Buffer.from([0x81, 0x01, 0x61]));
  await until(() => term.detaches === 3, 'detach after a socket error');
  raw.destroy();

  for (let i = 0; i < 50; i++) pty.emit('x'.repeat(1000));
  pty.exit(0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(term.attaches, 3);
  assert.equal(term.detaches, 3, 'one detach per socket, no more');
  assert.equal(errors.mock.callCount(), 0, 'the manager never had to drop a broken listener');
  assert.deepEqual(s.errs, []);
  assert.equal((await s.api('/api/terminals')).status, 200);
});

test('a reader that does not drain is closed with 1013, detached once, and the server keeps answering', async (t) => {
  const s = await setup(t);
  const errors = t.mock.method(console, 'error', () => {});
  const { tid, pty, term } = await startOne(s);
  // No message handler: this client never reads what it is sent.
  const sock = new WebSocket(`ws://127.0.0.1:${s.port}/api/terminals/${tid}/io`, { headers: { cookie: COOKIE, origin: s.origin } });
  const closed = new Promise<number>((r) => sock.on('close', (code) => r(code)));
  await new Promise<void>((r, j) => {
    sock.on('open', () => r());
    sock.on('error', j);
  });
  sock.pause();
  try {
    const chunk = 'y'.repeat(64 * 1024);
    const cap = 256 * 1024 * 1024;
    let sent = 0;
    let mid: Promise<Response> | undefined;
    // One chunk per tick, as node-pty delivers output, until the server drops the reader.
    const burst = new Promise<void>((resolve) => {
      const step = () => {
        if (term.detaches > 0 || sent >= cap) return resolve();
        pty.emit(chunk);
        sent += chunk.length;
        // An HTTP request made in the middle of the burst.
        if (sent === 8 * chunk.length) mid = s.api('/api/terminals');
        setImmediate(step);
      };
      step();
    });
    await burst;
    assert.ok(sent < cap, `the server never dropped the reader after ${sent} bytes`);
    assert.ok(mid, 'the request was made during the burst');
    assert.equal((await mid).status, 200);
    assert.equal(term.detaches, 1);

    sock.resume();
    assert.equal(await closed, 1013);
    pty.emit('after');
    assert.equal(term.detaches, 1, 'detached once');
    assert.equal(errors.mock.callCount(), 0);
    assert.deepEqual(s.errs, []);
  } finally {
    sock.terminate();
  }
});

test('at most 8 sockets watch one terminal; the 9th closes 1013 "too many viewers"', async (t) => {
  const s = await setup(t);
  const { tid, term } = await startOne(s);
  const watchers: Conn[] = [];
  for (let i = 0; i < 8; i++) watchers.push(await open(s, tid));
  await until(() => watchers.every((w) => w.frames.length >= 1), 'scrollback for all 8');
  const ninth = await open(s, tid);
  assert.deepEqual(await ninth.closed, { code: 1013, reason: 'too many viewers' });
  assert.equal(term.attaches, 8);
  // A slot comes back when a watcher leaves.
  watchers[0]!.sock.close();
  await until(() => term.detaches === 1, 'detach of the first watcher');
  const again = await open(s, tid);
  await until(() => again.frames.length >= 1, 'scrollback for the replacement');
  assert.equal(term.attaches, 9);
  for (const w of [...watchers.slice(1), again]) w.sock.close();
});

test('a manager that throws on input closes the socket 1011; the server keeps answering', async (t) => {
  const s = await setup(t);
  const { tid, term } = await startOne(s);
  term.writeThrows = true;
  const c = await open(s, tid);
  c.sock.send(JSON.stringify({ type: 'input', data: 'ls\r' }));
  assert.equal((await c.closed).code, 1011);
  assert.deepEqual(s.errs, ['cockpit: terminal input failed: boom']);
  assert.equal(term.detaches, 1);
  assert.equal((await s.api('/api/terminals')).status, 200);
});

test('an authenticated upgrade to a non-WebSocket route is opened then closed at once; an unknown path is 404; no socket is held', async (t) => {
  const s = await setup(t);
  const before = await s.connections();
  const plain = await connect(`ws://127.0.0.1:${s.port}/api/terminals`, { cookie: COOKIE, origin: s.origin });
  assert.ok('sock' in plain);
  assert.equal((await plain.closed).code, 1005);
  assert.deepEqual(plain.frames, []);
  for (const path of ['/api/nope', '/nope']) {
    const r = await connect(`ws://127.0.0.1:${s.port}${path}`, { cookie: COOKIE, origin: s.origin });
    assert.deepEqual(r, { status: 404, upgraded: false }, path);
  }
  await s.settled(before);
});

test('the upgrade is refused before any upgrade: no cookie 401, foreign or missing Origin 403, foreign Host 403', async (t) => {
  const s = await setup(t);
  const { terminal } = (await (await s.start('t-1', { mode: 'work' })).json()) as { terminal: { id: string } };
  s.started[0]!.pty.emit('secret output');
  const url = `ws://127.0.0.1:${s.port}/api/terminals/${terminal.id}/io`;
  const cases: [Record<string, string>, number][] = [
    [{ origin: s.origin }, 401],
    [{ origin: s.origin, cookie: 'strand_key=wrong' }, 401],
    [{ cookie: COOKIE, origin: 'http://evil.test' }, 403],
    [{ cookie: COOKIE, origin: `http://127.0.0.1:${s.port + 1}` }, 403],
    [{ cookie: COOKIE, origin: 'null' }, 403],
    [{ cookie: COOKIE }, 403],
    [{ origin: 'http://evil.test' }, 403],
    [{ cookie: COOKIE, origin: s.origin, host: 'evil.test' }, 403],
  ];
  const before = await s.connections();
  for (const [headers, status] of cases) {
    const r = await connect(url, headers);
    assert.ok(!('sock' in r), JSON.stringify(headers));
    assert.deepEqual(r, { status, upgraded: false }, JSON.stringify(headers));
  }
  // The server drops each refused socket instead of holding it open.
  await s.settled(before);
  assert.equal(s.terminals!.attaches, 0, 'no refused socket reached the terminal');
  // The same socket with the cookie and the cockpit's Origin opens.
  const ok = await open(s, terminal.id);
  await until(() => ok.frames.length >= 1, 'scrollback');
  assert.equal(text(ok.frames[0]!), 'secret output');
  ok.sock.close();
});

test('every terminal HTTP route needs the cookie and the cockpit Origin', async (t) => {
  const s = await setup(t);
  const noCookie = { cookie: '' };
  assert.equal((await s.api('/api/terminals', { headers: noCookie })).status, 401);
  assert.equal((await s.api('/api/beads/t-1/session', { method: 'POST', body: { mode: 'work' }, headers: noCookie })).status, 401);
  assert.equal((await s.api(`/api/terminals/${SID}`, { method: 'DELETE', headers: noCookie })).status, 401);
  assert.equal((await s.api('/api/beads/t-1/session', { method: 'POST', body: { mode: 'work' }, headers: { origin: 'http://evil.test' } })).status, 403);
  assert.deepEqual(s.started, []);
});

test('AT-11 a cockpit terminal finds the tools setup installed off PATH', async () => {
  const { cockpitTerminals } = await import('../src/cli/commands/cockpit.ts');
  const { writeFileSync } = await import('node:fs');
  const ws = mkdtempSync(join(tmpdir(), 'strand-term-tools-'));
  const cfg = join(ws, 'cfg');
  mkdirSync(cfg);
  mkdirSync(join(ws, 'tracker'));
  const but = join(ws, 'gb', 'but');
  writeFileSync(join(cfg, 'config.json'), JSON.stringify({ butPath: but, ghPath: join(cfg, 'tools', 'gh', 'bin', 'gh') }));
  const env = { ...baseEnv(), STRAND_WORKSPACE: ws, STRAND_CONFIG_DIR: cfg, HOME: ws, USERPROFILE: ws, XDG_CONFIG_HOME: join(ws, 'xdg'), APPDATA: join(ws, 'xdg') };
  const ctx = buildCtx(env, { out: () => {}, err: () => {} });
  const envs: NodeJS.ProcessEnv[] = [];
  const spawn: SpawnPty = (_file, _args, opts) => (envs.push(opts.env), new FakePty());
  const { terminals } = cockpitTerminals(ctx, spawn);
  terminals.start({ beadId: 'b-1', cwd: ctx.config.trackerDir, mode: 'work' });
  const sep = process.platform === 'win32' ? ';' : ':';
  const key = Object.keys(envs[0]!).find((k) => k.toUpperCase() === 'PATH')!;
  const dirs = envs[0]![key]!.split(sep);
  assert.equal(dirs[0], join(ws, 'gb'));
  assert.equal(dirs[1], join(cfg, 'tools', 'gh', 'bin'));
  terminals.killAll();
});
