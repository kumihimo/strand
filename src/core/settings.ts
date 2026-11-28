import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  ARTEFACTS_VCS, COCKPIT_WINDOWS, ENV_PREFIX, LEGACY_ENV_PREFIX, WIP_MODES, configPath, homeDir, loadConfig, readRawConfig,
  type Config, type ConfigOptions,
} from './config.ts';
import { CLAUDE_DEFAULT, CLAUDE_EFFORTS, isClaudeEffort, isClaudeModel } from './naming.ts';

/**
 * The Settings screen's view of `config.json` (ADR 0028). One writer for every caller: values are checked here
 * and written atomically; env overrides are reported and never written.
 */

export type SettingKind = 'path' | 'url' | 'text' | 'number' | 'choice';

type Spec = {
  key: string;
  label: string;
  kind: SettingKind;
  /** The env variable, without its prefix, that overrides the file (`STRAND_<env>`, or the same name under LEGACY_ENV_PREFIX). */
  env?: string;
  /** Read once when the cockpit starts, so a change applies after a restart. */
  restart: boolean;
  choices?: readonly string[];
  /** Why a value is refused, or undefined when it is fine. Only called for a value that is not empty. */
  check: (v: unknown, p: typeof path.posix) => string | undefined;
  effective: (c: Config) => string | number | undefined;
};

const MAX_PATH = 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;
const BRANCH_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

function absPath(v: unknown, p: typeof path.posix): string | undefined {
  if (typeof v !== 'string') return 'must be text';
  if (v.length > MAX_PATH) return `must be at most ${MAX_PATH} characters`;
  if (CONTROL.test(v)) return 'must not contain control characters';
  if (!p.isAbsolute(v)) return 'must be an absolute path';
  return undefined;
}

function existingFile(v: unknown, p: typeof path.posix): string | undefined {
  const bad = absPath(v, p);
  if (bad) return bad;
  try {
    if (statSync(v as string).isFile()) return undefined;
    return 'must name a file, not a folder';
  } catch {
    return 'no file at that path';
  }
}

function httpUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 2048 || CONTROL.test(v)) return 'must be an http or https address';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return 'must be an http or https address';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'must be an http or https address';
  if (u.username || u.password) return 'must not carry a user name or password';
  return undefined;
}

const wholeNumber = (min: number, max: number) => (v: unknown) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? undefined : `must be a whole number from ${min} to ${max}`;

const oneOf = (choices: readonly string[]) => (v: unknown) =>
  typeof v === 'string' && choices.includes(v) ? undefined : `must be one of ${choices.join(', ')}`;

const EFFORTS = [...CLAUDE_EFFORTS, CLAUDE_DEFAULT];

const SPECS: readonly Spec[] = [
  { key: 'workspaceRoot', label: 'Workspace folder', kind: 'path', env: 'WORKSPACE', restart: true, check: absPath, effective: (c) => c.workspaceRoot },
  { key: 'trackerDir', label: 'Tracker folder', kind: 'path', restart: true, check: absPath, effective: (c) => c.trackerDir },
  { key: 'docsRepo', label: 'Docs repo folder', kind: 'path', restart: true, check: absPath, effective: (c) => c.docsRepo },
  { key: 'giteaUrl', label: 'Gitea address', kind: 'url', env: 'GITEA_URL', restart: true, check: httpUrl, effective: (c) => c.giteaUrl },
  { key: 'wip.build', label: 'WIP limit: Build', kind: 'number', restart: false, check: wholeNumber(1, 99), effective: (c) => c.wip.build },
  { key: 'wip.review', label: 'WIP limit: Review', kind: 'number', restart: false, check: wholeNumber(1, 99), effective: (c) => c.wip.review },
  { key: 'wip.mode', label: 'WIP limit mode', kind: 'choice', choices: WIP_MODES, env: 'WIP_MODE', restart: false, check: oneOf(WIP_MODES), effective: (c) => c.wip.mode },
  { key: 'artefactsVcs', label: 'Artefacts version control', kind: 'choice', choices: ARTEFACTS_VCS, env: 'ARTEFACTS_VCS', restart: false, check: oneOf(ARTEFACTS_VCS), effective: (c) => c.artefactsVcs },
  {
    key: 'branchPrefix', label: 'Branch prefix', kind: 'text', env: 'BRANCH_PREFIX', restart: false,
    check: (v) => (typeof v === 'string' && BRANCH_PREFIX.test(v) ? undefined : 'must be letters, digits, ".", "_" or "-", starting with a letter or digit, at most 40'),
    effective: (c) => c.branchPrefix,
  },
  { key: 'claudePath', label: 'Claude Code program', kind: 'path', env: 'CLAUDE_PATH', restart: false, check: existingFile, effective: (c) => c.claudePath },
  { key: 'butPath', label: 'GitButler program', kind: 'path', env: 'BUT_PATH', restart: true, check: existingFile, effective: (c) => c.butPath },
  { key: 'ghPath', label: 'GitHub CLI program', kind: 'path', env: 'GH_PATH', restart: true, check: existingFile, effective: (c) => c.ghPath },
  {
    key: 'claudeModel', label: 'Claude model', kind: 'text', env: 'CLAUDE_MODEL', restart: false,
    check: (v) => (isClaudeModel(v) ? undefined : 'must be a model alias or id, or default'),
    effective: (c) => c.claudeModel,
  },
  {
    key: 'claudeEffort', label: 'Claude effort', kind: 'choice', choices: EFFORTS, env: 'CLAUDE_EFFORT', restart: false,
    check: (v) => (isClaudeEffort(v) ? undefined : `must be one of ${EFFORTS.join(', ')}`),
    effective: (c) => c.claudeEffort,
  },
  { key: 'cockpit.window', label: 'Cockpit opens in', kind: 'choice', choices: COCKPIT_WINDOWS, env: 'COCKPIT_WINDOW', restart: true, check: oneOf(COCKPIT_WINDOWS), effective: (c) => c.cockpit.window },
  { key: 'cockpit.maxSessions', label: 'Most live terminals', kind: 'number', env: 'COCKPIT_MAX_SESSIONS', restart: true, check: wholeNumber(1, 32), effective: (c) => c.cockpit.maxSessions },
];

