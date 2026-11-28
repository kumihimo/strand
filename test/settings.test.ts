import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SETTING_KEYS, SettingsError, readSettings, writeSettings } from '../src/core/settings.ts';

/** A sandboxed config folder and the env that points at it. No real config is read or written. */
function sandbox(file?: unknown, extraEnv: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'strand-settings-'));
  const cfgDir = join(dir, 'cfg');
  mkdirSync(cfgDir);
  const path = join(cfgDir, 'config.json');
  if (file !== undefined) writeFileSync(path, typeof file === 'string' ? file : JSON.stringify(file, null, 2) + '\n');
  const env: NodeJS.ProcessEnv = { STRAND_CONFIG_DIR: cfgDir, HOME: dir, XDG_CONFIG_HOME: join(dir, 'xdg'), ...extraEnv };
  return { dir, path, opts: { env, home: dir } };
}

const field = (v: ReturnType<typeof readSettings>, key: string) => {
  const f = v.fields.find((x) => x.key === key);
  assert.ok(f, `no field ${key}`);
  return f;
};

test('AT-1 every config value is listed with its file value, effective value and restart flag', () => {
  const { path, opts, dir } = sandbox({ workspaceRoot: '/w', wip: { build: 2, mode: 'refuse' }, claudeModel: 'opus' });
  const v = readSettings(opts);
  assert.equal(v.path, path);
  assert.deepEqual(
    v.fields.map((f) => f.key),
    [
      'workspaceRoot', 'trackerDir', 'docsRepo', 'giteaUrl', 'wip.build', 'wip.review', 'wip.mode', 'artefactsVcs',
      'branchPrefix', 'claudePath', 'butPath', 'ghPath', 'claudeModel', 'claudeEffort', 'cockpit.window', 'cockpit.maxSessions',
    ],
  );
  assert.deepEqual(SETTING_KEYS, v.fields.map((f) => f.key));
  assert.deepEqual(field(v, 'workspaceRoot'), { ...field(v, 'workspaceRoot'), file: '/w', effective: '/w', restart: true });
  assert.equal(field(v, 'trackerDir').file, undefined);
  assert.equal(field(v, 'trackerDir').effective, join('/w', 'tracker'));
  assert.equal(field(v, 'wip.build').file, 2);
  assert.equal(field(v, 'wip.build').restart, false);
  assert.equal(field(v, 'wip.review').effective, 3);
  assert.equal(field(v, 'wip.mode').effective, 'refuse');
  assert.equal(field(v, 'claudeModel').file, 'opus');
  assert.equal(field(v, 'cockpit.window').effective, 'app');
  assert.equal(field(v, 'cockpit.window').restart, true);
  assert.deepEqual(field(v, 'wip.mode').choices, ['warn', 'refuse']);
  for (const f of v.fields) assert.equal(f.envVar, undefined, f.key);
  void dir;
});

test('AT-1 a missing file lists every value with its default', () => {
  const { opts } = sandbox();
  const v = readSettings(opts);
  assert.equal(field(v, 'wip.mode').file, undefined);
  assert.equal(field(v, 'wip.mode').effective, 'warn');
  assert.equal(field(v, 'cockpit.maxSessions').effective, 4);
});

test('AT-2 a valid patch is saved to the config path, unknown keys are kept', () => {
  const { path, opts } = sandbox({ workspaceRoot: '/w', futureKey: { a: 1 }, wip: { build: 3, review: 3, mode: 'warn' } });
  const v = writeSettings(
    { 'wip.build': 5, 'wip.mode': 'refuse', 'cockpit.window': 'tab', 'cockpit.maxSessions': 6, branchPrefix: 'kmg', claudeEffort: 'high', giteaUrl: 'https://git.example' },
    opts,
  );
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(saved, {
    workspaceRoot: '/w',
    futureKey: { a: 1 },
    wip: { build: 5, review: 3, mode: 'refuse' },
    cockpit: { window: 'tab', maxSessions: 6 },
    branchPrefix: 'kmg',
    claudeEffort: 'high',
    giteaUrl: 'https://git.example',
  });
  assert.equal(field(v, 'wip.build').effective, 5);
  // No temp file is left behind.
  assert.deepEqual(readdirSync(join(path, '..')), ['config.json']);
});

test('AT-2 empty trackerDir and docsRepo are not stored, and an empty value removes its key', () => {
  const { path, opts } = sandbox({ workspaceRoot: '/w', trackerDir: '/t', docsRepo: '/d', branchPrefix: 'kmg', wip: { build: 2 } });
  writeSettings({ trackerDir: '', docsRepo: null, branchPrefix: '', 'wip.build': '' }, opts);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { workspaceRoot: '/w' });
});

