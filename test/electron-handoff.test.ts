import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  READY_TIMEOUT_MS,
  STOP_GRACE_MS,
  StderrTail,
  cockpitOrigin,
  cookieDetails,
  errorPage,
  navigationAllowed,
  parseReady,
  permissionAllowed,
  serverCommand,
  serverEnv,
  userDataDir,
  windowOpenDecision,
} from '../electron/handoff.ts';

const KEY = 'a'.repeat(64);

test('AT-6 parseReady accepts exactly {kind, port, key} with a started or attached kind', () => {
  assert.deepEqual(parseReady({ kind: 'started', port: 4747, key: KEY }), { kind: 'started', port: 4747, key: KEY });
  assert.deepEqual(parseReady({ kind: 'attached', port: 1, key: KEY }), { kind: 'attached', port: 1, key: KEY });
  assert.deepEqual(parseReady({ kind: 'started', port: 65535, key: KEY }), { kind: 'started', port: 65535, key: KEY });
});

test('AT-6 parseReady refuses anything else', () => {
  const bad: unknown[] = [
    undefined, null, 'started', 42, [], {},
    { kind: 'stop', port: 4747, key: KEY },
    { kind: 'started', port: 0, key: KEY },
    { kind: 'started', port: 65536, key: KEY },
    { kind: 'started', port: 47.5, key: KEY },
    { kind: 'started', port: '4747', key: KEY },
    { kind: 'started', port: 4747, key: 'A'.repeat(64) },
    { kind: 'started', port: 4747, key: 'a'.repeat(63) },
    { kind: 'started', port: 4747, key: `${KEY}\n` },
    { kind: 'started', port: 4747 },
    { kind: 'started', port: 4747, key: KEY, url: 'http://evil/' },
  ];
  for (const m of bad) assert.equal(parseReady(m), undefined, JSON.stringify(m));
});

test('the cookie is the server cookie, HttpOnly, SameSite=Strict, for the loopback origin, with no expiry', () => {
  const c = cookieDetails(4747, KEY);
  assert.deepEqual(c, { url: 'http://127.0.0.1:4747/', name: 'strand_key', value: KEY, httpOnly: true, sameSite: 'strict', secure: false });
  assert.equal('expirationDate' in c, false, 'a session cookie: never written to disk');
  assert.equal(cockpitOrigin(4747), 'http://127.0.0.1:4747');
  assert.throws(() => cookieDetails(0, KEY));
  assert.throws(() => cookieDetails(4747, 'nope'));
});

test('AT-7 navigation is allowed only within the server origin', () => {
  assert.equal(navigationAllowed('http://127.0.0.1:4747/', 4747), true);
  assert.equal(navigationAllowed('http://127.0.0.1:4747/epics?x=1#y', 4747), true);
  for (const url of [
    'http://127.0.0.1:4748/',
    'http://localhost:4747/',
    'https://127.0.0.1:4747/',
    'http://example.com/',
    'file:///etc/passwd',
    'data:text/html,hi',
    'javascript:alert(1)',
    'http://127.0.0.1:4747@evil.example/',
    'not a url',
    '',
  ]) {
    assert.equal(navigationAllowed(url, 4747), false, url);
  }
});

test('a window.open never opens a window; only an http(s) link goes to the default browser', () => {
  assert.deepEqual(windowOpenDecision('https://github.com/o/r/pull/1'), { action: 'deny', external: 'https://github.com/o/r/pull/1' });
  assert.deepEqual(windowOpenDecision('http://example.com'), { action: 'deny', external: 'http://example.com/' });
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'vscode://file/x',
    'about:blank',
    'https://user:pw@example.com/',
    'not a url',
    '',
  ]) {
    assert.deepEqual(windowOpenDecision(url), { action: 'deny' }, url);
  }
});

test('an external link never becomes a navigation of the cockpit window', () => {
  assert.equal(navigationAllowed('https://github.com/o/r/pull/1', 4747), false);
  assert.equal(navigationAllowed('http://example.com/', 4747), false);
});

test('AT-7 permissions are denied except clipboard write', () => {
  assert.equal(permissionAllowed('clipboard-sanitized-write'), true);
  for (const p of ['clipboard-read', 'media', 'geolocation', 'notifications', 'openExternal', 'fullscreen', 'unknown', '']) {
    assert.equal(permissionAllowed(p), false, p);
  }
});

test('AT-9 the quit grace period and the ready timeout (the unload prompt is in electron-menu.test.ts)', () => {
  assert.equal(STOP_GRACE_MS, 5000);
  assert.ok(READY_TIMEOUT_MS >= 10_000);
});

test('serverCommand runs the CLI with --ipc and no key, under STRAND_NODE or node from PATH', () => {
  const root = path.join(path.sep, 'opt', 'strand');
  const cli = path.join(root, 'src', 'cli', 'strand.ts');
  assert.deepEqual(serverCommand(root, {}), { cmd: 'node', args: [cli, 'cockpit', '--ipc'] });
  assert.deepEqual(serverCommand(root, { STRAND_NODE: '/usr/local/bin/node24' }), { cmd: '/usr/local/bin/node24', args: [cli, 'cockpit', '--ipc'] });
  assert.deepEqual(serverCommand(root, { STRAND_NODE: '' }), { cmd: 'node', args: [cli, 'cockpit', '--ipc'] });
});

test('serverEnv drops what would make Node behave as Electron or carry Electron flags, and keeps the rest', () => {
  const env = serverEnv({ PATH: '/bin', STRAND_CONFIG_DIR: '/c', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', electron_enable_logging: '1' });
  assert.deepEqual(env, { PATH: '/bin', STRAND_CONFIG_DIR: '/c' });
});

test('userDataDir stays out of the strand config folder on every OS, case-insensitively', () => {
  for (const appData of ['/home/u/.config', 'C:\\Users\\u\\AppData\\Roaming', '/Users/u/Library/Application Support']) {
    const p = userDataDir(appData);
    const name = p.slice(appData.length + 1);
    assert.ok(p.startsWith(appData));
    assert.notEqual(name.toLowerCase(), 'strand');
    assert.doesNotMatch(name, /[\\/]/);
  }
});

test('the error page escapes the reason and the stderr lines', () => {
  const html = errorPage('Strand needs Node 24 on PATH <b>', ['line <script>alert(1)</script>', 'two & three']);
  assert.match(html, /Strand needs Node 24 on PATH &lt;b&gt;/);
  assert.match(html, /line &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /two &amp; three/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">/);
});

test('StderrTail keeps the last lines only, across chunk boundaries', () => {
  const t = new StderrTail(3);
  t.push('a\nb');
  t.push('c\nd\ne\n');
  assert.deepEqual(t.lines(), ['bc', 'd', 'e']);
  const u = new StderrTail(2);
  u.push('only partial');
  assert.deepEqual(u.lines(), ['only partial']);
});

test('StderrTail never keeps a 64-hex run, so a key printed by mistake never reaches the error page', () => {
  const t = new StderrTail(5);
  t.push(`Cockpit: http://127.0.0.1:1/?key=${KEY}\n`);
  assert.deepEqual(t.lines(), ['Cockpit: http://127.0.0.1:1/?key=<redacted>']);
});
