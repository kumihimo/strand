import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseEnv } from './fixtures/env.ts';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkPrerequisites,
  ensureTracker,
  ensureDocsRepo,
  raiseTranscriptRetention,
  installPlugin,
  backupSettings,
  removeOldWorkflowHooks,
  findClaude,
  reposWithoutTestCommand,
  main,
} from '../installer/setup.ts';
import { configPath } from '../src/core/config.ts';

const hasBd = spawnSync('bd', ['--version'], { env: baseEnv() }).status === 0;
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'strand-inst-'));
const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();

test('ensureTracker builds a git-lfs tracker and is idempotent', { skip: !hasBd && 'bd not installed' }, async () => {
  const dir = path.join(tmp(), 'tracker');
  await ensureTracker(dir, { vcs: 'git-lfs' });
  assert.ok(existsSync(path.join(dir, '.git')));
  assert.ok(existsSync(path.join(dir, '.beads')));
  const ignore = readFileSync(path.join(dir, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('artefacts/*/scratch/'));
  assert.ok(ignore.includes('.strand/'));
  assert.ok(ignore.includes('.sdlc/'), 'the pre-rename state folder stays ignored');
  const attrs = readFileSync(path.join(dir, '.gitattributes'), 'utf8');
  for (const ext of ['gz', 'png', 'jpg', 'mp4', 'pdf', 'pptx', 'docx']) {
    assert.ok(attrs.includes(`*.${ext} filter=lfs diff=lfs merge=lfs -text`), ext);
  }
  // Pinned to this tracker: a BEADS_DIR from the shell would read the real one.
  const got = spawnSync('bd', ['config', 'get', 'types.custom'], { cwd: dir, encoding: 'utf8', env: { ...baseEnv(), BEADS_DIR: path.join(dir, '.beads') } });
  assert.match(got.stdout, /dpia,eula-review,deck,supplier-spec,security-review,rfc,incident,retro/);

  const head = git(dir, 'rev-parse', 'HEAD');
  const status = git(dir, 'status', '--porcelain');
  await ensureTracker(dir, { vcs: 'git-lfs' });
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'status', '--porcelain'), status);
});

// bd 1.2.2 `bd init` itself creates a git repo and commits its own files; with 'none' the installer adds
// no git setup of its own (no ignore rules, no LFS attributes, no commit).
const noSdlcGit = (dir: string) => {
  assert.ok(!existsSync(path.join(dir, '.gitattributes')));
  const ignore = existsSync(path.join(dir, '.gitignore')) ? readFileSync(path.join(dir, '.gitignore'), 'utf8') : '';
  assert.ok(!ignore.includes('artefacts/*/scratch/'));
  if (existsSync(path.join(dir, '.git'))) assert.doesNotMatch(git(dir, 'log', '--format=%s'), /initialise tracker/);
};

test("ensureTracker with vcs 'none' sets up Beads with no git setup of its own", { skip: !hasBd && 'bd not installed' }, async () => {
  const dir = path.join(tmp(), 'tracker');
  await ensureTracker(dir, { vcs: 'none' });
  await ensureTracker(dir, { vcs: 'none' });
  assert.ok(existsSync(path.join(dir, '.beads')));
  noSdlcGit(dir);
});

test("ensureTracker with vcs 'git' has no LFS attributes; switching from none commits existing artefacts", { skip: !hasBd && 'bd not installed' }, async () => {
  const dir = path.join(tmp(), 'tracker');
  await ensureTracker(dir, { vcs: 'none' });
  mkdirSync(path.join(dir, 'artefacts', 'bd-1', 'scratch'), { recursive: true });
  writeFileSync(path.join(dir, 'artefacts', 'bd-1', 'kept.txt'), 'k');
  writeFileSync(path.join(dir, 'artefacts', 'bd-1', 'scratch', 'tmp.txt'), 't');
  await ensureTracker(dir, { vcs: 'git' });
  assert.ok(existsSync(path.join(dir, '.git')));
  assert.ok(!existsSync(path.join(dir, '.gitattributes')));
  const files = git(dir, 'ls-files').split(/\r?\n/);
  assert.ok(files.includes('artefacts/bd-1/kept.txt'), files.join(','));
  assert.ok(!files.some((f) => f.includes('scratch')));
  assert.ok(files.includes('.gitignore'));
});

test('ensureDocsRepo creates a repo with a README, idempotently', async () => {
  const dir = path.join(tmp(), 'docs');
  await ensureDocsRepo(dir);
  assert.ok(existsSync(path.join(dir, '.git')));
  const readme = readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.ok(readme.length > 0);
  writeFileSync(path.join(dir, 'README.md'), 'custom\n');
  await ensureDocsRepo(dir);
  assert.equal(readFileSync(path.join(dir, 'README.md'), 'utf8'), 'custom\n');
});

