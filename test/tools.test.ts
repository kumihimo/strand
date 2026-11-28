import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { requireTool, ToolMissingError, compareVersions, MINIMUM_VERSIONS, probeTool, probeTools, knownPaths, REQUIRED_TOOLS } from '../src/core/tools.ts';

test('requireTool git resolves a version', async () => {
  const v = await requireTool('git', '2.0.0');
  assert.match(v, /^\d+\.\d+\.\d+$/);
});

test('requireTool rejects when too old', async () => {
  await assert.rejects(requireTool('git', '999.0.0'), (e: unknown) => {
    assert.ok(e instanceof ToolMissingError);
    assert.equal(e.tool, 'git');
    assert.match(e.message, /999\.0\.0/);
    assert.match(e.message, /git/);
    return true;
  });
});

test('requireTool rejects when the executable path is missing', async () => {
  await assert.rejects(
    requireTool('bd', '0.0.1', { path: '/nonexistent/strand-bd' }),
    (e: unknown) => e instanceof ToolMissingError && e.tool === 'bd',
  );
});

test('compareVersions is numeric per component', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('1.9.0', '1.10.0') < 0);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
});

test('MINIMUM_VERSIONS names but 0.23.5', () => {
  assert.equal(MINIMUM_VERSIONS.but, '0.23.5');
});

/** A fake machine: `files` exist, and each maps to the version its `--version` prints (undefined: prints none). */
function machine(files: Record<string, string | undefined>) {
  const ran: string[] = [];
  return {
    ran,
    exists: (p: string) => Object.hasOwn(files, p),
    version: async (exe: string) => {
      ran.push(exe);
      if (!Object.hasOwn(files, exe)) throw new ToolMissingError(exe, 'missing');
      return files[exe];
    },
  };
}

test('MINIMUM_VERSIONS names gh 2.46.0', () => {
  assert.equal(MINIMUM_VERSIONS.gh, '2.46.0');
});

test('AT-1 probeTools gives each tool ok, missing or old against MINIMUM_VERSIONS', async () => {
  const m = machine({
    '/bin/git': '2.45.1',
    '/bin/bd': '1.0.0',
    '/bin/claude': '2.1.300',
    '/bin/gh': '2.46.0',
  });
  const states = await probeTools({ platform: 'linux', env: { PATH: '/bin' }, home: '/home/u', toolsDir: '/cfg/tools', ...m });
  const by = Object.fromEntries(states.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(by).sort(), ['bd', 'but', 'claude', 'gh', 'git']);
  assert.deepEqual(by.git, { name: 'git', status: 'ok', min: MINIMUM_VERSIONS.git, found: '2.45.1', path: '/bin/git', required: true });
  assert.equal(by.bd!.status, 'old');
  assert.equal(by.bd!.found, '1.0.0');
  assert.equal(by.but!.status, 'missing');
  assert.equal(by.but!.found, undefined);
  assert.equal(by.claude!.status, 'ok');
  assert.equal(by.gh!.status, 'ok');
  assert.equal(by.gh!.required, false);
  assert.deepEqual([...REQUIRED_TOOLS].sort(), ['bd', 'but', 'claude', 'git']);
});

test('AT-1 a tool whose --version prints no version is old, not ok', async () => {
  const m = machine({ '/bin/git': undefined });
  const s = await probeTool('git', { platform: 'linux', env: { PATH: '/bin' }, home: '/h', toolsDir: '/t', ...m });
  assert.equal(s.status, 'old');
  assert.equal(s.found, undefined);
});

test('AT-1 the configured path wins over PATH', async () => {
  const m = machine({ '/opt/but': '0.24.0', '/bin/but': '0.1.0' });
  const s = await probeTool('but', { platform: 'linux', env: { PATH: '/bin' }, home: '/h', toolsDir: '/t', configured: { but: '/opt/but' }, ...m });
  assert.equal(s.status, 'ok');
  assert.equal(s.path, '/opt/but');
});

test('AT-2 a tool off PATH is found in its installer folder, with its absolute path', async () => {
  const w = path.win32;
  const cases: [Parameters<typeof probeTool>[0], NodeJS.Platform, string, string][] = [
    ['claude', 'linux', '/home/u/.local/bin/claude', '2.1.300'],
    ['but', 'linux', '/home/u/.local/bin/but', '0.24.0'],
    ['but', 'win32', 'C:\\Program Files\\GitButler\\but.exe', '0.24.0'],
    ['claude', 'win32', w.join('C:\\Users\\u', '.local', 'bin', 'claude.exe'), '2.1.300'],
    ['gh', 'linux', '/cfg/tools/gh/bin/gh', '2.50.0'],
    ['gh', 'win32', w.join('C:\\cfg\\tools', 'gh', 'bin', 'gh.exe'), '2.50.0'],
  ];
  for (const [name, platform, where, v] of cases) {
    const m = machine({ [where]: v });
    const win = platform === 'win32';
    const s = await probeTool(name, {
      platform,
      env: win ? { Path: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' } : { PATH: '/usr/bin' },
      home: win ? 'C:\\Users\\u' : '/home/u',
      toolsDir: win ? 'C:\\cfg\\tools' : '/cfg/tools',
      ...m,
    });
    assert.equal(s.status, 'ok', `${name} on ${platform}`);
    assert.equal(s.path, where, `${name} on ${platform}`);
    assert.ok(knownPaths(name, { platform, home: win ? 'C:\\Users\\u' : '/home/u', toolsDir: win ? 'C:\\cfg\\tools' : '/cfg/tools', env: win ? { ProgramFiles: 'C:\\Program Files' } : {} }).includes(where));
  }
});

test('AT-2 PATH is searched before the known folders', async () => {
  const m = machine({ '/usr/bin/claude': '2.1.300', '/home/u/.local/bin/claude': '2.1.300' });
  const s = await probeTool('claude', { platform: 'linux', env: { PATH: '/usr/bin' }, home: '/home/u', toolsDir: '/t', ...m });
  assert.equal(s.path, '/usr/bin/claude');
});
