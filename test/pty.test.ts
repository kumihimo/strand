import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseEnv } from './fixtures/env.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  Terminals,
  TerminalLimitError,
  TerminalBusyError,
  loadNodePty,
  ensureSpawnHelperExecutable,
  type HelperFs,
  type PtyProcess,
  type SpawnPty,
} from '../src/cockpit/pty.ts';

type Call = { file: string; args: string[]; opts: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number } };

class FakePty implements PtyProcess {
  pid = 1234;
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

function setup(o: { maxSessions?: number; ringBytes?: number; keepExitedMs?: number } = {}) {
  const calls: Call[] = [];
  const ptys: FakePty[] = [];
  let clock = 1_000;
  const spawn: SpawnPty = (file, args, opts) => {
    calls.push({ file, args, opts });
    const p = new FakePty();
    ptys.push(p);
    return p;
  };
  const t = new Terminals({
    spawn,
    nodePath: 'NODE',
    cliPath: 'CLI',
    maxSessions: o.maxSessions ?? 4,
    ringBytes: o.ringBytes,
    keepExitedMs: o.keepExitedMs,
    now: () => clock,
    env: { PATH: 'p' },
  });
  return { t, calls, ptys, tick: (ms: number) => (clock += ms) };
}

const SID = '0123abcd-0123-4abc-8def-0123456789ab';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('command line is built from the mode only; a new session gets a session id made here', () => {
  const { t, calls } = setup();
  t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  t.start({ beadId: 'b-2', cwd: 'C:/r', mode: 'specify' });
  t.start({ beadId: 'b-3', cwd: 'C:/r', mode: 'resume', sessionId: SID });
  const made = [calls[0]!.args[4]!, calls[1]!.args[4]!];
  for (const id of made) assert.match(id, UUID);
  assert.notEqual(made[0], made[1]);
  assert.deepEqual(calls.map((c) => [c.file, c.args]), [
    ['NODE', ['CLI', 'work', 'b-1', '--session-id', made[0]]],
    ['NODE', ['CLI', 'work', 'b-2', '--session-id', made[1], '--specify']],
    ['NODE', ['CLI', 'work', 'b-3', '--resume', SID]],
  ]);
  assert.equal(calls[0]!.opts.cwd, 'C:/r');
  assert.equal(calls[0]!.opts.cols, 80);
  assert.equal(calls[0]!.opts.rows, 24);
  assert.equal(calls[0]!.opts.env.PATH, 'p');
});

test('the child environment drops CLAUDECODE and CLAUDE_CODE_ENTRYPOINT only, in any case', () => {
  const calls: Call[] = [];
  const t = new Terminals({
    spawn: (file, args, opts) => {
      calls.push({ file, args, opts });
      return new FakePty();
    },
    nodePath: 'NODE',
    cliPath: 'CLI',
    maxSessions: 4,
    env: { PATH: 'p', CLAUDECODE: '1', claude_code_entrypoint: 'cli', CLAUDE_CONFIG_DIR: 'C:/cfg', CLAUDE_CODE_SSE_PORT: '9', STRAND_WORKSPACE: 'C:/w' },
  });
  t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  assert.deepEqual(calls[0]!.opts.env, { PATH: 'p', CLAUDE_CONFIG_DIR: 'C:/cfg', CLAUDE_CODE_SSE_PORT: '9', STRAND_WORKSPACE: 'C:/w' });
});

test('start returns info and list/get/liveFor find it', () => {
  const { t } = setup();
  const info = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  assert.equal(info.beadId, 'b-1');
  assert.equal(info.mode, 'work');
  assert.equal(info.exited, undefined);
  assert.ok(!Number.isNaN(Date.parse(info.startedAt)));
  assert.deepEqual(t.list(), [info]);
  assert.deepEqual(t.get(info.id), info);
  assert.deepEqual(t.liveFor('b-1'), info);
  assert.equal(t.get('nope'), undefined);
  assert.equal(t.liveFor('other'), undefined);
});

test('bad ids throw and nothing is spawned', () => {
  const { t, calls } = setup();
  for (const beadId of ['x --resume y', '-rf', '', 'a b', '../x', 'a'.repeat(65)]) {
    assert.throws(() => t.start({ beadId, cwd: 'C:/r', mode: 'work' }), { message: 'invalid bead id' });
  }
  for (const sessionId of ['x y', '--help', 'short', SID + 'a', '-' + 'a'.repeat(35), 'a'.repeat(36), undefined]) {
    assert.throws(() => t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'resume', sessionId }), { message: 'invalid session id' });
  }
  for (const mode of ['', 'shell', 'WORK', undefined] as const) {
    assert.throws(() => t.start({ beadId: 'b-1', cwd: 'C:/r', mode: mode as never }), { message: 'invalid mode' });
  }
  assert.equal(calls.length, 0);
});

