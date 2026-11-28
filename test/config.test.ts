import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { homedir } from 'node:os';
import { addToolDirs, applyLegacyEnv, configPath, homeDir, legacyConfigPath, loadConfig, resetLegacyEnvWarning, saveConfig, toolsDir } from '../src/core/config.ts';
import { getGiteaToken } from '../src/core/secrets.ts';
import { instanceFile } from '../src/cockpit/instance.ts';

test('homeDir follows the env: USERPROFILE then HOME on win32, HOME elsewhere, else the OS home', () => {
  assert.equal(homeDir({ USERPROFILE: 'C:\\Users\\k', HOME: '/h' }, 'win32'), 'C:\\Users\\k');
  assert.equal(homeDir({ USERPROFILE: '', HOME: '/h' }, 'win32'), '/h');
  assert.equal(homeDir({ USERPROFILE: 'C:\\Users\\k', HOME: '/h' }, 'linux'), '/h');
  assert.equal(homeDir({}, 'linux'), homedir());
});

test('configPath per platform', () => {
  assert.equal(
    configPath('win32', { APPDATA: 'C:\\Users\\k\\AppData\\Roaming' }, 'C:\\Users\\k'),
    'C:\\Users\\k\\AppData\\Roaming\\strand\\config.json',
  );
  assert.equal(configPath('darwin', {}, '/Users/k'), '/Users/k/Library/Application Support/strand/config.json');
  assert.equal(configPath('linux', { XDG_CONFIG_HOME: '/x' }, '/home/k'), '/x/strand/config.json');
  assert.equal(configPath('linux', {}, '/home/k'), '/home/k/.config/strand/config.json');
});

test('STRAND_CONFIG_DIR overrides the config folder on every platform, and the key file follows it', () => {
  const win = { STRAND_CONFIG_DIR: 'D:\\demo\\.config', APPDATA: 'C:\\Users\\k\\AppData\\Roaming' };
  assert.equal(configPath('win32', win, 'C:\\Users\\k'), 'D:\\demo\\.config\\config.json');
  assert.equal(instanceFile(win, 'win32', 'C:\\Users\\k'), 'D:\\demo\\.config\\cockpit.json');
  assert.equal(configPath('darwin', { STRAND_CONFIG_DIR: '/demo/cfg' }, '/Users/k'), '/demo/cfg/config.json');
  const linux = { STRAND_CONFIG_DIR: '/demo/cfg', XDG_CONFIG_HOME: '/x' };
  assert.equal(configPath('linux', linux, '/home/k'), '/demo/cfg/config.json');
  assert.equal(instanceFile(linux, 'linux', '/home/k'), '/demo/cfg/cockpit.json');
});

test('a relative STRAND_CONFIG_DIR is ignored with one warning line', (t) => {
  const err = t.mock.method(console, 'error', () => {});
  const env = { STRAND_CONFIG_DIR: 'rel-cfg-test', XDG_CONFIG_HOME: '/x' };
  assert.equal(configPath('linux', env, '/home/k'), '/x/strand/config.json');
  assert.equal(configPath('linux', env, '/home/k'), '/x/strand/config.json');
  assert.equal(configPath('win32', { STRAND_CONFIG_DIR: 'rel-cfg-test', APPDATA: 'C:\\A' }, 'C:\\Users\\k'), 'C:\\A\\strand\\config.json');
  assert.equal(err.mock.callCount(), 1);
  assert.equal(err.mock.calls[0]!.arguments[0], 'warning: STRAND_CONFIG_DIR rel-cfg-test is not an absolute path; ignored');
});