test('raiseTranscriptRetention creates, preserves and never lowers', () => {
  const d = tmp();
  const f = path.join(d, 'sub', 'settings.json');
  raiseTranscriptRetention(f, 365);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).cleanupPeriodDays, 365);

  writeFileSync(f, JSON.stringify({ theme: 'dark', cleanupPeriodDays: 30 }));
  raiseTranscriptRetention(f, 365);
  const raised = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(raised.theme, 'dark');
  assert.equal(raised.cleanupPeriodDays, 365);
  assert.ok(readFileSync(f, 'utf8').includes('\n  '));

  writeFileSync(f, JSON.stringify({ cleanupPeriodDays: 999, x: 1 }));
  raiseTranscriptRetention(f, 365);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { cleanupPeriodDays: 999, x: 1 });
});

test('checkPrerequisites with an empty PATH names every missing tool', async () => {
  const saved = process.env.PATH;
  process.env.PATH = '';
  try {
    const r = await checkPrerequisites('linux');
    assert.equal(r.ok, false);
    for (const tool of ['git', 'bd', 'but', 'claude']) {
      assert.equal(r.problems.filter((p) => p.startsWith(tool + ':')).length, 1, tool);
    }
  } finally {
    process.env.PATH = saved;
  }
});

test('checkPrerequisites passes with everything injected as present', async () => {
  const r = await checkPrerequisites('linux', {
    check: async () => '99.0.0',
    gitLfs: async () => true,
    nodeVersion: '24.1.0',
  });
  assert.deepEqual(r, { ok: true, problems: [] });
});

test('checkPrerequisites requires Git LFS only when asked (artefacts vcs git-lfs)', async () => {
  const base = { check: async () => '99.0.0', gitLfs: async () => false, nodeVersion: '24.1.0' };
  assert.deepEqual(await checkPrerequisites('linux', base), { ok: true, problems: [] });
  assert.deepEqual(await checkPrerequisites('linux', { ...base, lfs: true }), { ok: false, problems: ['Install Git LFS'] });
});

test('checkPrerequisites flags old node and old tools', async () => {
  const r = await checkPrerequisites('linux', {
    check: async (name) => (name === 'bd' ? '1.0.0' : '99.0.0'),
    gitLfs: async () => false,
    lfs: true,
    nodeVersion: '22.1.0',
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /node/i.test(p) && /24/.test(p)));
  assert.ok(r.problems.some((p) => /bd/.test(p)));
  assert.ok(r.problems.includes('Install Git LFS'));
});

test('checkPrerequisites on win32 checks the VC++ runtime and GitButler PATH', async () => {
  const base = { check: async () => '99.0.0', gitLfs: async () => true, nodeVersion: '24.0.0' };
  const bad = await checkPrerequisites('win32', { ...base, exists: () => false, pathEnv: 'C:\\Windows' });
  assert.ok(bad.problems.includes('Install the Microsoft Visual C++ 2015–2022 x64 Redistributable'));
  assert.ok(bad.problems.includes('Add C:\\Program Files\\GitButler to PATH'));
  const good = await checkPrerequisites('win32', {
    ...base,
    exists: (p) => p === 'C:\\Windows\\System32\\vcruntime140.dll',
    pathEnv: 'C:\\Windows;c:\\program files\\gitbutler\\',
  });
  assert.deepEqual(good, { ok: true, problems: [] });
});

type Call = { cmd: string; args: string[] };
const fakeRunner = (calls: Call[], opts: { markets?: string; plugins?: string; failWith?: string } = {}) =>
  async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const k = args.join(' ');
    if (k === 'plugin marketplace list --json') return { code: 0, stdout: opts.markets ?? '[]', stderr: '' };
    if (k === 'plugin list --json') return { code: 0, stdout: opts.plugins ?? '[]', stderr: '' };
    if (opts.failWith) return { code: 1, stdout: '', stderr: opts.failWith };
    return { code: 0, stdout: '', stderr: '' };
  };
const mutating = (calls: Call[]) => calls.filter((c) => !c.args.includes('list')).map((c) => c.args);

test('installPlugin adds the marketplace then installs the plugin when fresh', async () => {
  const calls: Call[] = [];
  await installPlugin('/repo/root', fakeRunner(calls));
  assert.deepEqual(mutating(calls), [
    ['plugin', 'marketplace', 'add', '/repo/root'],
    ['plugin', 'install', 'strand@strand'],
  ]);
});

test('installPlugin refreshes rather than re-adds what is already present', async () => {
  const calls: Call[] = [];
  await installPlugin(
    '/repo/root',
    fakeRunner(calls, { markets: '[{"name":"strand"}]', plugins: '[{"id":"strand@strand"}]' }),
  );
  assert.deepEqual(mutating(calls), [['plugin', 'update', 'strand@strand']]);
});