test('a session id from the caller is ignored outside resume mode', () => {
  const { t, calls } = setup();
  t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work', sessionId: 'bad id' });
  t.start({ beadId: 'b-2', cwd: 'C:/r', mode: 'specify', sessionId: SID });
  assert.match(calls[0]!.args[4]!, UUID);
  assert.notEqual(calls[1]!.args[4], SID);
  assert.match(calls[1]!.args[4]!, UUID);
});

test('the limit and one live terminal per bead', () => {
  const { t, calls, ptys } = setup({ maxSessions: 2 });
  t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  assert.throws(() => t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' }), TerminalBusyError);
  t.start({ beadId: 'b-2', cwd: 'C:/r', mode: 'work' });
  assert.throws(() => t.start({ beadId: 'b-3', cwd: 'C:/r', mode: 'work' }), TerminalLimitError);
  assert.equal(calls.length, 2);
  // An exited terminal frees its slot and its bead.
  ptys[0]!.exit(0);
  t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  assert.equal(calls.length, 3);
});

test('output reaches an attached listener and the ring; a late attach gets scrollback', () => {
  const { t, ptys } = setup();
  const { id } = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  const got: string[] = [];
  const a = t.attach(id, (c) => got.push(c.toString()), () => {})!;
  assert.equal(a.scrollback.length, 0);
  ptys[0]!.emit('hello ');
  ptys[0]!.emit('wörld');
  assert.deepEqual(got, ['hello ', 'wörld']);
  const late = t.attach(id, () => {}, () => {})!;
  assert.equal(late.scrollback.toString(), 'hello wörld');
});

test('detach stops delivery and is safe to repeat', () => {
  const { t, ptys } = setup();
  const { id } = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  const got: string[] = [];
  const a = t.attach(id, (c) => got.push(c.toString()), () => {})!;
  ptys[0]!.emit('one');
  a.detach();
  a.detach();
  ptys[0]!.emit('two');
  assert.deepEqual(got, ['one']);
});

test('attach to an unknown id is undefined', () => {
  const { t } = setup();
  assert.equal(t.attach('nope', () => {}, () => {}), undefined);
});

test('exit marks the terminal, notifies listeners, then it is dropped after keepExitedMs', () => {
  const { t, ptys, tick } = setup({ keepExitedMs: 600_000 });
  const { id } = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  const codes: number[] = [];
  t.attach(id, () => {}, (c) => codes.push(c));
  ptys[0]!.emit('bye');
  ptys[0]!.exit(3);
  assert.deepEqual(codes, [3]);
  const info = t.get(id)!;
  assert.equal(info.exited?.code, 3);
  assert.ok(info.exited?.at);
  assert.equal(t.liveFor('b-1'), undefined);
  // Scrollback is still served after exit.
  assert.equal(t.attach(id, () => {}, () => {})!.scrollback.toString(), 'bye');
  tick(599_999);
  assert.ok(t.get(id));
  tick(2);
  assert.equal(t.get(id), undefined);
  assert.deepEqual(t.list(), []);
});

test('a listener that attaches after exit is told the code at once, no throw', () => {
  const { t, ptys } = setup();
  const { id } = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  ptys[0]!.exit(7);
  const codes: number[] = [];
  const a = t.attach(id, () => {}, (c) => codes.push(c));
  assert.ok(a);
  assert.deepEqual(codes, [7]);
  a.detach();
});

test('a listener that throws does not stop others or the terminal', (ctx) => {
  ctx.mock.method(console, 'error', () => {});
  const { t, ptys } = setup();
  const { id } = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  const got: string[] = [];
  t.attach(id, () => {
    throw new Error('socket closed');
  }, () => {
    throw new Error('socket closed');
  });
  t.attach(id, (c) => got.push(c.toString()), () => {});
  assert.doesNotThrow(() => ptys[0]!.emit('x'));
  assert.doesNotThrow(() => ptys[0]!.exit(0));
  assert.deepEqual(got, ['x']);
});

test('a listener that throws is detached on the first throw and reported once', (ctx) => {
  const err = ctx.mock.method(console, 'error', () => {});
  const { t, ptys } = setup();
  const { id } = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  let calls = 0;
  t.attach(id, () => {
    calls++;
    throw new Error('socket closed');
  }, () => {});
  ptys[0]!.emit('a');
  ptys[0]!.emit('b');
  ptys[0]!.emit('c');
  assert.equal(calls, 1);
  assert.equal(err.mock.callCount(), 1);
  assert.match(String(err.mock.calls[0]!.arguments[0]), /socket closed/);
});

test('starting a bead again drops its earlier exited entries', () => {
  const { t, ptys } = setup();
  const first = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  t.start({ beadId: 'b-2', cwd: 'C:/r', mode: 'work' });
  ptys[0]!.exit(0);
  ptys[1]!.exit(0);
  const again = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  assert.equal(t.get(first.id), undefined);
  assert.deepEqual(t.list().map((i) => i.id).sort(), [again.id, t.list().find((i) => i.beadId === 'b-2')!.id].sort());
  assert.equal(t.list().length, 2);
});

test('at most 20 exited entries are kept, oldest dropped first', () => {
  const { t, ptys, tick } = setup({ maxSessions: 1 });
  const ids: string[] = [];
  for (let i = 0; i < 25; i++) {
    ids.push(t.start({ beadId: `b-${i}`, cwd: 'C:/r', mode: 'work' }).id);
    tick(10);
    ptys[i]!.exit(0);
    tick(10);
  }
  const listed = t.list().map((i) => i.id);
  assert.equal(listed.length, 20);
  assert.deepEqual(listed.sort(), ids.slice(5).sort());
});

test('a listener detaching from inside the data callback leaves no leak and no skip', () => {
  const { t, ptys } = setup();
  const { id } = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  const got: string[] = [];
  let first: { detach(): void } | undefined;
  first = t.attach(id, () => first?.detach(), () => {});
  t.attach(id, (c) => got.push(c.toString()), () => {});
  ptys[0]!.emit('a');
  ptys[0]!.emit('b');
  assert.deepEqual(got, ['a', 'b']);
});

test('write after exit is false; unknown is false; oversize input throws', () => {
  const { t, ptys } = setup();
  const { id } = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  assert.equal(t.write(id, 'ls\r'), true);
  assert.deepEqual(ptys[0]!.written, ['ls\r']);
  assert.equal(t.write('nope', 'x'), false);
  assert.equal(t.write(id, 'a'.repeat(64 * 1024)), true);
  assert.throws(() => t.write(id, 'a'.repeat(64 * 1024 + 1)));
  ptys[0]!.exit(0);
  assert.equal(t.write(id, 'x'), false);
});

test('resize checks its bounds', () => {
  const { t, ptys } = setup();
  const { id } = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  assert.equal(t.resize(id, 100, 30), true);
  assert.equal(t.resize(id, 2, 1), true);
  assert.equal(t.resize(id, 500, 300), true);
  for (const [c, r] of [[1, 10], [501, 10], [10, 0], [10, 301], [1.5, 10], [NaN, 10]] as const) {
    assert.equal(t.resize(id, c, r), false);
  }
  assert.equal(t.resize('nope', 80, 24), false);
  assert.deepEqual(ptys[0]!.sizes, [[100, 30], [2, 1], [500, 300]]);
  ptys[0]!.exit(0);
  assert.equal(t.resize(id, 80, 24), false);
});

test('kill returns at once and calls kill once; unknown or exited is false', () => {
  const { t, ptys } = setup();
  const { id } = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  assert.equal(t.kill(id), true);
  assert.equal(ptys[0]!.killed, 1);
  // The terminal stays listed until the exit event arrives.
  assert.ok(t.get(id));
  ptys[0]!.exit(-1073741510);
  assert.equal(t.kill(id), false);
  assert.equal(t.kill('nope'), false);
  assert.equal(ptys[0]!.killed, 1);
});

test('typeLine strips control characters and counts live terminals of the bead', () => {
  const { t, ptys } = setup();
  t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  t.start({ beadId: 'b-2', cwd: 'C:/r', mode: 'work' });
  assert.equal(t.typeLine('b-1', 'hello\u0003 world\u007f!'), 1);
  assert.deepEqual(ptys[0]!.written, ['hello world!\r']);
  assert.deepEqual(ptys[1]!.written, []);
  // CR, LF and tab become one space; every other control character, ESC included, is removed.
  assert.equal(t.typeLine('b-2', 'a\r\nb\tc\x1b[31m'), 1);
  assert.deepEqual(ptys[1]!.written, ['a b c[31m\r']);
  assert.throws(() => t.typeLine('b-2', 'a'.repeat(64 * 1024 + 1)));
  assert.equal(t.typeLine('b-2', 'a'.repeat(64 * 1024)), 1);
  assert.equal(t.typeLine('none', 'x'), 0);
  ptys[0]!.exit(0);
  assert.equal(t.typeLine('b-1', 'x'), 0);
});

test('killAll kills every live terminal', () => {
  const { t, ptys } = setup();
  t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  t.start({ beadId: 'b-2', cwd: 'C:/r', mode: 'work' });
  ptys[1]!.exit(0);
  t.killAll();
  assert.equal(ptys[0]!.killed, 1);
  assert.equal(ptys[1]!.killed, 0);
});

test('onEnded reports a terminal once: on exit, or at killAll before the kill', () => {
  const ended: { beadId: string; startedAt: string; sessionId: string }[] = [];
  const ptys: FakePty[] = [];
  const args: string[][] = [];
  const t = new Terminals({
    spawn: (_file, a) => {
      args.push(a);
      const p = new FakePty();
      ptys.push(p);
      return p;
    },
    nodePath: 'NODE',
    cliPath: 'CLI',
    maxSessions: 4,
    now: () => 5_000,
    onEnded: (e) => ended.push(e),
  });
  const a = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  t.start({ beadId: 'b-2', cwd: 'C:/r', mode: 'resume', sessionId: SID });
  ptys[0]!.exit(0);
  // The session id the terminal made and passed to `strand work`.
  assert.deepEqual(ended, [{ beadId: 'b-1', startedAt: a.startedAt, sessionId: args[0]![4] }]);
  assert.match(ended[0]!.sessionId, UUID);
  t.killAll();
  assert.deepEqual(ended[1], { beadId: 'b-2', startedAt: a.startedAt, sessionId: SID });
  assert.equal(ptys[1]!.killed, 1);
  // The exit after the kill is not reported again.
  ptys[1]!.exit(1);
  assert.equal(ended.length, 2);
});

test('onExited follows every exit, after onEnded, also one that comes after killAll reported the end', () => {
  const events: string[] = [];
  const ptys: FakePty[] = [];
  const t = new Terminals({
    spawn: () => {
      const p = new FakePty();
      ptys.push(p);
      return p;
    },
    nodePath: 'NODE',
    cliPath: 'CLI',
    maxSessions: 4,
    onEnded: (e) => events.push(`ended ${e.beadId}`),
    onExited: (e) => events.push(`exited ${e.beadId}`),
  });
  t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  t.start({ beadId: 'b-2', cwd: 'C:/r', mode: 'work' });
  ptys[0]!.exit(0);
  t.killAll();
  assert.deepEqual(events, ['ended b-1', 'exited b-1', 'ended b-2']);
  ptys[1]!.exit(1);
  assert.deepEqual(events, ['ended b-1', 'exited b-1', 'ended b-2', 'exited b-2']);
});

test('a throwing onEnded does not stop the exit', (ctx) => {
  ctx.mock.method(console, 'error', () => {});
  const ptys: FakePty[] = [];
  const t = new Terminals({
    spawn: () => {
      const p = new FakePty();
      ptys.push(p);
      return p;
    },
    nodePath: 'NODE',
    cliPath: 'CLI',
    maxSessions: 4,
    onEnded: () => {
      throw new Error('disk full');
    },
  });
  const { id } = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  ptys[0]!.exit(0);
  assert.equal(t.get(id)?.exited?.code, 0);
});

test('a second kill before the exit asks the process again', () => {
  const { t, ptys } = setup();
  const { id } = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  assert.equal(t.kill(id), true);
  assert.equal(t.kill(id), true);
  assert.equal(ptys[0]!.killed, 2);
});

test('a 10 MB burst stays bounded by the ring', () => {
  const { t, ptys } = setup({ ringBytes: 1024 * 1024 });
  const { id } = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  let delivered = 0;
  t.attach(id, (c) => (delivered += c.length), () => {});
  const chunk = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 160; i++) ptys[0]!.emit(chunk);
  assert.equal(delivered, 160 * 64 * 1024);
  const a = t.attach(id, () => {}, () => {})!;
  assert.equal(a.scrollback.length, 1024 * 1024);
});

