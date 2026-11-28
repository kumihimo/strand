import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_DEFAULT, CLAUDE_EFFORTS, DEFAULT_CLAUDE_EFFORT, DEFAULT_CLAUDE_MODEL, isClaudeEffort, isClaudeModel } from './naming.ts';

/** Version control of the tracker's artefacts folder (ADR 0009). */
export type ArtefactsVcs = 'none' | 'git' | 'git-lfs';
export const ARTEFACTS_VCS: readonly ArtefactsVcs[] = ['none', 'git', 'git-lfs'];

/** What a WIP limit hit does: show the reason, or deny. */
export type WipMode = 'warn' | 'refuse';
export const WIP_MODES: readonly WipMode[] = ['warn', 'refuse'];

/** How the cockpit opens its UI: the Strand desktop (Electron) window, a browser tab, or not at all (ADR 0022). */
export type CockpitWindow = 'app' | 'tab' | 'none';
export const COCKPIT_WINDOWS: readonly CockpitWindow[] = ['app', 'tab', 'none'];

export type CockpitConfig = { window: CockpitWindow; maxSessions: number };

export type Config = {
  workspaceRoot: string;
  trackerDir: string;
  docsRepo: string;
  giteaUrl?: string;
  wip: { build: number; review: number; mode: WipMode };
  artefactsVcs: ArtefactsVcs;
  branchPrefix?: string;
  claudePath?: string;
  /** Model for `strand work` sessions: an alias or id, or `default` for no flag. loadConfig always sets it. */
  claudeModel?: string;
  /** Effort for `strand work` sessions: low, medium, high, xhigh, max, or `default` for no flag. loadConfig always sets it. */
  claudeEffort?: string;
  cockpit: CockpitConfig;
};

/** Validate a cockpit.window value (from the config file or the env). */
export function parseCockpitWindow(v: unknown, where: string): CockpitWindow {
  if (typeof v === 'string' && (COCKPIT_WINDOWS as readonly string[]).includes(v)) return v as CockpitWindow;
  throw new Error(`${where}: cockpit.window must be one of ${COCKPIT_WINDOWS.join(', ')}, got ${String(v)}`);
}

/** Validate a cockpit.maxSessions value: a positive whole number (a numeric string is accepted for the env). */
export function parseMaxSessions(v: unknown, where: string): number {
  const n = typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
  if (typeof n === 'number' && Number.isInteger(n) && n > 0) return n;
  throw new Error(`${where}: cockpit.maxSessions must be a positive whole number, got ${String(v)}`);
}

/** Validate an artefactsVcs value (from the config file, the env or the installer flag). */
export function parseArtefactsVcs(v: unknown, where: string): ArtefactsVcs {
  if (typeof v === 'string' && (ARTEFACTS_VCS as readonly string[]).includes(v)) return v as ArtefactsVcs;
  throw new Error(`${where}: artefactsVcs must be one of ${ARTEFACTS_VCS.join(', ')}, got ${String(v)}`);
}

/** Validate a wip.mode value (from the config file or the env). */
export function parseWipMode(v: unknown, where: string): WipMode {
  if (typeof v === 'string' && (WIP_MODES as readonly string[]).includes(v)) return v as WipMode;
  throw new Error(`${where}: wip.mode must be one of ${WIP_MODES.join(', ')}, got ${String(v)}`);
}

/** What is written to disk: trackerDir/docsRepo only when they are not the defaults derived from workspaceRoot. */
export type StoredConfig = Omit<Config, 'trackerDir' | 'docsRepo' | 'cockpit'> &
  Partial<Pick<Config, 'trackerDir' | 'docsRepo' | 'cockpit'>>;

export type ConfigOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
};

function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Env var prefixes: the current one, and the one read as a fallback for one release (ADR 0021). */
export const ENV_PREFIX = 'STRAND_';
export const LEGACY_ENV_PREFIX = 'SDLC_';

let legacyWarned = false;

/** Let the next applyLegacyEnv warn again. For tests only. */
export function resetLegacyEnvWarning(): void {
  legacyWarned = false;
}

/**
 * Fill each unset `STRAND_<X>` from a non-empty `SDLC_<X>` in `env` (changed in place and returned), so the
 * rest of the code reads only `STRAND_*`. The old variables are left as they are. The first time a process
 * uses any old variable, one deprecation line goes to stderr naming those it read.
 */