test('installPlugin removes the pre-rename sdlc plugin and marketplace before adding strand', async () => {
  const calls: Call[] = [];
  await installPlugin(
    '/repo/root',
    fakeRunner(calls, { markets: '[{"name":"sdlc-cockpit"}]', plugins: '[{"id":"sdlc@sdlc-cockpit"}]' }),
  );
  assert.deepEqual(mutating(calls), [
    ['plugin', 'uninstall', 'sdlc@sdlc-cockpit'],
    ['plugin', 'marketplace', 'remove', 'sdlc-cockpit'],
    ['plugin', 'marketplace', 'add', '/repo/root'],
    ['plugin', 'install', 'strand@strand'],
  ]);
});

test('installPlugin treats an "already" failure as success but surfaces other failures', async () => {
  await installPlugin('/r', fakeRunner([], { failWith: 'Marketplace already exists' }));
  await assert.rejects(installPlugin('/r', fakeRunner([], { failWith: 'boom' })), /boom/);
});

/** A fully sandboxed installer environment: config, Claude settings, checkout, keychain and runner are all fakes or temp dirs. */
function sandbox(over: Partial<Parameters<typeof main>[1]> = {}) {
  const home = tmp();
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData'),
    XDG_CONFIG_HOME: path.join(home, 'cfg'),
  };
  const config = { platform: process.platform, env, home };
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const tokens: string[] = [];
  const lines: string[] = [];
  const repoRoot = path.join(home, 'checkout');
  mkdirSync(path.join(repoRoot, 'node_modules'), { recursive: true });
  const io: NonNullable<Parameters<typeof main>[1]> = {
    log: (l) => lines.push(l),
    checkPrereqs: async () => ({ ok: true, problems: [] }),
    runner: async (cmd, args, o) => {
      calls.push({ cmd, args, cwd: o?.cwd });
      return { code: 0, stdout: '[]', stderr: '' };
    },
    config,
    settingsPath: path.join(home, 'claude', 'settings.json'),
    repoRoot,
    setToken: (t) => void tokens.push(t),
    ...over,
  };
  return { io, home, env, calls, tokens, lines, configFile: configPath(process.platform, env, home) };
}

test('main stops on failed prerequisites before prompting or touching anything', async () => {
  const sb = sandbox({ checkPrereqs: async () => ({ ok: false, problems: ['bd: missing'] }) });
  const code = await main([], sb.io);
  assert.equal(code, 1);
  assert.ok(sb.lines.some((l) => l.includes('bd: missing')));
  assert.ok(!sb.lines.some((l) => /workspace root/i.test(l)));
  assert.ok(!existsSync(sb.configFile));
});

test('main reports a malformed config as error: and returns 1', async () => {
  const sb = sandbox();
  mkdirSync(path.dirname(sb.configFile), { recursive: true });
  writeFileSync(sb.configFile, '{ nope');
  const code = await main(['--non-interactive'], sb.io);
  assert.equal(code, 1);
  assert.ok(sb.lines.some((l) => l.startsWith('error: ') && /Malformed config/.test(l)));
  assert.equal(sb.calls.length, 0);
});

test('main writes only inside the sandbox: config, settings and token go where injected', { skip: !hasBd && 'bd not installed' }, async () => {
  const ws = path.join(tmp(), 'ws');
  const sb = sandbox({ config: undefined });
  sb.io.config = { platform: process.platform, env: { ...sb.env, STRAND_GITEA_TOKEN: 'tok' }, home: sb.home };
  const code = await main(['--workspace', ws, '--non-interactive'], sb.io);
  assert.equal(code, 0, sb.lines.join('\n'));
  assert.equal(JSON.parse(readFileSync(sb.configFile, 'utf8')).workspaceRoot, ws);
  assert.equal(JSON.parse(readFileSync(path.join(sb.home, 'claude', 'settings.json'), 'utf8')).cleanupPeriodDays, 365);
  assert.deepEqual(sb.tokens, ['tok']);
  for (const c of sb.calls) {
    if (c.cwd) assert.ok(c.cwd.startsWith(sb.home) || c.cwd.startsWith(ws), `${c.cmd} ${c.args.join(' ')} in ${c.cwd}`);
  }
});