export const SETTING_KEYS: readonly string[] = SPECS.map((s) => s.key);

export type SettingField = {
  key: string;
  label: string;
  kind: SettingKind;
  choices?: readonly string[];
  /** What config.json holds, as written; undefined when the key is absent. */
  file: unknown;
  /** The value in force: the env override, else the file, else the default. */
  effective: string | number | undefined;
  /** The env variable that overrides the file; the field is read-only while it is set. */
  envVar?: string;
  restart: boolean;
};

export type SettingsView = { path: string; fields: SettingField[] };

/** Refused settings: a message per field key, or a body-level message in `message`. Nothing was written. */
export class SettingsError extends Error {
  readonly fields: Record<string, string>;
  constructor(message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = 'SettingsError';
    this.fields = fields;
  }
}

function where(opts: ConfigOptions) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homeDir(env, platform);
  return { platform, env, file: configPath(platform, env, home), p: platform === 'win32' ? path.win32 : path.posix };
}

function envVarOf(spec: Spec, env: NodeJS.ProcessEnv): string | undefined {
  if (!spec.env) return undefined;
  for (const name of [ENV_PREFIX + spec.env, LEGACY_ENV_PREFIX + spec.env]) if (env[name]) return name;
  return undefined;
}

function getIn(raw: Record<string, unknown>, key: string): unknown {
  const [head, tail] = key.split('.') as [string, string | undefined];
  if (tail === undefined) return raw[head];
  const inner = raw[head];
  return inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>)[tail] : undefined;
}

function setIn(raw: Record<string, unknown>, key: string, value: unknown): void {
  const [head, tail] = key.split('.') as [string, string | undefined];
  if (tail === undefined) {
    if (value === undefined) delete raw[head];
    else raw[head] = value;
    return;
  }
  const cur = raw[head];
  const inner: Record<string, unknown> = cur && typeof cur === 'object' && !Array.isArray(cur) ? { ...(cur as Record<string, unknown>) } : {};
  if (value === undefined) delete inner[tail];
  else inner[tail] = value;
  if (Object.keys(inner).length) raw[head] = inner;
  else delete raw[head];
}

/** Every setting with its file value, effective value, env override and restart flag. */
export function readSettings(opts: ConfigOptions = {}): SettingsView {
  const { env, file } = where(opts);
  const cfg = loadConfig(opts);
  const raw = readRawConfig(file);
  return {
    path: file,
    fields: SPECS.map((s) => {
      const f: SettingField = { key: s.key, label: s.label, kind: s.kind, file: getIn(raw, s.key), effective: s.effective(cfg), restart: s.restart };
      if (s.choices) f.choices = s.choices;
      const envVar = envVarOf(s, env);
      if (envVar) f.envVar = envVar;
      return f;
    }),
  };
}

/**
 * Apply `patch` (setting key to value; `''` or `null` removes the key, so the default applies) to config.json.
 * Every value is checked first; on any problem nothing is written. Keys the file holds that are not settings
 * are kept. The file is replaced atomically: a temp file in the same folder, then a rename.
 */
export function writeSettings(patch: Record<string, unknown>, opts: ConfigOptions = {}): SettingsView {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new SettingsError('settings must be an object');
  const { env, file, p } = where(opts);
  const specs = new Map(SPECS.map((s) => [s.key, s]));
  // Never echo an unknown key: it is whatever the caller sent.
  if (Object.keys(patch).some((k) => !specs.has(k))) throw new SettingsError('unknown setting in body');

  const problems: Record<string, string> = {};
  const changes: [string, unknown][] = [];
  for (const [key, value] of Object.entries(patch)) {
    const spec = specs.get(key) as Spec;
    const envVar = envVarOf(spec, env);
    if (envVar) {
      problems[key] = `set by ${envVar}; unset it to change it here`;
      continue;
    }
    if (value === '' || value === null) {
      changes.push([key, undefined]);
      continue;
    }
    const bad = spec.check(value, p);
    if (bad) problems[key] = bad;
    else changes.push([key, value]);
  }
  if (Object.keys(problems).length) throw new SettingsError('invalid settings', problems);

  const raw = readRawConfig(file);
  for (const [key, value] of changes) setIn(raw, key, value);
  writeAtomic(file, JSON.stringify(raw, null, 2) + '\n');
  return readSettings(opts);
}

function writeAtomic(file: string, text: string): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Copy the values that apply at once from `next` into `cfg`, in place, so every holder of `cfg` sees them.
 * The values marked `restart` (folders, Gitea, the cockpit's window and terminal limit) keep their start values.
 */
export function applyLiveSettings(cfg: Config, next: Config): void {
  cfg.wip = { ...next.wip };
  cfg.artefactsVcs = next.artefactsVcs;
  cfg.claudeModel = next.claudeModel;
  cfg.claudeEffort = next.claudeEffort;
  for (const k of ['branchPrefix', 'claudePath', 'butPath', 'ghPath'] as const) {
    if (next[k] === undefined) delete cfg[k];
    else cfg[k] = next[k];
  }
}
