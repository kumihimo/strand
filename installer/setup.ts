import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { run, ToolMissingError } from '../src/core/exec.ts';
import type { RunResult } from '../src/core/exec.ts';
import { requireTool, compareVersions, MINIMUM_VERSIONS } from '../src/core/tools.ts';
import {
  applyLegacyEnv,
  loadConfig,
  parseArtefactsVcs,
  saveConfig,
  type ArtefactsVcs,
  type ConfigOptions,
  type StoredConfig,
} from '../src/core/config.ts';
import { setGiteaToken } from '../src/core/secrets.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CUSTOM_TYPES = 'dpia,eula-review,deck,supplier-spec,security-review,rfc,incident,retro';
const LFS_EXTS = ['gz', 'png', 'jpg', 'mp4', 'pdf', 'pptx', 'docx'];
const GITBUTLER_DIR = 'C:\\Program Files\\GitButler';
const VCRUNTIME = 'C:\\Windows\\System32\\vcruntime140.dll';

export type Runner = (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<RunResult>;

export interface PrereqOptions {
  check?: (name: 'git' | 'bd' | 'but' | 'claude', min: string) => Promise<string>;
  gitLfs?: () => Promise<boolean>;
  exists?: (p: string) => boolean;
  pathEnv?: string;
  nodeVersion?: string;
  /** Where claude lives when it is not on PATH (found by findClaude). */
  claudePath?: string;
  /** Require Git LFS (only when the artefacts folder uses git-lfs, ADR 0009). */
  lfs?: boolean;
}

const MINIMUMS = (['git', 'bd', 'but', 'claude'] as const).map((n) => [n, MINIMUM_VERSIONS[n]] as const);

/** Verify the machine has everything the strand system needs; one problem line per gap. */
export async function checkPrerequisites(
  platform: NodeJS.Platform,
  opts: PrereqOptions = {},
): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const check =
    opts.check ?? ((name, min) => requireTool(name, min, name === 'claude' && opts.claudePath ? { path: opts.claudePath } : {}));
  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  if (Number(nodeVersion.split('.')[0]) < 24) {
    problems.push(`node ${nodeVersion} is older than the required 24; install Node 24 or newer from https://nodejs.org`);
  }
  let gitOk = false;
  for (const [name, min] of MINIMUMS) {
    try {
      const found = await check(name, min);
      if (compareVersions(found, min) < 0) {
        problems.push(`${name}: ${found} is older than the required ${min}. Upgrade ${name} to ${min} or newer`);
        continue;
      }
      if (name === 'git') gitOk = true;
    } catch (e) {
      if (e instanceof ToolMissingError) problems.push(`${name}: ${e.message}${e.message.includes(e.hint) ? '' : `. ${e.hint}`}`);
      else problems.push(`${name}: ${(e as Error).message}`);
    }
  }
  if (gitOk && opts.lfs) {
    const lfs =
      opts.gitLfs ??
      (async () => {
        try {
          return (await run('git', ['lfs', 'version'])).code === 0;
        } catch {
          return false;
        }
      });
    if (!(await lfs())) problems.push('Install Git LFS');
  }
  if (platform === 'win32') {
    const exists = opts.exists ?? existsSync;
    if (!exists(VCRUNTIME)) problems.push('Install the Microsoft Visual C++ 2015–2022 x64 Redistributable');
    const norm = (s: string) => s.trim().replace(/[\\/]+$/, '').toLowerCase();
    const onPath = (opts.pathEnv ?? process.env.PATH ?? process.env.Path ?? '')
      .split(';')
      .some((s) => norm(s) === norm(GITBUTLER_DIR));
    if (!onPath) problems.push(`Add ${GITBUTLER_DIR} to PATH`);
  }
  return { ok: problems.length === 0, problems };
}

async function git(cwd: string, args: string[]): Promise<RunResult> {
  const r = await run('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r;
}

/** Commit identity fallback so installs work on machines with no git user configured. */
async function gitEnv(cwd: string): Promise<Record<string, string>> {
  const name = await run('git', ['config', 'user.name'], { cwd });
  const email = await run('git', ['config', 'user.email'], { cwd });
  const env: Record<string, string> = {};
  if (!name.stdout.trim()) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'strand installer';
  }
  if (!email.stdout.trim()) {
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'strand@localhost';
  }
  return env;
}

