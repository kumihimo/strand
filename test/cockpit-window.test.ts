import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import {
  assertCockpitUrl,
  desktopEnv,
  findDesktopApp,
  launchDesktop,
  packagedExecutable,
  type SpawnDesktop,
} from '../src/cockpit/desktop.ts';

const only = (...paths: string[]) => (p: string) => paths.includes(p);

test('packagedExecutable: only for <resources>/app, and the OS layout of electron-builder', () => {
  assert.equal(packagedExecutable('/opt/Strand/resources/app', 'linux'), '/opt/Strand/strand');
  assert.equal(packagedExecutable('C:\\Program Files\\Strand\\resources\\app', 'win32'), 'C:\\Program Files\\Strand\\Strand.exe');
  assert.equal(packagedExecutable('/Applications/Strand.app/Contents/Resources/app', 'darwin'), '/Applications/Strand.app/Contents/MacOS/Strand');
  assert.equal(packagedExecutable('/home/u/code/strand', 'linux'), undefined, 'a source checkout is not packaged');
  assert.equal(packagedExecutable('/opt/x/resources/other', 'linux'), undefined);
});

test('findDesktopApp: the packaged app first, then the dev Electron with the repo as its app, else nothing', () => {
  const packagedRoot = '/opt/Strand/resources/app';
  assert.deepEqual(
    findDesktopApp({ appRoot: packagedRoot, platform: 'linux', exists: only('/opt/Strand/strand'), electronBinary: () => '/e/electron' }),
    { cmd: '/opt/Strand/strand', args: [] },
  );
  const repo = '/home/u/strand';
  // The platform under test is linux, so the path is posix whatever OS runs the test.
  const pkg = path.posix.join(repo, 'package.json');
  assert.deepEqual(
    findDesktopApp({ appRoot: repo, platform: 'linux', exists: only('/e/electron', pkg), electronBinary: () => '/e/electron' }),
    { cmd: '/e/electron', args: [repo] },
  );
  assert.equal(findDesktopApp({ appRoot: repo, platform: 'linux', exists: only(pkg), electronBinary: () => '/e/electron' }), undefined, 'binary not downloaded');
  assert.equal(findDesktopApp({ appRoot: repo, platform: 'linux', exists: () => true, electronBinary: () => undefined }), undefined, 'electron not installed');
});

type Call = { cmd: string; args: readonly string[]; opts: Record<string, unknown>; unref: number };

function fakeSpawn(): { spawn: SpawnDesktop; calls: Call[]; child: EventEmitter } {
  const calls: Call[] = [];
  const child = new EventEmitter();
  const spawn: SpawnDesktop = (cmd, args, opts) => {
    const call: Call = { cmd, args, opts: opts as Record<string, unknown>, unref: 0 };
    calls.push(call);
    return Object.assign(child, { unref: () => void call.unref++ });
  };
  return { spawn, calls, child };
}

test('AT-4 launchDesktop: no shell, detached, ignored stdio, visible, unref, the checked args and no key anywhere', () => {
  const f = fakeSpawn();
  const env = { PATH: '/bin', STRAND_CONFIG_DIR: '/c', ELECTRON_RUN_AS_NODE: '1' };
  launchDesktop({ cmd: '/e/electron', args: ['/home/u/strand'] }, { appRoot: '/home/u/strand', env, spawn: f.spawn });
  assert.deepEqual(f.calls, [
    {
      cmd: '/e/electron',
      args: ['/home/u/strand'],
      opts: { shell: false, detached: true, stdio: 'ignore', windowsHide: false, env: { PATH: '/bin', STRAND_CONFIG_DIR: '/c' } },
      unref: 1,
    },
  ]);
  // A later spawn error must not crash the CLI.
  f.child.emit('error', new Error('spawn ENOENT'));
});

test('AT-4 launchDesktop refuses anything but [] or [appRoot] and an absolute command, before any spawn', () => {
  const root = '/home/u/strand';
  for (const app of [
    { cmd: 'electron', args: [root] },
    { cmd: '/e/electron', args: ['/elsewhere'] },
    { cmd: '/e/electron', args: [root, '--remote-debugging-port=9222'] },
    { cmd: '/e/electron', args: [`--key=${'a'.repeat(64)}`] },
    { cmd: '/e/electron', args: ['http://127.0.0.1:4747/?key=aa'] },
  ]) {
    const f = fakeSpawn();
    assert.throws(() => launchDesktop(app, { appRoot: root, env: {}, spawn: f.spawn }), /desktop app/, JSON.stringify(app));
    assert.equal(f.calls.length, 0);
  }
});

test('desktopEnv drops ELECTRON_* so the app starts as an app, not as Node', () => {
  assert.deepEqual(desktopEnv({ A: '1', ELECTRON_RUN_AS_NODE: '1', electron_enable_logging: 'x' }), { A: '1' });
});

test('assertCockpitUrl accepts the loopback root, with or without one hex key', () => {
  assertCockpitUrl('http://127.0.0.1:5000/');
  assertCockpitUrl(`http://127.0.0.1:5000/?key=${'a'.repeat(64)}`);
});

test('assertCockpitUrl refuses anything else, without repeating the URL', () => {
  const bad = [
    'https://127.0.0.1:4747/',
    'http://localhost:4747/',
    'http://evil.example/',
    'http://127.0.0.1/',
    'http://127.0.0.1:4747/api/quit',
    'http://127.0.0.1:4747/?key=zz',
    'http://127.0.0.1:4747/?key=',
    'http://127.0.0.1:4747/?key=aa&x=1',
    'http://127.0.0.1:4747/?other=aa',
    'http://127.0.0.1:4747/#frag',
    'http://user@127.0.0.1:4747/',
    '--remote-debugging-port=9222',
    'file:///C:/x.html',
    'javascript:alert(1)',
    '',
  ];
  for (const url of bad) {
    assert.throws(() => assertCockpitUrl(url), (e: Error) => /cockpit URL/.test(e.message) && (url === '' || !e.message.includes(url)), url);
  }
});
