import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseEnv } from './fixtures/env.ts';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCtx } from '../src/cli/ctx.ts';
import { createServer } from '../src/cockpit/server.ts';
import { instanceFile, probeInstance, readInstance, removeInstance, writeInstance } from '../src/cockpit/instance.ts';

const KEY = 'c'.repeat(64);

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'strand-instance-')), 'strand', 'cockpit.json');
}

/** A plain HTTP server on port 0 whose /api/ping answer the test chooses. */
async function fakeServer(answer: (cookie: string | undefined) => { status: number; body: unknown } | 'hang'): Promise<{ port: number; server: Server; seen: Array<Record<string, unknown>> }> {
  const seen: Array<Record<string, unknown>> = [];
  const server = createHttpServer((req, res) => {
    seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie, host: req.headers.host });
    const a = answer(req.headers.cookie);
    if (a === 'hang') return;
    res.writeHead(a.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(a.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  return { port: typeof addr === 'object' && addr ? addr.port : 0, server, seen };
}

function closeServer(s: Server): Promise<void> {
  s.closeAllConnections();
  return new Promise((r) => s.close(() => r()));
}

test('instanceFile sits beside config.json on every platform', () => {
  assert.equal(instanceFile({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Roaming\\strand\\cockpit.json');
  assert.equal(instanceFile({}, 'darwin', '/Users/u'), '/Users/u/Library/Application Support/strand/cockpit.json');
  assert.equal(instanceFile({ XDG_CONFIG_HOME: '/x' }, 'linux', '/home/u'), '/x/strand/cockpit.json');
  assert.equal(instanceFile({}, 'linux', '/home/u'), '/home/u/.config/strand/cockpit.json');
});

test('writeInstance and readInstance round trip, creating the folder', () => {
  const file = tempFile();
  writeInstance(file, { port: 4747, pid: 1234, key: KEY });
  assert.deepEqual(readInstance(file), { port: 4747, pid: 1234, key: KEY });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { port: 4747, pid: 1234, key: KEY });
  writeInstance(file, { port: 5000, pid: 99, key: KEY });
  assert.deepEqual(readInstance(file), { port: 5000, pid: 99, key: KEY });
});

test('writeInstance makes the file readable by the user only on POSIX', { skip: process.platform === 'win32' ? 'POSIX modes only' : false }, () => {
  const file = tempFile();
  writeInstance(file, { port: 4747, pid: 1234, key: KEY });
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('readInstance is undefined for a missing or malformed file', () => {
  const file = tempFile();
  assert.equal(readInstance(file), undefined);
  writeInstance(file, { port: 1, pid: 1, key: KEY });
  const bad: unknown[] = [
    'not json',
    'null',
    '[]',
    {},
    { port: 4747, pid: 1 },
    { port: '4747', pid: 1, key: KEY },
    { port: '80@evil.example', pid: 1, key: KEY },
    { port: 0, pid: 1, key: KEY },
    { port: 65536, pid: 1, key: KEY },
    { port: 47.5, pid: 1, key: KEY },
    { port: 4747, pid: 0, key: KEY },
    { port: 4747, pid: -5, key: KEY },
    { port: 4747, pid: 1.5, key: KEY },
    { port: 4747, pid: 1, key: 'short' },
    { port: 4747, pid: 1, key: 'Z'.repeat(64) },
    { port: 4747, pid: 1, key: `${'a'.repeat(63)}\n` },
  ];
  for (const b of bad) {
    writeFileSync(file, typeof b === 'string' ? b : JSON.stringify(b));
    assert.equal(readInstance(file), undefined, JSON.stringify(b));
  }
});

test('removeInstance removes only a file that still names this pid', () => {
  const file = tempFile();
  writeInstance(file, { port: 4747, pid: 222, key: KEY });
  removeInstance(file, 111);
  assert.ok(existsSync(file), 'a newer server keeps its file');
  removeInstance(file, 222);
  assert.ok(!existsSync(file));
  removeInstance(file, 222);
  writeFileSync(file, 'garbage');
  removeInstance(file, 222);
  assert.ok(existsSync(file), 'an unreadable file names no pid');
});

test('probeInstance is true for a live pid whose port answers ping with the same pid, sent as the key cookie', async () => {
  const f = await fakeServer((cookie) => (cookie === `strand_key=${KEY}` ? { status: 200, body: { pid: process.pid } } : { status: 401, body: {} }));
  try {
    assert.equal(await probeInstance({ port: f.port, pid: process.pid, key: KEY }), true);
    assert.deepEqual(f.seen, [{ method: 'GET', url: '/api/ping', cookie: `strand_key=${KEY}`, host: `127.0.0.1:${f.port}` }]);
  } finally {
    await closeServer(f.server);
  }
});

test('probeInstance is false when the ping names another pid (pid reused or a different server)', async () => {
  const f = await fakeServer(() => ({ status: 200, body: { pid: process.pid + 1 } }));
  try {
    assert.equal(await probeInstance({ port: f.port, pid: process.pid, key: KEY }), false);
  } finally {
    await closeServer(f.server);
  }
});

test('probeInstance is false for a wrong key (401) and for a body without a pid', async () => {
  for (const answer of [{ status: 401, body: { error: 'unauthorized' } }, { status: 200, body: { ok: true } }, { status: 200, body: 'x' }]) {
    const f = await fakeServer(() => answer);
    try {
      assert.equal(await probeInstance({ port: f.port, pid: process.pid, key: KEY }), false, JSON.stringify(answer));
    } finally {
      await closeServer(f.server);
    }
  }
});

test('probeInstance is false for a dead pid and asks no port', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise((r) => child.once('exit', r));
  let fetched = 0;
  const fetchFn = (async () => {
    fetched++;
    return new Response(JSON.stringify({ pid }), { status: 200 });
  }) as typeof fetch;
  assert.equal(await probeInstance({ port: 4747, pid, key: KEY }, fetchFn), false);
  assert.equal(fetched, 0);
});

test('probeInstance is false when nothing listens on the port', async () => {
  const f = await fakeServer(() => ({ status: 200, body: {} }));
  const port = f.port;
  await closeServer(f.server);
  assert.equal(await probeInstance({ port, pid: process.pid, key: KEY }), false);
});

test('probeInstance gives up after 1.5 s when the port never answers', async () => {
  const f = await fakeServer(() => 'hang');
  try {
    const t0 = Date.now();
    assert.equal(await probeInstance({ port: f.port, pid: process.pid, key: KEY }), false);
    const took = Date.now() - t0;
    assert.ok(took >= 1400 && took < 3000, `took ${took} ms`);
  } finally {
    await closeServer(f.server);
  }
});

test('probeInstance refuses a malformed instance without fetching', async () => {
  let fetched = 0;
  const fetchFn = (async () => {
    fetched++;
    return new Response('{}');
  }) as typeof fetch;
  for (const i of [
    { port: '80@evil.example' as unknown as number, pid: process.pid, key: KEY },
    { port: 0, pid: process.pid, key: KEY },
    { port: 4747, pid: 0, key: KEY },
    { port: 4747, pid: process.pid, key: 'x; other=1' },
  ]) {
    assert.equal(await probeInstance(i, fetchFn), false, JSON.stringify(i));
  }
  assert.equal(fetched, 0);
});

test('probeInstance is true against a real cockpit server with the right key, false with another', async () => {
  const s = await createServer({ ctx: buildCtx(sandboxEnv()), token: KEY, allowedHosts: 'any' });
  await s.listen({ host: '127.0.0.1', port: 0 });
  const addr = s.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    assert.equal(await probeInstance({ port, pid: process.pid, key: KEY }), true);
    assert.equal(await probeInstance({ port, pid: process.pid, key: 'd'.repeat(64) }), false);
  } finally {
    await s.close();
  }
});

function sandboxEnv(): NodeJS.ProcessEnv {
  const ws = mkdtempSync(join(tmpdir(), 'strand-'));
  const cfg = join(ws, 'config');
  const env: NodeJS.ProcessEnv = { ...baseEnv(), STRAND_WORKSPACE: ws, XDG_CONFIG_HOME: cfg, APPDATA: cfg, HOME: cfg, USERPROFILE: cfg };
  delete env.STRAND_GITEA_URL;
  delete env.STRAND_GITEA_TOKEN;
  return env;
}