async function commitIfChanged(dir: string, paths: string[], message: string): Promise<void> {
  const present = paths.filter((p) => existsSync(path.join(dir, p)));
  if (present.length === 0) return;
  await git(dir, ['add', '--', ...present]);
  const staged = await run('git', ['diff', '--cached', '--quiet'], { cwd: dir });
  if (staged.code === 0) return;
  const r = await run('git', ['commit', '-m', message], { cwd: dir, env: await gitEnv(dir) });
  if (r.code !== 0) throw new Error(`git commit failed: ${r.stderr.trim()}`);
}

function ensureLines(file: string, lines: string[]): void {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const have = new Set(existing.split(/\r?\n/));
  const missing = lines.filter((l) => !have.has(l));
  if (missing.length === 0) return;
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  writeFileSync(file, existing + sep + missing.join('\n') + '\n');
}

/**
 * Tracker folder with Beads and custom types. Git (init, .gitignore, commit of what exists) only for the
 * git modes; LFS attributes only for git-lfs (ADR 0009). With 'none' it is a plain folder.
 */
export async function ensureTracker(dir: string, opts: { prefix?: string; vcs: ArtefactsVcs }): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const useGit = opts.vcs !== 'none';
  if (useGit) {
    if (!existsSync(path.join(dir, '.git'))) await git(dir, ['init']);
    ensureLines(path.join(dir, '.gitignore'), ['artefacts/*/scratch/', '.strand/', '.sdlc/']);
  }
  if (opts.vcs === 'git-lfs') {
    ensureLines(
      path.join(dir, '.gitattributes'),
      LFS_EXTS.map((e) => `*.${e} filter=lfs diff=lfs merge=lfs -text`),
    );
  }
  if (!existsSync(path.join(dir, '.beads'))) {
    const r = await run('bd', ['init', '--prefix', opts.prefix ?? 'bd'], { cwd: dir, env: { BD_NON_INTERACTIVE: '1', BEADS_DIR: path.join(dir, '.beads') } });
    if (r.code !== 0) throw new Error(`bd init failed: ${(r.stderr || r.stdout).trim()}`);
  }
  const c = await run('bd', ['config', 'set', 'types.custom', CUSTOM_TYPES], { cwd: dir, env: { BD_NON_INTERACTIVE: '1', BEADS_DIR: path.join(dir, '.beads') } });
  if (c.code !== 0) throw new Error(`bd config set types.custom failed: ${(c.stderr || c.stdout).trim()}`);
  if (useGit) {
    // Also commits artefacts kept before switching from 'none' (scratch is ignored).
    await commitIfChanged(dir, ['.gitignore', '.gitattributes', '.beads', 'artefacts'], 'chore: initialise tracker (gitignore, LFS, beads)');
  }
}

export async function ensureDocsRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(path.join(dir, '.git'))) await git(dir, ['init']);
  const readme = path.join(dir, 'README.md');
  if (!existsSync(readme)) {
    writeFileSync(readme, '# Docs\n\nRFCs, ADRs and architecture notes for the strand system.\n');
    await commitIfChanged(dir, ['README.md'], 'docs: add README');
  }
}