test('main with --artefacts-vcs git-lfs checks LFS and runs git lfs install --local in tracker and docs only', { skip: !hasBd && 'bd not installed' }, async () => {
  const ws = path.join(tmp(), 'ws');
  const lfsAsked: boolean[] = [];
  const sb = sandbox({ checkPrereqs: async (_p, o) => (lfsAsked.push(o.lfs), { ok: true, problems: [] }) });
  assert.equal(await main(['--workspace', ws, '--non-interactive', '--artefacts-vcs', 'git-lfs'], sb.io), 0, sb.lines.join('\n'));
  assert.deepEqual(lfsAsked, [true]);
  assert.equal(JSON.parse(readFileSync(sb.configFile, 'utf8')).artefactsVcs, 'git-lfs');
  assert.ok(existsSync(path.join(ws, 'tracker', '.gitattributes')));
  const lfs = sb.calls.filter((c) => c.args[0] === 'lfs');
  assert.deepEqual(
    lfs.map((c) => [c.args.join(' '), c.cwd]),
    [
      ['lfs install --local', path.join(ws, 'tracker')],
      ['lfs install --local', path.join(ws, 'docs')],
    ],
  );
});

test('main --dry-run prints the steps and changes nothing', async () => {
  const ws = path.join(tmp(), 'ws');
  const sb = sandbox();
  const code = await main(['--workspace', ws, '--non-interactive', '--dry-run'], sb.io);
  assert.equal(code, 0);
  assert.ok(!existsSync(ws));
  assert.ok(!existsSync(sb.configFile));
  assert.equal(sb.calls.length, 0);
  const out = sb.lines.join('\n');
  for (const s of ['prerequisites', 'config', 'tracker', 'docs', 'lfs', 'retention', 'npm install', 'plugin']) {
    assert.match(out.toLowerCase(), new RegExp(s.toLowerCase()), s);
  }
});

test('main resolves a relative --workspace and rejects --workspace with no value', async () => {
  const sb = sandbox();
  assert.equal(await main(['--workspace', 'rel-ws', '--dry-run'], sb.io), 0);
  assert.ok(sb.lines.some((l) => l.includes(`save workspace ${path.resolve('rel-ws')}`)), sb.lines.join('\n'));
  const bad = sandbox();
  assert.equal(await main(['--non-interactive', '--workspace'], bad.io), 2);
  assert.ok(bad.lines.some((l) => /--workspace needs a value/.test(l)), bad.lines.join('\n'));
});

test('main saves only the workspace root when tracker and docs are the defaults', { skip: !hasBd && 'bd not installed' }, async () => {
  const ws = path.join(tmp(), 'ws');
  const sb = sandbox();
  assert.equal(await main(['--workspace', ws, '--non-interactive'], sb.io), 0, sb.lines.join('\n'));
  const saved = JSON.parse(readFileSync(sb.configFile, 'utf8'));
  assert.equal(saved.workspaceRoot, ws);
  assert.equal(saved.trackerDir, undefined);
  assert.equal(saved.docsRepo, undefined);
});

test('main keeps a custom tracker path from an existing config', { skip: !hasBd && 'bd not installed' }, async () => {
  const ws = path.join(tmp(), 'ws');
  const custom = path.join(tmp(), 'my-tracker');
  const sb = sandbox();
  mkdirSync(path.dirname(sb.configFile), { recursive: true });
  writeFileSync(sb.configFile, JSON.stringify({ workspaceRoot: ws, trackerDir: custom }));
  assert.equal(await main(['--workspace', ws, '--non-interactive'], sb.io), 0, sb.lines.join('\n'));
  assert.equal(JSON.parse(readFileSync(sb.configFile, 'utf8')).trackerDir, custom);
  assert.ok(existsSync(path.join(custom, '.beads')));
});

test('main installs deps when node_modules is missing or older than package-lock.json, never --omit=dev, then builds the UI and links', { skip: !hasBd && 'bd not installed' }, async () => {
  const npm = (sb: ReturnType<typeof sandbox>) => sb.calls.filter((c) => c.cmd === 'npm').map((c) => [c.args.join(' '), c.cwd]);
  const lockAndMarker = (sb: ReturnType<typeof sandbox>, lockSecs: number, markerSecs: number) => {
    const lock = path.join(sb.io.repoRoot!, 'package-lock.json');
    const marker = path.join(sb.io.repoRoot!, 'node_modules', '.package-lock.json');
    writeFileSync(lock, '{}');
    writeFileSync(marker, '{}');
    utimesSync(lock, lockSecs, lockSecs);
    utimesSync(marker, markerSecs, markerSecs);
  };
  const install = 'install --no-audit --no-fund';

  const upToDate = sandbox();
  lockAndMarker(upToDate, 1_000_000, 2_000_000);
  await main(['--workspace', path.join(tmp(), 'ws'), '--non-interactive'], upToDate.io);
  assert.deepEqual(npm(upToDate), [['run build:ui', upToDate.io.repoRoot], ['link', upToDate.io.repoRoot]]);

  const upgraded = sandbox();
  lockAndMarker(upgraded, 2_000_000, 1_000_000);
  await main(['--workspace', path.join(tmp(), 'ws'), '--non-interactive'], upgraded.io);
  assert.deepEqual(npm(upgraded), [[install, upgraded.io.repoRoot], ['run build:ui', upgraded.io.repoRoot], ['link', upgraded.io.repoRoot]]);

  const fresh = sandbox();
  rmSync(path.join(fresh.io.repoRoot!, 'node_modules'), { recursive: true });
  await main(['--workspace', path.join(tmp(), 'ws'), '--non-interactive'], fresh.io);
  assert.deepEqual(npm(fresh), [[install, fresh.io.repoRoot], ['run build:ui', fresh.io.repoRoot], ['link', fresh.io.repoRoot]]);
  assert.ok(fresh.calls.every((c) => !c.args.includes('--omit=dev')));
});