test('AT-2 a patch to a missing file creates it', () => {
  const { path, opts } = sandbox();
  writeSettings({ 'wip.review': 2 }, opts);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { wip: { review: 2 } });
});

test('invalid values are refused with a message per field, and the file is left byte-identical', () => {
  const text = '{\n  "wip": { "build": 2 }\n}\n';
  const { path, opts } = sandbox(text);
  const bad: Record<string, unknown> = {
    'wip.mode': 'x',
    'cockpit.maxSessions': 0,
    claudeModel: 'bad model',
    'wip.build': 'three',
    'wip.review': 1.5,
    claudeEffort: 'huge',
    artefactsVcs: 'svn',
    'cockpit.window': 'popup',
    branchPrefix: '-x',
    giteaUrl: 'ftp://x',
    workspaceRoot: 'relative/dir',
  };
  assert.throws(
    () => writeSettings(bad, opts),
    (e: unknown) => {
      assert.ok(e instanceof SettingsError);
      assert.deepEqual(Object.keys(e.fields).sort(), Object.keys(bad).sort());
      return true;
    },
  );
  assert.equal(readFileSync(path, 'utf8'), text);
});

test('an unknown key is refused without echoing it, and nothing is written', () => {
  const { path, opts } = sandbox({ wip: { build: 2 } });
  const before = readFileSync(path, 'utf8');
  assert.throws(() => writeSettings({ 'wip.build': 4, '__proto__x': 1 }, opts), (e: unknown) => {
    assert.ok(e instanceof SettingsError);
    assert.ok(!e.message.includes('__proto__x'));
    return true;
  });
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('a malformed config file is never overwritten', () => {
  const { path, opts } = sandbox('{ not json');
  assert.throws(() => writeSettings({ 'wip.build': 4 }, opts), /Malformed config file/);
  assert.equal(readFileSync(path, 'utf8'), '{ not json');
});

test('AT-4 an env override is reported with its variable and never written to the file', () => {
  const { path, opts } = sandbox({ wip: { mode: 'warn' } }, { STRAND_WIP_MODE: 'refuse', SDLC_CLAUDE_MODEL: 'sonnet' });
  const v = readSettings(opts);
  assert.equal(field(v, 'wip.mode').envVar, 'STRAND_WIP_MODE');
  assert.equal(field(v, 'wip.mode').file, 'warn');
  assert.equal(field(v, 'wip.mode').effective, 'refuse');
  assert.equal(field(v, 'claudeModel').envVar, 'SDLC_CLAUDE_MODEL');
  writeSettings({ 'wip.build': 4 }, opts);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { wip: { mode: 'warn', build: 4 } });
  // A field the env sets is read-only here.
  assert.throws(() => writeSettings({ 'wip.mode': 'warn' }, opts), (e: unknown) => {
    assert.ok(e instanceof SettingsError);
    assert.match(e.fields['wip.mode'] ?? '', /STRAND_WIP_MODE/);
    return true;
  });
});

test('AT-5 claudePath is saved only as an existing absolute file; empty removes the key', () => {
  const { dir, path, opts } = sandbox({});
  const exe = join(dir, 'claude-bin');
  writeFileSync(exe, '');
  const bad = ['claude', './claude', join(dir, 'missing'), dir, '/' + 'a'.repeat(1100), join(dir, 'a\nb'), join(dir, 'a\u0000b'), 42];
  for (const p of bad) {
    assert.throws(() => writeSettings({ claudePath: p }, opts), (e: unknown) => e instanceof SettingsError && 'claudePath' in e.fields, String(p).slice(0, 40));
  }
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {});
  writeSettings({ claudePath: exe }, opts);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { claudePath: exe });
  writeSettings({ claudePath: '' }, opts);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {});
});

test('AT-11 butPath and ghPath are saved under the same checks as claudePath', () => {
  const { dir, path, opts } = sandbox({});
  const exe = join(dir, 'tool-bin');
  writeFileSync(exe, '');
  for (const key of ['butPath', 'ghPath']) {
    for (const p of ['but', join(dir, 'missing'), dir]) {
      assert.throws(() => writeSettings({ [key]: p }, opts), (e: unknown) => e instanceof SettingsError && key in e.fields, `${key} ${p}`);
    }
  }
  writeSettings({ butPath: exe, ghPath: exe }, opts);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { butPath: exe, ghPath: exe });
});

test('a patch that is not an object is refused', () => {
  const { opts } = sandbox({});
  for (const p of [null, [], 'x', 3]) assert.throws(() => writeSettings(p as never, opts), SettingsError);
});