test('loadConfig defaults on win32 with no file', () => {
  const home = mkdtempSync(join(tmpdir(), 'strand-cfg-'));
  try {
    const cfg = loadConfig({ platform: 'win32', env: { APPDATA: join(home, 'nope') }, home });
    assert.equal(cfg.workspaceRoot, 'C:\\dev');
    assert.equal(cfg.trackerDir, 'C:\\dev\\tracker');
    assert.equal(cfg.docsRepo, 'C:\\dev\\docs');
    assert.deepEqual(cfg.wip, { build: 3, review: 3, mode: 'warn' });
    assert.equal(cfg.artefactsVcs, 'none');
    assert.equal(cfg.branchPrefix, undefined);
    assert.equal(cfg.claudePath, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadConfig defaults on linux use <home>/dev', () => {
  const home = mkdtempSync(join(tmpdir(), 'strand-cfg-'));
  try {
    const cfg = loadConfig({ platform: 'linux', env: {}, home });
    assert.equal(cfg.workspaceRoot, `${home}/dev`);
    assert.equal(cfg.trackerDir, `${home}/dev/tracker`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('file merges over defaults, wip partially', () => {
  const home = mkdtempSync(join(tmpdir(), 'strand-cfg-'));
  try {
    const env = { XDG_CONFIG_HOME: join(home, 'xdg') };
    const p = configPath('linux', env, home);
    mkdirSync(join(home, 'xdg', 'strand'), { recursive: true });
    writeFileSync(p, JSON.stringify({ wip: { review: 2 } }));
    const cfg = loadConfig({ platform: 'linux', env, home });
    assert.deepEqual(cfg.wip, { build: 3, review: 2, mode: 'warn' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('env overrides beat file and derive paths', () => {
  const home = mkdtempSync(join(tmpdir(), 'strand-cfg-'));
  try {
    const xdg = join(home, 'xdg');
    mkdirSync(join(xdg, 'strand'), { recursive: true });
    writeFileSync(
      configPath('linux', { XDG_CONFIG_HOME: xdg }, home),
      JSON.stringify({ workspaceRoot: '/from/file', giteaUrl: 'http://file' }),
    );
    const cfg = loadConfig({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: xdg, STRAND_WORKSPACE: '/ws', STRAND_GITEA_URL: 'http://env' },
      home,
    });
    assert.equal(cfg.workspaceRoot, '/ws');
    assert.equal(cfg.trackerDir, '/ws/tracker');
    assert.equal(cfg.docsRepo, '/ws/docs');
    assert.equal(cfg.giteaUrl, 'http://env');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('explicit trackerDir/docsRepo in file are kept', () => {
  const home = mkdtempSync(join(tmpdir(), 'strand-cfg-'));
  try {
    const env = { XDG_CONFIG_HOME: join(home, 'xdg') };
    mkdirSync(join(home, 'xdg', 'strand'), { recursive: true });
    writeFileSync(
      configPath('linux', env, home),
      JSON.stringify({ trackerDir: '/t', docsRepo: '/d' }),
    );
    const cfg = loadConfig({ platform: 'linux', env, home });
    assert.equal(cfg.trackerDir, '/t');
    assert.equal(cfg.docsRepo, '/d');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('saveConfig round-trips via temp dir', () => {
  const home = mkdtempSync(join(tmpdir(), 'strand-cfg-'));
  try {
    const opts = { platform: 'linux' as const, env: { XDG_CONFIG_HOME: join(home, 'xdg') }, home };
    const cfg = { workspaceRoot: '/w', trackerDir: '/w/t', docsRepo: '/w/d', giteaUrl: 'http://g', wip: { build: 5, review: 1, mode: 'refuse' as const }, artefactsVcs: 'git-lfs' as const, branchPrefix: 'ada', claudePath: '/c/claude', claudeModel: 'sonnet', claudeEffort: 'low', cockpit: { window: 'tab' as const, maxSessions: 2 } };
    saveConfig(cfg, opts);
    assert.ok(readFileSync(configPath('linux', opts.env, home), 'utf8').includes('\n'));
    assert.deepEqual(loadConfig(opts), cfg);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('malformed config throws naming the path', () => {
  const home = mkdtempSync(join(tmpdir(), 'strand-cfg-'));
  try {
    const env = { XDG_CONFIG_HOME: join(home, 'xdg') };
    const p = configPath('linux', env, home);
    mkdirSync(join(home, 'xdg', 'strand'), { recursive: true });
    writeFileSync(p, '{ not json');
    assert.throws(() => loadConfig({ platform: 'linux', env, home }), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.ok(e.message.includes(p));
      return true;
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('getGiteaToken returns env var when set', () => {
  const prev = process.env.STRAND_GITEA_TOKEN;
  process.env.STRAND_GITEA_TOKEN = 'tok-123';
  try {
    assert.equal(getGiteaToken(), 'tok-123');
  } finally {
    if (prev === undefined) delete process.env.STRAND_GITEA_TOKEN;
    else process.env.STRAND_GITEA_TOKEN = prev;
  }
});

test('without an explicit home, the home folder comes from env (HOME, or USERPROFILE on win32)', () => {
  const home = mkdtempSync(join(tmpdir(), 'strand-cfg-'));
  try {
    const darwin = { HOME: home };
    mkdirSync(join(home, 'Library', 'Application Support', 'strand'), { recursive: true });
    writeFileSync(configPath('darwin', darwin, home), JSON.stringify({ workspaceRoot: '/from/mac' }));
    assert.equal(loadConfig({ platform: 'darwin', env: darwin }).workspaceRoot, '/from/mac');
    // win32 without APPDATA falls back to <USERPROFILE>\AppData\Roaming.
    assert.equal(loadConfig({ platform: 'win32', env: { USERPROFILE: home } }).workspaceRoot, 'C:\\dev');
    const linux = { HOME: home };
    assert.equal(loadConfig({ platform: 'linux', env: linux }).workspaceRoot, `${home}/dev`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('artefactsVcs comes from the file, STRAND_ARTEFACTS_VCS overrides it, bad values are rejected', () => {
  const home = mkdtempSync(join(tmpdir(), 'strand-cfg-'));
  try {
    const env = { XDG_CONFIG_HOME: join(home, 'xdg') };
    mkdirSync(join(home, 'xdg', 'strand'), { recursive: true });
    writeFileSync(configPath('linux', env, home), JSON.stringify({ artefactsVcs: 'git' }));
    assert.equal(loadConfig({ platform: 'linux', env, home }).artefactsVcs, 'git');
    assert.equal(loadConfig({ platform: 'linux', env: { ...env, STRAND_ARTEFACTS_VCS: 'none' }, home }).artefactsVcs, 'none');
    assert.throws(() => loadConfig({ platform: 'linux', env: { ...env, STRAND_ARTEFACTS_VCS: 'svn' }, home }), /artefactsVcs.*none, git, git-lfs/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cockpit settings default, come from the file, env overrides, bad values throw', () => {
  const home = mkdtempSync(join(tmpdir(), 'strand-cfg-'));
  try {
    const env = { XDG_CONFIG_HOME: join(home, 'xdg') };
    assert.deepEqual(loadConfig({ platform: 'linux', env, home }).cockpit, { window: 'app', maxSessions: 4 });
    mkdirSync(join(home, 'xdg', 'strand'), { recursive: true });
    const file = configPath('linux', env, home);
    // browserPath went with the Chromium app window (ADR 0022): an old file that still has it loads, without it.
    writeFileSync(file, JSON.stringify({ cockpit: { window: 'tab', browserPath: '/f/chrome', maxSessions: 2 } }));
    assert.deepEqual(loadConfig({ platform: 'linux', env, home }).cockpit, { window: 'tab', maxSessions: 2 });
    const overridden = loadConfig({
      platform: 'linux',
      env: { ...env, STRAND_COCKPIT_WINDOW: 'none', STRAND_COCKPIT_BROWSER: '/e/chrome', STRAND_COCKPIT_MAX_SESSIONS: '6' },
      home,
    });
    assert.deepEqual(overridden.cockpit, { window: 'none', maxSessions: 6 });
    assert.throws(() => loadConfig({ platform: 'linux', env: { ...env, STRAND_COCKPIT_WINDOW: 'popup' }, home }), /cockpit\.window.*app, tab, none/);
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      assert.throws(() => loadConfig({ platform: 'linux', env: { ...env, STRAND_COCKPIT_MAX_SESSIONS: bad }, home }), /cockpit\.maxSessions/);
    }
    writeFileSync(file, JSON.stringify({ cockpit: { window: 'nope' } }));
    assert.throws(() => loadConfig({ platform: 'linux', env, home }), /cockpit\.window.*app, tab, none/);
    writeFileSync(file, JSON.stringify({ cockpit: { maxSessions: 0 } }));
    assert.throws(() => loadConfig({ platform: 'linux', env, home }), /cockpit\.maxSessions/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function claudeCfg(file: object | undefined, env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'strand-cfg-'));
  try {
    const base = { XDG_CONFIG_HOME: join(home, 'xdg') };
    if (file) {
      mkdirSync(join(home, 'xdg', 'strand'), { recursive: true });
      writeFileSync(configPath('linux', base, home), JSON.stringify(file));
    }
    return loadConfig({ platform: 'linux', env: { ...base, ...env }, home });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('claudeModel and claudeEffort default to opus and high, also for a file without the keys', (t) => {
  const err = t.mock.method(console, 'error', () => {});
  const none = claudeCfg(undefined);
  assert.equal(none.claudeModel, 'opus');
  assert.equal(none.claudeEffort, 'high');
  const old = claudeCfg({ branchPrefix: 'a' });
  assert.equal(old.claudeModel, 'opus');
  assert.equal(old.claudeEffort, 'high');
  assert.equal(err.mock.callCount(), 0);
});

test('claudeModel and claudeEffort come from the file; env overrides', (t) => {
  const err = t.mock.method(console, 'error', () => {});
  const fromFile = claudeCfg({ claudeModel: 'sonnet', claudeEffort: 'max' });
  assert.equal(fromFile.claudeModel, 'sonnet');
  assert.equal(fromFile.claudeEffort, 'max');
  const env = claudeCfg({ claudeModel: 'sonnet', claudeEffort: 'max' }, { STRAND_CLAUDE_MODEL: 'claude-opus-4-1[1m]', STRAND_CLAUDE_EFFORT: 'xhigh' });
  assert.equal(env.claudeModel, 'claude-opus-4-1[1m]');
  assert.equal(env.claudeEffort, 'xhigh');
  for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(claudeCfg(undefined, { STRAND_CLAUDE_EFFORT: e }).claudeEffort, e);
  assert.equal(err.mock.callCount(), 0);
});

test('the value default is kept, so work passes no flag', () => {
  const cfg = claudeCfg({ claudeModel: 'default' }, { STRAND_CLAUDE_EFFORT: 'default' });
  assert.equal(cfg.claudeModel, 'default');
  assert.equal(cfg.claudeEffort, 'default');
});

test('an invalid claudeModel falls back to opus with one warning line', (t) => {
  const err = t.mock.method(console, 'error', () => {});
  assert.equal(claudeCfg(undefined, { STRAND_CLAUDE_MODEL: 'bad model; rm' }).claudeModel, 'opus');
  assert.equal(err.mock.callCount(), 1);
  assert.equal(err.mock.calls[0]!.arguments[0], 'warning: STRAND_CLAUDE_MODEL "bad model; rm" is not a valid model name; using opus');
  assert.equal(claudeCfg({ claudeModel: '-sonnet-file' }).claudeModel, 'opus');
  assert.equal(err.mock.callCount(), 2);
  assert.match(String(err.mock.calls[1]!.arguments[0]), /^warning: claudeModel "-sonnet-file" in .*config\.json is not a valid model name; using opus$/);
  assert.equal(claudeCfg({ claudeModel: 7 }).claudeModel, 'opus');
  assert.equal(claudeCfg(undefined, { STRAND_CLAUDE_MODEL: 'a'.repeat(65) }).claudeModel, 'opus');
  assert.equal(err.mock.callCount(), 4);
});

test('an invalid claudeEffort falls back to high with one warning line', (t) => {
  const err = t.mock.method(console, 'error', () => {});
  assert.equal(claudeCfg(undefined, { STRAND_CLAUDE_EFFORT: 'ultra' }).claudeEffort, 'high');
  assert.equal(err.mock.callCount(), 1);
  assert.equal(err.mock.calls[0]!.arguments[0], 'warning: STRAND_CLAUDE_EFFORT "ultra" is not one of low, medium, high, xhigh, max, default; using high');
  assert.equal(claudeCfg({ claudeEffort: 'HIGH' }).claudeEffort, 'high');
  assert.equal(err.mock.callCount(), 2);
});

test('wip.mode, branchPrefix and claudePath come from the file; env overrides; bad mode throws', () => {
  const home = mkdtempSync(join(tmpdir(), 'strand-cfg-'));
  try {
    const env = { XDG_CONFIG_HOME: join(home, 'xdg') };
    mkdirSync(join(home, 'xdg', 'strand'), { recursive: true });
    writeFileSync(
      configPath('linux', env, home),
      JSON.stringify({ wip: { mode: 'refuse' }, branchPrefix: 'a', claudePath: '/f/claude' }),
    );
    const fromFile = loadConfig({ platform: 'linux', env, home });
    assert.equal(fromFile.wip.mode, 'refuse');
    assert.equal(fromFile.branchPrefix, 'a');
    assert.equal(fromFile.claudePath, '/f/claude');
    const overridden = loadConfig({
      platform: 'linux',
      env: { ...env, STRAND_WIP_MODE: 'warn', STRAND_BRANCH_PREFIX: 'b', STRAND_CLAUDE_PATH: '/e/claude' },
      home,
    });
    assert.equal(overridden.wip.mode, 'warn');
    assert.equal(overridden.branchPrefix, 'b');
    assert.equal(overridden.claudePath, '/e/claude');
    assert.throws(() => loadConfig({ platform: 'linux', env: { ...env, STRAND_WIP_MODE: 'strict' }, home }), /wip\.mode.*warn, refuse/);
    writeFileSync(configPath('linux', env, home), JSON.stringify({ wip: { mode: 'nope' } }));
    assert.throws(() => loadConfig({ platform: 'linux', env, home }), /wip\.mode.*warn, refuse/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('applyLegacyEnv fills each missing STRAND_* from its SDLC_* with one deprecation line per process', (t) => {
  resetLegacyEnvWarning();
  const err = t.mock.method(console, 'error', () => {});
  const env: NodeJS.ProcessEnv = { SDLC_WORKSPACE: '/old', STRAND_WIP_MODE: 'refuse', SDLC_WIP_MODE: 'warn', SDLC_GITEA_TOKEN: 't' };
  assert.equal(applyLegacyEnv(env), env);
  assert.equal(env.STRAND_WORKSPACE, '/old');
  assert.equal(env.STRAND_WIP_MODE, 'refuse', 'a STRAND_* value already set wins');
  assert.equal(env.STRAND_GITEA_TOKEN, 't');
  assert.equal(env.SDLC_WORKSPACE, '/old', 'the old variable is left in place');
  applyLegacyEnv({ SDLC_BRANCH_PREFIX: 'x' });
  assert.equal(err.mock.callCount(), 1);
  assert.match(String(err.mock.calls[0]!.arguments[0]), /^warning: SDLC_\* environment variables are deprecated; rename them to STRAND_\* \(read: SDLC_GITEA_TOKEN, SDLC_WORKSPACE\)/);
});

test('applyLegacyEnv says nothing when no SDLC_* variable is used', (t) => {
  resetLegacyEnvWarning();
  const err = t.mock.method(console, 'error', () => {});
  const env: NodeJS.ProcessEnv = { STRAND_WORKSPACE: '/new', SDLC_WORKSPACE: '/old', SDLC_EMPTY: '' };
  applyLegacyEnv(env);
  assert.equal(env.STRAND_WORKSPACE, '/new');
  assert.equal('STRAND_EMPTY' in env, false);
  assert.equal(err.mock.callCount(), 0);
});

test('loadConfig and configPath read SDLC_* when STRAND_* is unset', (t) => {
  resetLegacyEnvWarning();
  t.mock.method(console, 'error', () => {});
  const env = { SDLC_CONFIG_DIR: '/demo/cfg', SDLC_WORKSPACE: '/old-ws' };
  assert.equal(configPath('linux', env, '/home/k'), '/demo/cfg/config.json');
  const cfg = loadConfig({ platform: 'linux', env, home: '/no-such-home' });
  assert.equal(cfg.workspaceRoot, '/old-ws');
  assert.equal('STRAND_WORKSPACE' in env, false, 'the caller env is not changed');
});

test('a missing strand config is copied from the old sdlc folder, which is left in place', () => {
  const home = mkdtempSync(join(tmpdir(), 'strand-cfg-'));
  try {
    const xdg = join(home, 'xdg');
    mkdirSync(join(xdg, 'sdlc'), { recursive: true });
    const old = join(xdg, 'sdlc', 'config.json');
    writeFileSync(old, JSON.stringify({ workspaceRoot: '/from/old' }));
    writeFileSync(join(xdg, 'sdlc', 'cockpit.json'), '{}');
    const env = { XDG_CONFIG_HOME: xdg };
    assert.equal(loadConfig({ platform: 'linux', env, home }).workspaceRoot, '/from/old');
    const now = configPath('linux', env, home);
    // configPath('linux', ...) joins with posix rules, so the expected path does too (Windows runners).
    assert.equal(now, posix.join(xdg, 'strand', 'config.json'));
    assert.equal(readFileSync(now, 'utf8'), readFileSync(old, 'utf8'));
    assert.equal(readFileSync(old, 'utf8'), JSON.stringify({ workspaceRoot: '/from/old' }));
    assert.equal(existsSync(join(xdg, 'strand', 'cockpit.json')), false, 'the per-launch key file is not copied');
    // The new file wins from now on.
    writeFileSync(now, JSON.stringify({ workspaceRoot: '/from/new' }));
    assert.equal(loadConfig({ platform: 'linux', env, home }).workspaceRoot, '/from/new');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('legacyConfigPath is the old sdlc folder on each platform, and none under a config dir override', () => {
  assert.equal(legacyConfigPath('win32', { APPDATA: 'C:\\A' }, 'C:\\Users\\k'), 'C:\\A\\sdlc\\config.json');
  assert.equal(legacyConfigPath('darwin', {}, '/Users/k'), '/Users/k/Library/Application Support/sdlc/config.json');
  assert.equal(legacyConfigPath('linux', {}, '/home/k'), '/home/k/.config/sdlc/config.json');
  assert.equal(legacyConfigPath('linux', { STRAND_CONFIG_DIR: '/demo' }, '/home/k'), undefined);
});

test('AT-11 butPath and ghPath come from the file; STRAND_BUT_PATH and STRAND_GH_PATH override', () => {
  const home = mkdtempSync(join(tmpdir(), 'strand-cfg-'));
  try {
    const env = { XDG_CONFIG_HOME: join(home, 'xdg') };
    mkdirSync(join(home, 'xdg', 'strand'), { recursive: true });
    writeFileSync(configPath('linux', env, home), JSON.stringify({ butPath: '/f/but', ghPath: '/f/gh' }));
    const fromFile = loadConfig({ platform: 'linux', env, home });
    assert.equal(fromFile.butPath, '/f/but');
    assert.equal(fromFile.ghPath, '/f/gh');
    const overridden = loadConfig({ platform: 'linux', env: { ...env, STRAND_BUT_PATH: '/e/but', STRAND_GH_PATH: '/e/gh' }, home });
    assert.equal(overridden.butPath, '/e/but');
    assert.equal(overridden.ghPath, '/e/gh');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('AT-11 toolsDir is the tools folder beside the config file', () => {
  const env = { STRAND_CONFIG_DIR: '/cfg' };
  assert.equal(toolsDir('linux', env, '/home/u'), '/cfg/tools');
});

test('AT-11 addToolDirs puts the configured tools\' folders first on PATH, once', () => {
  const cfg = { claudePath: '/a/bin/claude', butPath: '/b/bin/but', ghPath: '/cfg/tools/gh/bin/gh' };
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/b/bin' };
  addToolDirs(env, cfg, 'linux');
  assert.equal(env.PATH, '/a/bin:/cfg/tools/gh/bin:/usr/bin:/b/bin');
  addToolDirs(env, cfg, 'linux');
  assert.equal(env.PATH, '/a/bin:/cfg/tools/gh/bin:/usr/bin:/b/bin', 'a second call adds nothing');
  const win: NodeJS.ProcessEnv = { Path: 'C:\\Windows' };
  addToolDirs(win, { ghPath: 'C:\\cfg\\tools\\gh\\bin\\gh.exe' }, 'win32');
  assert.equal(win.Path, 'C:\\cfg\\tools\\gh\\bin;C:\\Windows');
  assert.equal(win.PATH, undefined, 'the existing Path key is kept on Windows');
  const none: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
  addToolDirs(none, { butPath: 'relative/but' }, 'linux');
  assert.equal(none.PATH, '/usr/bin', 'a relative path is ignored');
});