test('main --dry-run lists npm install, the UI build and npm link', async () => {
  const sb = sandbox();
  rmSync(path.join(sb.io.repoRoot!, 'node_modules'), { recursive: true });
  await main(['--workspace', path.join(tmp(), 'ws'), '--non-interactive', '--dry-run'], sb.io);
  const step = sb.lines.find((l) => l.startsWith('[dry-run] 7.'))!;
  assert.match(step, /npm install --no-audit --no-fund.*npm run build:ui.*npm link/);
});

test('main prints a fallback when npm link fails but still finishes', { skip: !hasBd && 'bd not installed' }, async () => {
  const sb = sandbox();
  const inner = sb.io.runner!;
  sb.io.runner = async (cmd, args, o) =>
    cmd === 'npm' && args[0] === 'link' ? { code: 1, stdout: '', stderr: 'EACCES' } : inner(cmd, args, o);
  assert.equal(await main(['--workspace', path.join(tmp(), 'ws'), '--non-interactive'], sb.io), 0);
  const out = sb.lines.join('\n');
  assert.match(out, /npm link failed: EACCES/);
  assert.ok(out.includes(path.join(sb.io.repoRoot!, 'src', 'cli', 'strand.ts')), out);
});

test('main defaults artefacts vcs to none: no LFS check, no git in the tracker, no lfs calls', { skip: !hasBd && 'bd not installed' }, async () => {
  const ws = path.join(tmp(), 'ws');
  const lfsAsked: boolean[] = [];
  const sb = sandbox({ checkPrereqs: async (_p, o) => (lfsAsked.push(o.lfs), { ok: true, problems: [] }) });
  assert.equal(await main(['--workspace', ws, '--non-interactive'], sb.io), 0, sb.lines.join('\n'));
  assert.deepEqual(lfsAsked, [false]);
  assert.equal(JSON.parse(readFileSync(sb.configFile, 'utf8')).artefactsVcs, 'none');
  assert.ok(existsSync(path.join(ws, 'tracker', '.beads')));
  noSdlcGit(path.join(ws, 'tracker'));
  assert.deepEqual(sb.calls.filter((c) => c.args[0] === 'lfs'), []);
});

test('main --artefacts-vcs git sets up a git tracker without LFS; a bad value is a usage error', { skip: !hasBd && 'bd not installed' }, async () => {
  const ws = path.join(tmp(), 'ws');
  const sb = sandbox();
  assert.equal(await main(['--workspace', ws, '--non-interactive', '--artefacts-vcs', 'git'], sb.io), 0, sb.lines.join('\n'));
  assert.ok(existsSync(path.join(ws, 'tracker', '.git')));
  assert.ok(!existsSync(path.join(ws, 'tracker', '.gitattributes')));
  assert.deepEqual(sb.calls.filter((c) => c.args[0] === 'lfs'), []);
  const bad = sandbox();
  assert.equal(await main(['--artefacts-vcs', 'svn'], bad.io), 2);
  assert.ok(bad.lines.some((l) => /none, git, git-lfs/.test(l)));
});

// --- Task 12: cutover from the bash workflow hook ---------------------------------------

const hook = (command: string) => ({ type: 'command', command, timeout: 10 });
const oldSettings = () => ({
  theme: 'dark',
  hooks: {
    SessionStart: [
      { hooks: [hook('bd prime'), hook('bash ~/.claude/hooks/bead-workflow.sh start')] },
      { hooks: [hook('bash ~/.claude/hooks/single-init-migration.sh')] },
    ],
    PreToolUse: [
      { matcher: 'Edit|Write', hooks: [hook('bash ~/.claude/hooks/bead-workflow.sh pre')] },
      { matcher: 'Bash', hooks: [hook('bash ~/.claude/hooks/bead-workflow.sh bash'), hook('node other.js')] },
    ],
    Stop: [{ hooks: [hook('bash ~/.claude/hooks/bead-workflow.sh stop')] }],
  },
});

