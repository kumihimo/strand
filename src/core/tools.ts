import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { run, ToolMissingError } from './exec.ts';

export { ToolMissingError };

export type ToolName = 'bd' | 'but' | 'git' | 'claude' | 'gh';

/** The oldest version of each tool the system is tested with. */
export const MINIMUM_VERSIONS: Record<ToolName, string> = { git: '2.40.0', bd: '1.2.2', but: '0.23.5', claude: '2.1.296', gh: '2.46.0' };

/** Every tool first-run setup checks, in the order it lists them. */
export const TOOL_NAMES: readonly ToolName[] = ['git', 'bd', 'but', 'claude', 'gh'];
/** The tools Strand cannot work without. `gh` is needed only for repos on GitHub. */
export const REQUIRED_TOOLS: readonly ToolName[] = ['git', 'bd', 'but', 'claude'];

/** Numeric per-component comparison: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Check that a tool is installed and at least minVersion; returns the found version. */
export async function requireTool(
  name: ToolName,
  minVersion: string,
  opts: { path?: string } = {},
): Promise<string> {
  const exe = opts.path ?? name;
  const hint = `Install ${name} and make sure it is on PATH`;
  let out;
  try {
    out = await run(exe, ['--version']);
  } catch (e) {
    if (e instanceof ToolMissingError) throw new ToolMissingError(name, hint);
    throw e;
  }
  const m = /\d+\.\d+\.\d+/.exec(out.stdout + '\n' + out.stderr);
  if (out.code !== 0 || !m) {
    throw new ToolMissingError(name, hint, `${name} --version failed or printed no version. ${hint}`);
  }
  const found = m[0];
  if (compareVersions(found, minVersion) < 0) {
    throw new ToolMissingError(
      name,
      `Upgrade ${name} to ${minVersion} or newer`,
      `${name} ${found} is older than the required minimum ${minVersion}`,
    );
  }
  return found;
}

/** What a probe found: `ok`, `missing` (not on the configured path, PATH or a known folder) or `old` (too old, or no version). */
export type ToolState = {
  name: ToolName;
  status: 'ok' | 'missing' | 'old';
  min: string;
  found?: string;
  /** The absolute path of the program that was asked, when one was found. */
  path?: string;
  required: boolean;
};

export type ProbeOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home: string;
  /** The app's own tools folder, where setup unpacks `gh` (`tools` beside the config file). */
  toolsDir: string;
  /** Paths from the config (`claudePath`, `butPath`, `ghPath`), asked first. */
  configured?: Partial<Record<ToolName, string>>;
  exists?: (p: string) => boolean;
  /** The version `<exe> --version` prints, undefined when it prints none; throws ToolMissingError when it cannot start. */
  version?: (exe: string) => Promise<string | undefined>;
};

const isFile = (p: string): boolean => {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
};

async function defaultVersion(exe: string): Promise<string | undefined> {
  const out = await run(exe, ['--version'], { timeoutMs: 15_000 });
  const m = /\d+\.\d+\.\d+/.exec(out.stdout + '\n' + out.stderr);
  return out.code === 0 && m ? m[0] : undefined;
}

function exeNames(name: ToolName, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [name];
  return name === 'claude' ? ['claude.exe', 'claude.cmd'] : [`${name}.exe`];
}

/**
 * The folders each tool's official installer puts it in, for when PATH does not have it yet (a fresh install
 * reaches PATH only in new shells). `git` and `bd` have none: they come with the app or from PATH.
 */
export function knownPaths(
  name: ToolName,
  o: { platform: NodeJS.Platform; home: string; toolsDir: string; env?: NodeJS.ProcessEnv },
): string[] {
  const win = o.platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const exe = exeNames(name, o.platform)[0]!;
  switch (name) {
    case 'claude':
      return [p.join(o.home, '.local', 'bin', exe)];
    case 'but':
      if (win) return [p.join(o.env?.ProgramFiles || 'C:\\Program Files', 'GitButler', exe)];
      return [
        p.join(o.home, '.local', 'bin', exe),
        '/usr/local/bin/but',
        ...(o.platform === 'darwin' ? ['/Applications/GitButler.app/Contents/MacOS/but'] : []),
      ];
    case 'gh':
      return [p.join(o.toolsDir, 'gh', 'bin', exe)];
    default:
      return [];
  }
}

function onPath(name: ToolName, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | undefined {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const dirs = (env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter((d) => d && p.isAbsolute(d));
  for (const d of dirs) for (const n of exeNames(name, platform)) if (exists(p.join(d, n))) return p.join(d, n);
  return undefined;
}

/** Find one tool (configured path, then PATH, then its installer's folder) and compare its version with the minimum. */
export async function probeTool(name: ToolName, o: ProbeOptions): Promise<ToolState> {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const exists = o.exists ?? isFile;
  const version = o.version ?? defaultVersion;
  const min = MINIMUM_VERSIONS[name];
  const base = { name, min, required: REQUIRED_TOOLS.includes(name) };
  const configured = o.configured?.[name];
  const candidates = [
    ...(configured && exists(configured) ? [configured] : []),
    onPath(name, platform, env, exists),
    ...knownPaths(name, { platform, home: o.home, toolsDir: o.toolsDir, env }).filter(exists),
  ].filter((c): c is string => c !== undefined);
  for (const exe of candidates) {
    let found: string | undefined;
    try {
      found = await version(exe);
    } catch {
      continue;
    }
    if (found === undefined) return { ...base, status: 'old', path: exe };
    return { ...base, status: compareVersions(found, min) < 0 ? 'old' : 'ok', found, path: exe };
  }
  return { ...base, status: 'missing' };
}

/** Probe every tool in TOOL_NAMES. */
export async function probeTools(o: ProbeOptions): Promise<ToolState[]> {
  return Promise.all(TOOL_NAMES.map((n) => probeTool(n, o)));
}