export function applyLegacyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const used: string[] = [];
  for (const k of Object.keys(env)) {
    if (!k.startsWith(LEGACY_ENV_PREFIX) || !env[k]) continue;
    const next = ENV_PREFIX + k.slice(LEGACY_ENV_PREFIX.length);
    if (env[next]) continue;
    env[next] = env[k];
    used.push(k);
  }
  if (used.length > 0 && !legacyWarned) {
    legacyWarned = true;
    console.error(
      `warning: SDLC_* environment variables are deprecated; rename them to STRAND_* (read: ${used.sort().join(', ')}). ` +
        'They stop working in the next release.',
    );
  }
  return env;
}

/** A copy of `env` with the SDLC_* fallbacks applied; the caller's object is not changed. */
function withLegacy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return applyLegacyEnv({ ...env });
}

/** Relative STRAND_CONFIG_DIR values already warned about, so each is reported once per process. */
const warnedConfigDirs = new Set<string>();

/** The per-platform user config folder that holds the `<name>` folder. */
function userConfigFile(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string, name: string): string {
  const p = pathFor(platform);
  if (platform === 'win32') return p.join(env.APPDATA ?? p.join(home, 'AppData', 'Roaming'), name, 'config.json');
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', name, 'config.json');
  return p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), name, 'config.json');
}

/**
 * The Strand config file. `STRAND_CONFIG_DIR` (an absolute folder) wins: the file is `<dir>/config.json`, and the
 * cockpit key file sits beside it. It moves the config without faking `APPDATA` or `XDG_CONFIG_HOME`, which
 * child processes (Claude Code in a cockpit terminal) would inherit. A relative value is ignored with one
 * warning line. Otherwise `strand/config.json` in the per-platform user config folder.
 */
export function configPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  const p = pathFor(platform);
  const dir = withLegacy(env).STRAND_CONFIG_DIR;
  if (dir) {
    if (p.isAbsolute(dir)) return p.join(dir, 'config.json');
    if (!warnedConfigDirs.has(dir)) {
      warnedConfigDirs.add(dir);
      console.error(`warning: STRAND_CONFIG_DIR ${dir} is not an absolute path; ignored`);
    }
  }
  return userConfigFile(platform, env, home, 'strand');
}

/**
 * Where the config lived before the rename to Strand: `sdlc/config.json` in the user config folder. Undefined
 * when a config dir override is in force, since that folder was never renamed.
 */
export function legacyConfigPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string | undefined {
  const file = configPath(platform, env, home);
  const legacy = userConfigFile(platform, env, home, 'sdlc');
  return file === userConfigFile(platform, env, home, 'strand') ? legacy : undefined;
}

/**
 * The user's home folder from the env being used, so a test's sandboxed HOME or USERPROFILE is honoured
 * in-process: USERPROFILE then HOME on win32, HOME elsewhere, else the OS home.
 */
export function homeDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const envHome = platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME;
  return envHome || os.homedir();
}

function resolve(opts: ConfigOptions) {
  const platform = opts.platform ?? process.platform;
  const env = withLegacy(opts.env ?? process.env);
  const home = opts.home ?? homeDir(env, platform);
  return { platform, env, home, file: configPath(platform, env, home), p: pathFor(platform) };
}

/**
 * A Claude session setting: the env value, else the file value, else the default. An invalid value is
 * ignored with one warning line on stderr and the default is used.
 */
function claudeSetting(
  key: string,
  envName: string,
  env: NodeJS.ProcessEnv,
  raw: Record<string, unknown>,
  file: string,
  valid: (v: unknown) => boolean,
  problem: string,
  fallback: string,
): string {
  const fromEnv = env[envName];
  const value = fromEnv || raw[key];
  if (value === undefined || value === '') return fallback;
  if (valid(value)) return value as string;
  const what = fromEnv ? `${envName} "${value}"` : `${key} "${String(value)}" in ${file}`;
  console.error(`warning: ${what} ${problem}; using ${fallback}`);
  return fallback;
}