test('removeOldWorkflowHooks drops only bead-workflow.sh entries and keeps every other entry', () => {
  const f = path.join(tmp(), 'settings.json');
  writeFileSync(f, JSON.stringify(oldSettings(), null, 2));
  assert.equal(removeOldWorkflowHooks(f), 4);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), {
    theme: 'dark',
    hooks: {
      SessionStart: [{ hooks: [hook('bd prime')] }, { hooks: [hook('bash ~/.claude/hooks/single-init-migration.sh')] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [hook('node other.js')] }],
    },
  });
  assert.ok(readFileSync(f, 'utf8').includes('\n  '));
});

test('removeOldWorkflowHooks leaves a file with nothing to remove untouched and writes no backup', () => {
  const f = path.join(tmp(), 'settings.json');
  const text = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"x"}]}]}}';
  writeFileSync(f, text);
  assert.equal(removeOldWorkflowHooks(f), 0);
  assert.equal(readFileSync(f, 'utf8'), text);
  assert.ok(!existsSync(`${f}.pre-strand`));
  assert.equal(removeOldWorkflowHooks(path.join(tmp(), 'absent.json')), 0);
});

test('a pre-rename settings.json.pre-sdlc backup counts as the backup', () => {
  const f = path.join(tmp(), 'settings.json');
  writeFileSync(f, JSON.stringify(oldSettings()));
  writeFileSync(`${f}.pre-sdlc`, 'first');
  assert.equal(backupSettings(f), false);
  assert.ok(!existsSync(`${f}.pre-strand`));
});

test('the settings backup is written once and never replaced', () => {
  const f = path.join(tmp(), 'settings.json');
  writeFileSync(f, JSON.stringify(oldSettings()));
  const original = readFileSync(f, 'utf8');
  assert.equal(backupSettings(f), true);
  assert.equal(readFileSync(`${f}.pre-strand`, 'utf8'), original);
  removeOldWorkflowHooks(f);
  assert.equal(readFileSync(`${f}.pre-strand`, 'utf8'), original);
  assert.equal(backupSettings(f), false);
  assert.equal(readFileSync(`${f}.pre-strand`, 'utf8'), original);
  assert.equal(backupSettings(path.join(tmp(), 'absent.json')), false);
});

test('findClaude: undefined when PATH has claude, the .local/bin path when it does not', () => {
  const home = 'C:\\Users\\k';
  const local = path.win32.join(home, '.local', 'bin', 'claude.exe');
  const onPath = path.win32.join('C:\\tools', 'claude.exe');
  const win = (files: string[]) => ({
    platform: 'win32' as const,
    env: { PATH: 'C:\\Windows;C:\\tools' },
    home,
    exists: (p: string) => files.includes(p),
  });
  assert.equal(findClaude(win([onPath, local])), undefined);
  assert.equal(findClaude(win([local])), local);
  assert.equal(findClaude(win([])), undefined);
  const linux = findClaude({ platform: 'linux', env: { PATH: '/usr/bin' }, home: '/home/k', exists: (p) => p === '/home/k/.local/bin/claude' });
  assert.equal(linux, '/home/k/.local/bin/claude');
});

test('checkPrerequisites tells the engineer to upgrade an old but', async () => {
  const r = await checkPrerequisites('linux', { check: async (n) => (n === 'but' ? '0.23.4' : '99.0.0'), nodeVersion: '24.0.0' });
  assert.deepEqual(r.problems, ['but: 0.23.4 is older than the required 0.23.5. Upgrade but to 0.23.5 or newer']);
});