export function raiseTranscriptRetention(settingsPath: string, days: number): void {
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${settingsPath} is not a JSON object`);
    }
    settings = parsed as Record<string, unknown>;
  }
  const current = settings.cleanupPeriodDays;
  if (typeof current === 'number' && current >= days) return;
  settings.cleanupPeriodDays = days;
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

/** Settings entries whose command contains this belong to the old bash workflow hook. */
const OLD_HOOK = 'bead-workflow.sh';

/**
 * Copy settings.json to settings.json.pre-strand, only when it exists and no backup exists yet. A
 * `.pre-sdlc` backup from before the rename to Strand counts: it holds the settings as they first were.
 */
export function backupSettings(settingsPath: string): boolean {
  const backup = `${settingsPath}.pre-strand`;
  if (!existsSync(settingsPath) || existsSync(backup) || existsSync(`${settingsPath}.pre-sdlc`)) return false;
  copyFileSync(settingsPath, backup);
  return true;
}

/**
 * Remove the hook entries of the old bash workflow (command contains bead-workflow.sh) from Claude Code's
 * settings.json. An emptied matcher group, then an emptied event, goes too. Everything else is kept.
 * Returns how many entries were removed. The file is only touched when there is something to remove.
 */
export function removeOldWorkflowHooks(settingsPath: string): number {
  if (!existsSync(settingsPath)) return 0;
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${settingsPath} is not a JSON object`);
  const settings = parsed as Record<string, unknown>;
  const hooks = settings.hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return 0;
  let removed = 0;
  const kept: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      kept[event] = groups;
      continue;
    }
    const outGroups: unknown[] = [];
    for (const group of groups) {
      const inner = (group as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(inner)) {
        outGroups.push(group);
        continue;
      }
      const left = inner.filter((h) => {
        const old = typeof (h as { command?: unknown } | null)?.command === 'string' && (h as { command: string }).command.includes(OLD_HOOK);
        if (old) removed++;
        return !old;
      });
      if (left.length === inner.length) outGroups.push(group);
      else if (left.length > 0) outGroups.push({ ...(group as object), hooks: left });
    }
    if (outGroups.length > 0) kept[event] = outGroups;
  }
  if (removed === 0) return 0;
  backupSettings(settingsPath);
  settings.hooks = kept;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return removed;
}

/**
 * The claude to use when it is not on PATH: undefined when PATH has it (or nothing is found),
 * else `<home>/.local/bin/claude(.exe)`.
 */
export function findClaude(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string; exists?: (p: string) => boolean }): string | undefined {
  const exists = o.exists ?? existsSync;
  const win = o.platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const names = win ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const dirs = (o.env.PATH ?? o.env.Path ?? '').split(win ? ';' : ':').filter(Boolean);
  if (dirs.some((d) => names.some((n) => exists(p.join(d, n))))) return undefined;
  const local = p.join(o.home, '.local', 'bin', win ? 'claude.exe' : 'claude');
  return exists(local) ? local : undefined;
}