test('ids are uuids', () => {
  const { t } = setup();
  const { id } = t.start({ beadId: 'b-1', cwd: 'C:/r', mode: 'work' });
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.notEqual(id, randomUUID());
});

test('loadNodePty never throws', async () => {
  const r = await loadNodePty();
  assert.ok('spawn' in r || ('error' in r && !r.error.includes('\n')));
});

test('real pty runs a node one-liner and exits 0', async (ctx) => {
  const loaded = await loadNodePty();
  if ('error' in loaded) {
    ctx.skip(`node-pty unavailable: ${loaded.error}`);
    return;
  }
  // The manager always runs `<cli> work <id>`, so the real loader is checked with a direct spawn.
  const p = loaded.spawn(process.execPath, ['-e', "console.log('pty-ok')"], {
    cwd: process.cwd(),
    env: baseEnv(),
    cols: 80,
    rows: 24,
  });
  let out = '';
  p.onData((d) => (out += d));
  const code = await new Promise<number>((resolve) => p.onExit((e) => resolve(e.exitCode)));
  // The adapter's kill is a no-op once the child has exited.
  assert.doesNotThrow(() => p.kill());
  assert.match(out, /pty-ok/);
  assert.equal(code, 0);
});

/** A fake file system for spawn-helper: path -> mode, with each chmod recorded. */
function helperFs(modes: Record<string, number>, chmodError?: Error): HelperFs & { chmods: [string, number][] } {
  const chmods: [string, number][] = [];
  return {
    chmods,
    mode: (f) => modes[f],
    chmod: (f, m) => {
      if (chmodError) throw chmodError;
      chmods.push([f, m]);
    },
  };
}