test('reposWithoutTestCommand lists workspace repos whose CLAUDE.md has no real Test command entry', () => {
  const ws = tmp();
  const repo = (name: string, files: Record<string, string> = {}) => {
    mkdirSync(path.join(ws, name, '.git'), { recursive: true });
    for (const [f, text] of Object.entries(files)) writeFileSync(path.join(ws, name, f), text);
  };
  repo('has', { 'CLAUDE.md': '# x\n\nTest command: docker compose run test\n' });
  repo('bold', { 'CLAUDE.md': '- **Test command:** npm test\n' });
  repo('table', { 'CLAUDE.md': '| Test command | npm test |\n' });
  repo('included', { 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': '## Notes\n\n- Test command: make test\n' });
  repo('included-without', { 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': '# nothing here\n' });
  repo('missing-include', { 'CLAUDE.md': '@NOPE.md\n' });
  repo('chatter', { 'CLAUDE.md': '# x\n\nno test command yet\n' });
  repo('lacks', { 'CLAUDE.md': '# x\n' });
  repo('nofile');
  mkdirSync(path.join(ws, 'not-a-repo'));
  assert.deepEqual(reposWithoutTestCommand(ws), ['chatter', 'included-without', 'lacks', 'missing-include', 'nofile']);
  assert.deepEqual(reposWithoutTestCommand(path.join(ws, 'absent')), []);
});

test('installPlugin runs every claude call through the path it is given', async () => {
  const calls: Call[] = [];
  await installPlugin('/repo/root', fakeRunner(calls), 'C:\\u\\.local\\bin\\claude.exe');
  assert.ok(calls.length >= 4);
  assert.ok(calls.every((c) => c.cmd === 'C:\\u\\.local\\bin\\claude.exe'), JSON.stringify(calls));
});

test('main --dry-run lists the new steps and writes nothing', async () => {
  const sb = sandbox();
  const code = await main(['--workspace', path.join(tmp(), 'ws'), '--non-interactive', '--dry-run', '--branch-prefix', 'ada'], sb.io);
  assert.equal(code, 0);
  const out = sb.lines.join('\n');
  assert.match(out, /branch prefix ada/);
  assert.match(out, /\.pre-strand/);
  assert.match(out, /9\. hooks: remove entries whose command contains bead-workflow\.sh/);
  assert.match(out, /10\. test command/);
  assert.equal(sb.calls.length, 0);
  assert.ok(!existsSync(sb.io.settingsPath!));
});

test('main stores the branch prefix (OS user name by default), the claude path when off PATH, and cuts over the hooks', { skip: !hasBd && 'bd not installed' }, async () => {
  const ws = path.join(tmp(), 'ws');
  const sb = sandbox({ userName: 'Ada Lovelace' });
  const local = path.join(sb.home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  sb.io.exists = (p) => p === local;
  const seen: (string | undefined)[] = [];
  sb.io.checkPrereqs = async (_p, o) => (seen.push(o.claudePath), { ok: true, problems: [] });
  const settings = sb.io.settingsPath!;
  mkdirSync(path.dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify(oldSettings()));
  const original = readFileSync(settings, 'utf8');
  mkdirSync(path.join(ws, 'repo-a', '.git'), { recursive: true });
  assert.equal(await main(['--workspace', ws, '--non-interactive'], sb.io), 0, sb.lines.join('\n'));
  const saved = JSON.parse(readFileSync(sb.configFile, 'utf8'));
  assert.equal(saved.branchPrefix, 'ada-lovelace');
  assert.equal(saved.claudePath, local);
  assert.deepEqual(seen, [local]);
  assert.equal(readFileSync(`${settings}.pre-strand`, 'utf8'), original);
  const after = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(after.cleanupPeriodDays, 365);
  assert.ok(!JSON.stringify(after).includes('bead-workflow.sh'));
  assert.ok(JSON.stringify(after).includes('single-init-migration.sh'));
  assert.ok(sb.lines.some((l) => l.includes('repo-a')), sb.lines.join('\n'));
});

test('main asks for the branch prefix and reads the token through the injected prompts, no TTY needed', { skip: !hasBd && 'bd not installed' }, async () => {
  const sb = sandbox({
    ask: async (q, fallback) => (q === 'Branch prefix' ? 'zed' : fallback),
    readSecret: async () => 'secret-token',
  });
  assert.equal(await main(['--workspace', path.join(tmp(), 'ws')], sb.io), 0, sb.lines.join('\n'));
  assert.equal(JSON.parse(readFileSync(sb.configFile, 'utf8')).branchPrefix, 'zed');
  assert.deepEqual(sb.tokens, ['secret-token']);
  assert.ok(!sb.lines.some((l) => /echoed/.test(l)));
});

test('main runs the plugin step through the detected claude path, never a bare claude', { skip: !hasBd && 'bd not installed' }, async () => {
  const sb = sandbox();
  const local = path.join(sb.home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  sb.io.exists = (p) => p === local;
  assert.equal(await main(['--workspace', path.join(tmp(), 'ws'), '--non-interactive'], sb.io), 0, sb.lines.join('\n'));
  const plugin = sb.calls.filter((c) => c.args[0] === 'plugin');
  assert.ok(plugin.length >= 3);
  assert.ok(plugin.every((c) => c.cmd === local), JSON.stringify(plugin));
  assert.ok(!sb.calls.some((c) => c.cmd === 'claude'));
});

test('main stops before any write when BEADS_DIR names another tracker than the one it would use', async () => {
  const ws = path.join(tmp(), 'ws');
  const real = path.join(tmp(), 'beads');
  const sb = sandbox();
  sb.io.config = { platform: process.platform, env: { ...sb.env, BEADS_DIR: path.join(real, '.beads') }, home: sb.home };
  mkdirSync(path.dirname(sb.configFile), { recursive: true });
  writeFileSync(sb.configFile, JSON.stringify({ workspaceRoot: ws, trackerDir: path.join(ws, 'elsewhere') }));
  const before = readFileSync(sb.configFile, 'utf8');
  assert.equal(await main(['--workspace', ws, '--non-interactive'], sb.io), 1);
  assert.equal(readFileSync(sb.configFile, 'utf8'), before);
  assert.equal(sb.calls.length, 0);
  assert.ok(!existsSync(path.join(ws, 'elsewhere')));
  const out = sb.lines.join('\n');
  assert.match(out, /BEADS_DIR/);
  assert.ok(out.includes(`--tracker-dir "${real}"`), out);
  // The dry run says the same and also stops.
  const dry = sandbox();
  dry.io.config = sb.io.config;
  assert.equal(await main(['--workspace', ws, '--non-interactive', '--dry-run'], dry.io), 1);
  assert.ok(dry.lines.join('\n').includes(`--tracker-dir "${real}"`));
});

test('main defaults the tracker to the parent of BEADS_DIR when there is no stored value and no flag', async () => {
  const ws = path.join(tmp(), 'ws');
  const real = path.join(tmp(), 'beads');
  mkdirSync(path.join(real, '.beads'), { recursive: true });
  const sb = sandbox();
  sb.io.config = { platform: process.platform, env: { ...sb.env, BEADS_DIR: path.join(real, '.beads') }, home: sb.home };
  assert.equal(await main(['--workspace', ws, '--non-interactive', '--dry-run'], sb.io), 0, sb.lines.join('\n'));
  const out = sb.lines.join('\n');
  assert.ok(out.includes(`tracker ${real}`), out);
  assert.ok(out.includes('bd init skipped'), out);
});

test('main refuses a --tracker-dir with no .beads in it unless --init-tracker is given', async () => {
  const ws = path.join(tmp(), 'ws');
  const empty = path.join(tmp(), 'no-beads');
  mkdirSync(empty, { recursive: true });
  const sb = sandbox();
  assert.equal(await main(['--workspace', ws, '--non-interactive', '--tracker-dir', empty], sb.io), 1);
  assert.ok(!existsSync(sb.configFile));
  assert.equal(sb.calls.length, 0);
  assert.ok(!existsSync(path.join(empty, '.beads')));
  assert.match(sb.lines.join('\n'), /no \.beads/);
  assert.match(sb.lines.join('\n'), /--init-tracker/);
  const dry = sandbox();
  assert.equal(await main(['--workspace', ws, '--non-interactive', '--dry-run', '--tracker-dir', empty], dry.io), 1);
  const ok = sandbox();
  assert.equal(await main(['--workspace', ws, '--non-interactive', '--dry-run', '--tracker-dir', empty, '--init-tracker'], ok.io), 0);
  assert.ok(ok.lines.some((l) => l.includes('bd init --prefix bd')), ok.lines.join('\n'));
});

test('main --tracker-dir leaves an existing tracker alone: its bead and prefix survive, and the folder is stored', { skip: !hasBd && 'bd not installed' }, async () => {
  const ws = path.join(tmp(), 'ws');
  const tracker = path.join(tmp(), 'existing-tracker');
  mkdirSync(tracker, { recursive: true });
  const env = { ...baseEnv(), BD_NON_INTERACTIVE: '1', BEADS_DIR: path.join(tracker, '.beads') };
  const bd = (...a: string[]) => spawnSync('bd', a, { cwd: tracker, encoding: 'utf8', env });
  assert.equal(bd('init', '--prefix', 'zz').status, 0);
  const created = bd('create', '--title=Keep me', '-t', 'task', '--json');
  assert.equal(created.status, 0, created.stderr);
  const listIds = () => (JSON.parse(bd('list', '--all', '--limit', '0', '--json').stdout) as { id: string }[]).map((b) => b.id);
  const before = listIds();
  assert.equal(before.length, 1);
  assert.match(before[0]!, /^zz-/);

  const sb = sandbox();
  assert.equal(await main(['--workspace', ws, '--non-interactive', '--dry-run', '--tracker-dir', tracker, '--prefix', 'other'], sb.io), 0);
  assert.ok(sb.lines.some((l) => l.includes('bd init skipped')), sb.lines.join('\n'));
  assert.equal(
    await main(['--workspace', ws, '--non-interactive', '--tracker-dir', tracker, '--prefix', 'other'], sb.io),
    0,
    sb.lines.join('\n'),
  );
  assert.equal(JSON.parse(readFileSync(sb.configFile, 'utf8')).trackerDir, tracker);
  assert.deepEqual(listIds(), before);
  assert.ok(listIds().every((id) => id.startsWith('zz-')));
});