/** A real entry: `Test command:`, `**Test command:**`, `- Test command:` or a table row. Not a sentence that mentions it. */
const TEST_COMMAND = /^\s*[-*#>|\s]*\**test command\**\s*[:|]/im;

/** CLAUDE.md plus the files it includes with `@<file>` lines, one level deep and inside the repo. */
function claudeText(repoDir: string): string {
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  const main = read(path.join(repoDir, 'CLAUDE.md'));
  let all = main;
  for (const m of main.matchAll(/^\s*@(\S+)\s*$/gm)) {
    const file = path.resolve(repoDir, m[1]!);
    const rel = path.relative(repoDir, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    try {
      if (statSync(file).isFile()) all += '\n' + read(file);
    } catch {
      // an include that cannot be read counts as nothing
    }
  }
  return all;
}

/** Workspace repos (direct children with a .git) whose CLAUDE.md, with its includes, has no Test command entry. */
export function reposWithoutTestCommand(workspace: string): string[] {
  if (!existsSync(workspace)) return [];
  const out: string[] = [];
  for (const e of readdirSync(workspace, { withFileTypes: true })) {
    if (!e.isDirectory() || !existsSync(path.join(workspace, e.name, '.git'))) continue;
    if (!TEST_COMMAND.test(claudeText(path.join(workspace, e.name)))) out.push(e.name);
  }
  return out.sort();
}

async function listNames(runner: Runner, claude: string, args: string[], key: 'name' | 'id'): Promise<string[]> {
  try {
    const r = await runner(claude, args);
    if (r.code !== 0) return [];
    const parsed: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((x) => (x as Record<string, unknown>)?.[key]).filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

const LEGACY_PLUGIN = 'sdlc@sdlc-cockpit';
const LEGACY_MARKETPLACE = 'sdlc-cockpit';

/** `claude` is the command to run: the detected path when claude is not on PATH. */
export async function installPlugin(repoRoot: string, runner: Runner = run, claude = 'claude'): Promise<void> {
  const step = async (args: string[]) => {
    const r = await runner(claude, args);
    const out = `${r.stderr}\n${r.stdout}`;
    if (r.code !== 0 && !/already/i.test(out)) {
      throw new Error(`claude ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
    }
  };
  let markets = await listNames(runner, claude, ['plugin', 'marketplace', 'list', '--json'], 'name');
  let plugins = await listNames(runner, claude, ['plugin', 'list', '--json'], 'id');
  // The pre-rename registration (ADR 0021): its hooks would run beside Strand's, and its marketplace holds
  // the same checkout under the old name.
  if (plugins.includes(LEGACY_PLUGIN)) {
    await step(['plugin', 'uninstall', LEGACY_PLUGIN]);
    plugins = plugins.filter((p) => p !== LEGACY_PLUGIN);
  }
  if (markets.includes(LEGACY_MARKETPLACE)) {
    await step(['plugin', 'marketplace', 'remove', LEGACY_MARKETPLACE]);
    markets = markets.filter((m) => m !== LEGACY_MARKETPLACE);
  }
  if (!markets.includes('strand')) await step(['plugin', 'marketplace', 'add', repoRoot]);
  // Already installed: refresh it, so re-running the installer after `git pull` picks up a new version.
  if (plugins.includes('strand@strand')) await step(['plugin', 'update', 'strand@strand']);
  else await step(['plugin', 'install', 'strand@strand']);
}

const NPM_INSTALL = ['npm', 'install', '--no-audit', '--no-fund'];

/**
 * Dependencies need (re)installing when node_modules is missing, or when package-lock.json is newer than
 * npm's own marker `node_modules/.package-lock.json` (an upgrade pulled a new lock file).
 */
function needsNpmInstall(repoRoot: string): boolean {
  const modules = path.join(repoRoot, 'node_modules');
  if (!existsSync(modules)) return true;
  const lock = path.join(repoRoot, 'package-lock.json');
  if (!existsSync(lock)) return false;
  const marker = path.join(modules, '.package-lock.json');
  if (!existsSync(marker)) return true;
  return statSync(lock).mtimeMs > statSync(marker).mtimeMs;
}

/** Put `strand` on PATH with `npm link` in the checkout; on failure, say how to do it by hand. */
async function linkCli(repoRoot: string, runner: Runner, log: (l: string) => void): Promise<void> {
  const cli = path.join(repoRoot, 'src', 'cli', 'strand.ts');
  let why: string;
  try {
    const r = await runner('npm', ['link'], { cwd: repoRoot });
    if (r.code === 0) {
      log('strand is on PATH (npm link).');
      return;
    }
    why = (r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? '';
  } catch (e) {
    why = (e as Error).message;
  }
  log(`npm link failed: ${why}`);
  log(`  To use strand from a terminal, run \`npm link\` in ${repoRoot} yourself, or call: node "${cli}" <command>`);
}

interface Args {
  workspace?: string;
  giteaUrl?: string;
  prefix?: string;
  artefactsVcs?: ArtefactsVcs;
  trackerDir?: string;
  /** Allow `bd init` in a `--tracker-dir` that has no `.beads` yet. */
  initTracker: boolean;
  branchPrefix?: string;
  nonInteractive: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { nonInteractive: false, dryRun: false, initTracker: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${v} needs a value`);
      return next;
    };
    if (v === '--workspace') a.workspace = value();
    else if (v === '--gitea-url') a.giteaUrl = value();
    else if (v === '--prefix') a.prefix = value();
    else if (v === '--artefacts-vcs') a.artefactsVcs = parseArtefactsVcs(value(), '--artefacts-vcs');
    else if (v === '--tracker-dir') a.trackerDir = value();
    else if (v === '--init-tracker') a.initTracker = true;
    else if (v === '--branch-prefix') a.branchPrefix = value();
    else if (v === '--non-interactive') a.nonInteractive = true;
    else if (v === '--dry-run') a.dryRun = true;
    else throw new Error(`Unknown argument: ${v}`);
  }
  return a;
}

/** Everything main touches outside the workspace is injectable, so tests never reach the real config, ~/.claude or keychain. */
export interface MainIo {
  log?: (line: string) => void;
  checkPrereqs?: (platform: NodeJS.Platform, opts: { lfs: boolean; claudePath?: string }) => Promise<{ ok: boolean; problems: string[] }>;
  /** Runs git lfs, npm and claude (plugin) commands. */
  runner?: Runner;
  /** Where the strand config lives: platform, env and home. */
  config?: ConfigOptions;
  /** Claude Code user settings.json (transcript retention). */
  settingsPath?: string;
  /** The strand checkout (npm install, plugin marketplace). */
  repoRoot?: string;
  setToken?: (token: string) => void;
  /** File-exists check for finding claude (default: the file system). */
  exists?: (p: string) => boolean;
  /** The OS user name, the default branch prefix. */
  userName?: string;
  /** Replaces the terminal prompt for every question except the token. Tests use it to avoid a TTY. */
  ask?: (question: string, fallback?: string) => Promise<string | undefined>;
  /** Replaces the no-echo token prompt. */
  readSecret?: (question: string) => Promise<string>;
}

/** Two paths name the same folder: resolved, no trailing separator, case-insensitive on Windows. */
function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (s: string) => {
    const r = p.resolve(s).replace(/[\\/]+$/, '');
    return platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** A branch prefix from the OS user name: lower case, no spaces or characters git dislikes. */
function branchPrefixFrom(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'dev';
}

function osUserName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || 'dev';
  }
}

export async function main(argv: string[], io: MainIo = {}): Promise<number> {
  const log = io.log ?? ((l: string) => console.log(l));
  const runner = io.runner ?? run;
  const checkPrereqs = io.checkPrereqs ?? ((pl, o) => checkPrerequisites(pl, o));
  const platform = io.config?.platform ?? process.platform;
  const env = io.config?.env ?? process.env;
  const home = io.config?.home ?? os.homedir();
  const cfgOpts: ConfigOptions = { platform, env, home };
  const repoRoot = io.repoRoot ?? REPO_ROOT;
  const setToken = io.setToken ?? setGiteaToken;
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    log((e as Error).message);
    return 2;
  }
  let rl: readline.Interface | undefined;
  let muted = false;
  try {
    // Git LFS is a prerequisite only for git-lfs: the flag, else the mode already in the config.
    let plannedVcs = args.artefactsVcs;
    let configured: ReturnType<typeof loadConfig> | undefined;
    try {
      configured = loadConfig(cfgOpts);
      plannedVcs ??= configured.artefactsVcs;
    } catch {
      // a malformed config is reported below
    }
    // claude may sit in ~/.local/bin without being on PATH: then its path goes in the config.
    const claudeOffPath = findClaude({ platform, env, home, exists: io.exists });
    const claudePath = claudeOffPath ?? configured?.claudePath;
    const prereqs = async (lfs: boolean): Promise<boolean> => {
      log('Checking prerequisites...');
      const pre = await checkPrereqs(platform, claudePath ? { lfs, claudePath } : { lfs });
      if (pre.ok) return true;
      log('Prerequisites missing:');
      for (const p of pre.problems) log(`  - ${p}`);
      return false;
    };
    if (!args.dryRun && !(await prereqs(plannedVcs === 'git-lfs'))) return 1;
    const defaults = loadConfig(cfgOpts);
    // Output goes through a gate so the token can be typed without echo.
    const gate = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    rl =
      io.ask || args.nonInteractive || args.dryRun
        ? undefined
        : readline.createInterface({ input: process.stdin, output: gate, terminal: Boolean(process.stdin.isTTY) });
    const interactive = Boolean(rl || io.ask);
    const ask = async (question: string, fallback?: string): Promise<string | undefined> => {
      if (io.ask) return (await io.ask(question, fallback)) || fallback;
      if (!rl) return fallback;
      const ans = (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim();
      return ans || fallback;
    };

    const chosen = args.workspace ?? (await ask('Workspace root', defaults.workspaceRoot)) ?? defaults.workspaceRoot;
    const workspace = (platform === 'win32' ? path.win32 : path.posix).resolve(chosen);
    const giteaUrl = args.giteaUrl ?? (await ask('Gitea URL', defaults.giteaUrl));
    const branchPrefix =
      args.branchPrefix ?? (await ask('Branch prefix', defaults.branchPrefix ?? branchPrefixFrom(io.userName ?? osUserName())));
    const artefactsVcs =
      args.artefactsVcs ??
      parseArtefactsVcs(
        (await ask('Version control for the artefacts folder (none, git, git-lfs)', defaults.artefactsVcs)) ?? defaults.artefactsVcs,
        'artefacts version control',
      );
    if (!args.dryRun && artefactsVcs === 'git-lfs' && plannedVcs !== 'git-lfs' && !(await prereqs(true))) return 1;
    // Tracker and docs follow the workspace unless the existing config names other folders.
    const cfg = loadConfig({ ...cfgOpts, env: { ...env, STRAND_WORKSPACE: workspace } });
    cfg.workspaceRoot = workspace;
    cfg.artefactsVcs = artefactsVcs;
    if (giteaUrl) cfg.giteaUrl = giteaUrl;
    if (branchPrefix) cfg.branchPrefix = branchPrefix;
    if (claudeOffPath) cfg.claudePath = claudeOffPath;
    const pp = platform === 'win32' ? path.win32 : path.posix;
    const defaultTracker = pp.join(workspace, 'tracker');
    const beadsDir = env.BEADS_DIR ? pp.resolve(env.BEADS_DIR) : undefined;
    if (args.trackerDir) cfg.trackerDir = pp.resolve(args.trackerDir);
    else if (beadsDir && samePath(cfg.trackerDir, defaultTracker, platform)) cfg.trackerDir = pp.dirname(beadsDir);
    // Claude's own bd calls follow BEADS_DIR; the hooks follow the config. They must name one tracker.
    if (beadsDir && !samePath(beadsDir, pp.join(cfg.trackerDir, '.beads'), platform)) {
      log(`error: BEADS_DIR is ${beadsDir}, but the tracker would be ${cfg.trackerDir}. Nothing was changed.`);
      log(`  Rerun with --tracker-dir "${pp.dirname(beadsDir)}", or change BEADS_DIR.`);
      return 1;
    }
    if (args.trackerDir && !args.initTracker && !existsSync(pp.join(cfg.trackerDir, '.beads'))) {
      log(`error: ${cfg.trackerDir} has no .beads folder. Nothing was changed.`);
      log('  Check the path, or add --init-tracker to create a new Beads database there.');
      return 1;
    }
    const stored: StoredConfig = { ...cfg };
    if (cfg.trackerDir === path.join(workspace, 'tracker')) delete stored.trackerDir;
    if (cfg.docsRepo === path.join(workspace, 'docs')) delete stored.docsRepo;
    const installDeps = needsNpmInstall(repoRoot);
    const prefix = args.prefix ?? 'bd';
    const settings = io.settingsPath ?? path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json');

    if (args.dryRun) {
      const lfs = artefactsVcs === 'git-lfs';
      log('[dry-run] 1. prerequisites: check node>=24, git>=2.40.0, bd>=1.2.2, but>=0.23.5, claude>=2.1.296' + (lfs ? ', git lfs' : '') + (platform === 'win32' ? ', VC++ runtime, GitButler on PATH' : ''));
      log(
        `[dry-run] 2. config: save workspace ${cfg.workspaceRoot}, artefacts vcs ${artefactsVcs}, tracker ${cfg.trackerDir}${cfg.giteaUrl ? `, Gitea ${cfg.giteaUrl}` : ''}${cfg.branchPrefix ? `, branch prefix ${cfg.branchPrefix}` : ''}${cfg.claudePath ? `, claude at ${cfg.claudePath}` : ''}; store Gitea token in the keychain (typed without echo)`,
      );
      const trackerSteps = artefactsVcs === 'none' ? 'plain folder (no git)' : lfs ? 'git init, .gitignore, LFS attributes' : 'git init, .gitignore';
      const init = existsSync(path.join(cfg.trackerDir, '.beads')) ? 'bd init skipped (.beads exists)' : `bd init --prefix ${prefix}`;
      log(`[dry-run] 3. tracker: ${trackerSteps}, ${init}, custom types in ${cfg.trackerDir}`);
      log(`[dry-run] 4. docs repo: ${cfg.docsRepo}`);
      log(`[dry-run] 5. lfs: ${lfs ? 'git lfs install --local (tracker and docs repos)' : 'skipped (artefacts vcs is not git-lfs)'}`);
      log(`[dry-run] 6. retention: back up ${settings} to ${settings}.pre-strand (if no backup exists), then cleanupPeriodDays=365`);
      log(
        `[dry-run] 7. npm: ${installDeps ? NPM_INSTALL.join(' ') : 'npm install skipped (node_modules up to date)'}; npm run build:ui; npm link (strand on PATH) in ${repoRoot}`,
      );
      log(`[dry-run] 8. plugin: remove the pre-rename sdlc@sdlc-cockpit plugin and marketplace if present; claude plugin marketplace add ${repoRoot}; claude plugin install (or update) strand@strand`);
      log(`[dry-run] 9. hooks: remove entries whose command contains ${OLD_HOOK} from ${settings} (other entries stay)`);
      log('[dry-run] 10. test command: list workspace repos whose CLAUDE.md has no Test command line');
      return 0;
    }

    saveConfig(stored, cfgOpts);
    log(`Config saved (workspace ${cfg.workspaceRoot}).`);

    let token = env.STRAND_GITEA_TOKEN;
    if (!token && interactive) {
      const secret =
        io.readSecret ??
        (rl
          ? async (q: string) => {
              const reply = rl!.question(`${q}: `);
              muted = true;
              try {
                return await reply;
              } finally {
                muted = false;
                process.stdout.write('\n');
              }
            }
          : async (q: string) => (await ask(q)) ?? '');
      token = (await secret('Gitea token (blank to skip)')).trim() || undefined;
    }
    if (token) {
      setToken(token);
      log('Gitea token stored in the OS keychain.');
    } else {
      log('No Gitea token stored; set STRAND_GITEA_TOKEN or re-run to add one.');
    }

    log(`Setting up tracker at ${cfg.trackerDir}...`);
    await ensureTracker(cfg.trackerDir, { prefix, vcs: artefactsVcs });
    log(`Setting up docs repo at ${cfg.docsRepo}...`);
    await ensureDocsRepo(cfg.docsRepo);

    if (artefactsVcs === 'git-lfs') {
      for (const repo of [cfg.trackerDir, cfg.docsRepo]) {
        const lfs = await runner('git', ['lfs', 'install', '--local'], { cwd: repo });
        if (lfs.code !== 0) log(`git lfs install --local failed in ${repo}: ${lfs.stderr.trim()}`);
      }
    }

    // The backup comes first so it holds settings.json exactly as it was before strand touched it.
    if (backupSettings(settings)) log(`Backed up ${settings} to ${settings}.pre-strand.`);
    raiseTranscriptRetention(settings, 365);
    log(`Transcript retention set to 365 days in ${settings}.`);

    // Only when missing or stale, and with dev dependencies (vite builds the UI): never prune a developer checkout.
    if (installDeps) {
      const npm = await runner('npm', NPM_INSTALL.slice(1), { cwd: repoRoot });
      if (npm.code !== 0) throw new Error(`npm install failed: ${npm.stderr.trim()}`);
    }
    const ui = await runner('npm', ['run', 'build:ui'], { cwd: repoRoot });
    if (ui.code !== 0) throw new Error(`npm run build:ui failed: ${ui.stderr.trim() || ui.stdout.trim()}`);
    log('Cockpit UI built.');
    await linkCli(repoRoot, runner, log);

    await installPlugin(repoRoot, runner, cfg.claudePath ?? 'claude');
    log('Plugin strand installed.');

    const removed = removeOldWorkflowHooks(settings);
    log(removed > 0 ? `Removed ${removed} old bash workflow hook entries from ${settings}.` : 'No old bash workflow hook entries in settings.json.');
    const lacking = reposWithoutTestCommand(workspace);
    if (lacking.length > 0) {
      log('Repos whose CLAUDE.md has no "Test command" line (add one to each, ADR 0008):');
      for (const r of lacking) log(`  - ${r}`);
    }

    log('');
    log('Next steps:');
    log('  - In each code repo run: but agent setup');
    log('  - and: but config push-remote origin');
    return 0;
  } catch (e) {
    log(`error: ${(e as Error).message}`);
    return 1;
  } finally {
    rl?.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyLegacyEnv(process.env);
  process.exitCode = await main(process.argv.slice(2));
}