/** Copy the pre-rename config to `file` when `file` is missing and the old one exists. The old file is kept. */
function adoptLegacyConfig(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string, file: string): void {
  const legacy = legacyConfigPath(platform, env, home);
  if (!legacy || existsSync(file) || !existsSync(legacy)) return;
  mkdirSync(pathFor(platform).dirname(file), { recursive: true });
  copyFileSync(legacy, file);
}

/** The config file's JSON object as written, `{}` when the file is missing. A file that is not a JSON object throws. */
export function readRawConfig(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot read config file ${file}: ${(e as Error).message}`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Malformed config file ${file}: ${(e as Error).message}`);
  }
}

export function loadConfig(opts: ConfigOptions = {}): Config {
  const { platform, env, home, file, p } = resolve(opts);
  adoptLegacyConfig(platform, env, home, file);
  const raw = readRawConfig(file);

  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const defaultRoot = platform === 'win32' ? 'C:\\dev' : p.join(home, 'dev');
  const workspaceRoot = env.STRAND_WORKSPACE || str(raw.workspaceRoot) || defaultRoot;
  // With an env workspace override, derived dirs follow it unless the file sets them explicitly.
  const trackerDir = str(raw.trackerDir) ?? p.join(workspaceRoot, 'tracker');
  const docsRepo = str(raw.docsRepo) ?? p.join(workspaceRoot, 'docs');
  const giteaUrl = env.STRAND_GITEA_URL || str(raw.giteaUrl);

  const wipRaw = (raw.wip && typeof raw.wip === 'object' ? raw.wip : {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

  const vcsRaw = env.STRAND_ARTEFACTS_VCS || raw.artefactsVcs;
  const artefactsVcs =
    vcsRaw === undefined ? 'none' : parseArtefactsVcs(vcsRaw, env.STRAND_ARTEFACTS_VCS ? 'STRAND_ARTEFACTS_VCS' : file);

  const modeRaw = env.STRAND_WIP_MODE || wipRaw.mode;
  const mode = modeRaw === undefined ? 'warn' : parseWipMode(modeRaw, env.STRAND_WIP_MODE ? 'STRAND_WIP_MODE' : file);
  const branchPrefix = env.STRAND_BRANCH_PREFIX || str(raw.branchPrefix);
  const claudePath = env.STRAND_CLAUDE_PATH || str(raw.claudePath);
  const claudeModel = claudeSetting('claudeModel', 'STRAND_CLAUDE_MODEL', env, raw, file, isClaudeModel, 'is not a valid model name', DEFAULT_CLAUDE_MODEL);
  const claudeEffort = claudeSetting(
    'claudeEffort', 'STRAND_CLAUDE_EFFORT', env, raw, file, isClaudeEffort,
    `is not one of ${[...CLAUDE_EFFORTS, CLAUDE_DEFAULT].join(', ')}`, DEFAULT_CLAUDE_EFFORT,
  );

  const cockpitRaw = (raw.cockpit && typeof raw.cockpit === 'object' ? raw.cockpit : {}) as Record<string, unknown>;
  const windowRaw = env.STRAND_COCKPIT_WINDOW || cockpitRaw.window;
  const cockpitWindow =
    windowRaw === undefined ? 'app' : parseCockpitWindow(windowRaw, env.STRAND_COCKPIT_WINDOW ? 'STRAND_COCKPIT_WINDOW' : file);
  const sessionsRaw = env.STRAND_COCKPIT_MAX_SESSIONS || cockpitRaw.maxSessions;
  const maxSessions =
    sessionsRaw === undefined ? 4 : parseMaxSessions(sessionsRaw, env.STRAND_COCKPIT_MAX_SESSIONS ? 'STRAND_COCKPIT_MAX_SESSIONS' : file);

  const cfg: Config = {
    workspaceRoot,
    trackerDir,
    docsRepo,
    wip: { build: num(wipRaw.build, 3), review: num(wipRaw.review, 3), mode },
    artefactsVcs,
    claudeModel,
    claudeEffort,
    cockpit: { window: cockpitWindow, maxSessions },
  };
  if (giteaUrl) cfg.giteaUrl = giteaUrl;
  if (branchPrefix) cfg.branchPrefix = branchPrefix;
  if (claudePath) cfg.claudePath = claudePath;
  return cfg;
}

export function saveConfig(cfg: StoredConfig, opts: ConfigOptions = {}): void {
  const { file, p } = resolve(opts);
  mkdirSync(p.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}