const PTY_DIR = join('nm', 'node-pty');
const PREBUILT = join(PTY_DIR, 'prebuilds', 'darwin-arm64', 'spawn-helper');
const BUILT = join(PTY_DIR, 'build', 'Release', 'spawn-helper');

test('darwin: a spawn-helper without the execute bit gets it, other mode bits kept', () => {
  const fs = helperFs({ [PREBUILT]: 0o100644, [BUILT]: 0o100600 });
  assert.equal(ensureSpawnHelperExecutable('darwin', 'arm64', PTY_DIR, fs), undefined);
  assert.deepEqual(fs.chmods, [
    [BUILT, 0o711],
    [PREBUILT, 0o755],
  ]);
});

test('darwin: an executable or missing spawn-helper gets no chmod; other platforms are never touched', () => {
  const fs = helperFs({ [PREBUILT]: 0o100755 });
  assert.equal(ensureSpawnHelperExecutable('darwin', 'arm64', PTY_DIR, fs), undefined);
  for (const platform of ['linux', 'win32'] as const) {
    assert.equal(ensureSpawnHelperExecutable(platform, 'arm64', PTY_DIR, helperFs({ [PREBUILT]: 0o100644 })), undefined);
  }
  const other = helperFs({ [PREBUILT]: 0o100644 });
  ensureSpawnHelperExecutable('linux', 'arm64', PTY_DIR, other);
  assert.deepEqual(fs.chmods, []);
  assert.deepEqual(other.chmods, []);
});

