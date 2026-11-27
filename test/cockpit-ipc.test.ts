import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseEnv } from './fixtures/env.ts';
import { buildCtx } from '../src/cli/ctx.ts';
import { main, type IpcChannel } from '../src/cli/commands/cockpit.ts';
import { REPO_ROOT } from '../src/cockpit/server.ts';
import { instanceFile, readInstance } from '../src/cockpit/instance.ts';

const STRAND = join(REPO_ROOT, 'src', 'cli', 'strand.ts');

function sandboxEnv(): NodeJS.ProcessEnv {
  const ws = mkdtempSync(join(tmpdir(), 'strand-ipc-'));
  const cfg = join(ws, 'config');
  const env: NodeJS.ProcessEnv = { ...baseEnv(), STRAND_WORKSPACE: ws, XDG_CONFIG_HOME: cfg, APPDATA: cfg, HOME: cfg, USERPROFILE: cfg };
  delete env.STRAND_GITEA_URL;
  delete env.STRAND_GITEA_TOKEN;
  delete env.STRAND_ARTEFACTS_VCS;
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

const fileOf = (env: NodeJS.ProcessEnv) => instanceFile(env, process.platform, env.HOME!);

/** An IPC channel that records what is sent and lets the test play the parent. */
function fakeIpc() {
  const parent = new EventEmitter();
  const sent: unknown[] = [];
  let closed = 0;
  const ipc: IpcChannel = {
    send: (m) => void sent.push(m),
    onMessage: (fn) => void parent.on('message', fn),
    onDisconnect: (fn) => void parent.on('disconnect', fn),
    close: () => void closed++,
  };
  return { ipc, sent, parent, closed: () => closed };
}

const noWindow = { findApp: () => assert.fail('no desktop app from the child'), opener: () => assert.fail('no tab from the child') };

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('AT-5 --ipc starts a server, sends one {started, port, key}, prints no key, and stops on an IPC stop', async () => {
  const env = sandboxEnv();
  const lines: string[] = [];
  const f = fakeIpc();
  const done = main(['--ipc', '--port', '0'], { ...buildCtx(env), out: (l) => lines.push(l) }, { ipc: f.ipc, ...noWindow });
  await until(() => f.sent.length > 0);
  const i = readInstance(fileOf(env))!;
  assert.deepEqual(f.sent, [{ kind: 'started', port: i.port, key: i.key }]);
  assert.deepEqual(lines, [`Cockpit: http://127.0.0.1:${i.port}/`]);
  // Anything but a stop is ignored.
  f.parent.emit('message', { kind: 'quit-now' });
  f.parent.emit('message', 'stop');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(fileOf(env)), 'still running');
  f.parent.emit('message', { kind: 'stop' });
  assert.equal(await done, 0);
  assert.equal(existsSync(fileOf(env)), false);
  assert.equal(f.closed(), 1);
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch(lines.join('\n'), new RegExp(i.key));
});

test('AT-5 --ipc stops when the parent goes away (disconnect)', async () => {
  const env = sandboxEnv();
  const f = fakeIpc();
  const done = main(['--ipc', '--port', '0'], { ...buildCtx(env), out: () => {} }, { ipc: f.ipc, ...noWindow });
  await until(() => f.sent.length > 0);
  f.parent.emit('disconnect');
  assert.equal(await done, 0);
  assert.equal(existsSync(fileOf(env)), false);
});

test('AT-5 --ipc finds a live server, sends one {attached, port, key}, prints no key and starts nothing', async () => {
  const env = sandboxEnv();
  const first: string[] = [];
  const ac = new AbortController();
  const running = main(['--port', '0', '--window', 'none'], { ...buildCtx(env), out: (l) => first.push(l) }, { signal: ac.signal });
  await until(() => first.length > 0);
  try {
    const i = readInstance(fileOf(env))!;
    const lines: string[] = [];
    const f = fakeIpc();
    const code = await main(['--ipc'], { ...buildCtx(env), out: (l) => lines.push(l) }, {
      ipc: f.ipc,
      start: () => assert.fail('a second server must not start'),
      ...noWindow,
    });
    assert.equal(code, 0);
    assert.deepEqual(f.sent, [{ kind: 'attached', port: i.port, key: i.key }]);
    assert.deepEqual(lines, [`Cockpit already running: http://127.0.0.1:${i.port}/`]);
    assert.equal(f.closed(), 1, 'the channel is closed so the child exits');
    assert.deepEqual(readInstance(fileOf(env)), i);
  } finally {
    ac.abort();
    await running;
  }
});

test('--ipc without an IPC channel is refused', async () => {
  await assert.rejects(main(['--ipc'], buildCtx(sandboxEnv()), { ipc: null }), /--ipc needs an IPC channel/);
});

test('AT-5 a real strand cockpit --ipc child: key only over IPC, not on its command line or stdout; exits on stop', async () => {
  const env = sandboxEnv();
  const args = [STRAND, 'cockpit', '--ipc', '--port', '0'];
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], shell: false });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
  child.stderr!.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    const msg = await new Promise<{ kind: string; port: number; key: string }>((resolve, reject) => {
      child.once('message', (m) => resolve(m as never));
      child.once('exit', () => reject(new Error(`exited before ready: ${stderr}`)));
    });
    assert.equal(msg.kind, 'started');
    assert.match(msg.key, /^[0-9a-f]{64}$/);
    assert.equal(args.some((a) => a.includes(msg.key)), false);
    const r = await fetch(`http://127.0.0.1:${msg.port}/api/ping`, { headers: { cookie: `strand_key=${msg.key}` } });
    assert.equal(r.status, 200);
    child.send({ kind: 'stop' });
    assert.equal(await exited, 0, stderr);
    assert.doesNotMatch(stdout + stderr, new RegExp(msg.key));
    assert.match(stdout, new RegExp(`^Cockpit: http://127\\.0\\.0\\.1:${msg.port}/$`, 'm'));
    assert.equal(existsSync(fileOf(env)), false);
  } finally {
    child.kill();
  }
});