test('darwin: a failing chmod or stat is a one-line error naming the helper, never a throw', () => {
  const failing = helperFs({ [PREBUILT]: 0o100644 }, new Error('EPERM: operation\nnot permitted'));
  const err = ensureSpawnHelperExecutable('darwin', 'arm64', PTY_DIR, failing);
  assert.ok(err);
  assert.ok(err.includes(PREBUILT), err);
  assert.match(err, /EPERM/);
  assert.equal(err.includes('\n'), false);
  const badStat: HelperFs = {
    mode: () => {
      throw new Error('EACCES');
    },
    chmod: () => {},
  };
  assert.match(ensureSpawnHelperExecutable('darwin', 'arm64', PTY_DIR, badStat) ?? '', /spawn-helper.*EACCES/);
});

test('loadNodePty on darwin makes spawn-helper executable before it returns spawn, and returns the chmod error instead', async (ctx) => {
  const probe = await loadNodePty();
  if ('error' in probe) {
    ctx.skip(`node-pty unavailable: ${probe.error}`);
    return;
  }
  const seen: string[] = [];
  const fs: HelperFs = {
    mode: (f) => (seen.push(f), f.endsWith(join('darwin-x64', 'spawn-helper')) ? 0o100644 : undefined),
    chmod: (f, m) => void seen.push(`chmod ${f} ${m.toString(8)}`),
  };
  const ok = await loadNodePty({ platform: 'darwin', arch: 'x64', fs });
  assert.ok('spawn' in ok);
  assert.ok(seen.some((s) => s.startsWith('chmod ') && s.endsWith(' 755')), seen.join(', '));
  const none = await loadNodePty({ platform: 'darwin', arch: 'x64', fs: helperFs({}, new Error('never called')) });
  assert.ok('spawn' in none, 'no helper found means nothing to fix');
  const refused = await loadNodePty({
    platform: 'darwin',
    arch: 'x64',
    fs: { mode: () => 0o100644, chmod: () => { throw new Error('EROFS: read-only'); } },
  });
  assert.ok('error' in refused);
  assert.match(refused.error, /spawn-helper.*EROFS/);
  assert.equal(refused.error.includes('\n'), false);
});
