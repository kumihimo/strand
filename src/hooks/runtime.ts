// Hook runtime: read the hook JSON, run the handler under a deadline, print what Claude Code expects.
// Never fails: an error or a timeout goes to stderr and the exit code is 0, so the action is allowed.
// Also builds the gate's dependencies. Only config.ts is loaded up front; bd and git load on first use.
import os from 'node:os';
import path from 'node:path';
import { applyLegacyEnv, homeDir, loadConfig } from '../core/config.ts';
import type { Config } from '../core/config.ts';
import type { Bead } from '../core/bd.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { Beads } from '../core/bd.ts';
import type { approveSpec, recordBaseline } from '../core/approve.ts';

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SessionEnd' | 'Notification';
export type HookResult = { additionalContext?: string; sessionTitle?: string; deny?: string; block?: string; systemMessage?: string };

export type HookIO = {
  stdin: AsyncIterable<Buffer | string>;
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  exit(code: number): void;
};

const MAX_STDIN = 1_000_000;
/**
 * Whole-handler deadlines. SessionEnd shares a 1.5 s budget with Claude Code; PreToolUse runs under a 5 s hook timeout.
 * Notification only marks the session index (one small file), under a 2 s hook timeout.
 */
export const DEADLINE_MS: Record<HookEvent, number> = {
  SessionStart: 8000,
  UserPromptSubmit: 8000,
  PreToolUse: 3000,
  PostToolUse: 8000,
  Stop: 15000,
  SessionEnd: 1200,
  Notification: 1200,
};

async function readAll(stdin: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of stdin) {
    const b = typeof c === 'string' ? Buffer.from(c) : c;
    size += b.length;
    if (size > MAX_STDIN) throw new Error('stdin exceeds 1 MB');
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The JSON the bash hook prints for the same result, or undefined when there is nothing to say. */
function output(event: HookEvent, r: HookResult): Record<string, unknown> | undefined {
  const specific: Record<string, unknown> = {};
  if (r.deny && event === 'PreToolUse') {
    specific.permissionDecision = 'deny';
    specific.permissionDecisionReason = r.deny;
  }
  if (r.additionalContext) specific.additionalContext = r.additionalContext;
  if (r.sessionTitle) specific.sessionTitle = r.sessionTitle;
  const out: Record<string, unknown> = {};
  if (Object.keys(specific).length > 0) out.hookSpecificOutput = { hookEventName: event, ...specific };
  if (r.block) {
    out.decision = 'block';
    out.reason = r.block;
  }
  if (r.systemMessage) out.systemMessage = r.systemMessage;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Read the hook JSON from stdin, run the handler, print its result. Errors go to stderr; exit is always 0. */
export async function runHook<I = any>(
  handler: (input: I) => Promise<HookResult | void>,
  event: HookEvent,
  io: HookIO = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, exit: (c) => process.exit(c) },
  opts: { deadlineMs?: number } = {},
): Promise<void> {
  const ms = opts.deadlineMs ?? DEADLINE_MS[event];
  // A session started by a pre-rename `sdlc work` carries SDLC_BEAD_ID and SDLC_SPEC_FORMAT (ADR 0021).
  applyLegacyEnv(process.env);
  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    });
    deadline.catch(() => {});
    const result = await Promise.race([(async () => handler(JSON.parse(await readAll(io.stdin)) as I))(), deadline]);
    const out = result ? output(event, result) : undefined;
    if (out) io.stdout.write(JSON.stringify(out) + '\n');
  } catch (e) {
    io.stderr.write(`strand hook ${event}: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  clearTimeout(timer);
  io.exit(0);
}

// --- gate dependencies ------------------------------------------------------------------------

export type GateDeps = {
  trackerDir: string;
  workspaceRoot: string;
  home: string;
  tmpDirs: string[];
  wip: Config['wip'];
  snapshot(): Promise<Snapshot>;
  show(id: string): Promise<Bead>;
  branchOpen(repoDir: string, name: string): Promise<boolean>;
  refExists(repoDir: string, name: string): Promise<boolean>;
  mergedPrNumbers(repoDir: string, n: number[]): Promise<number[]>;
  /** owner/repo of the `origin` remote, or undefined when there is none. */
  remoteRepo(repoDir: string): Promise<string | undefined>;
};

/** owner/repo from a remote URL, https, ssh or scp form (bash `repo_of`). */
export function repoOfUrl(url: string): string | undefined {
  return /[/:]([^/:]+\/[^/:]+)$/.exec(url.trim().replace(/\.git$/, ''))?.[1];
}

/** bd and git calls made by a hook must end inside the PreToolUse deadline. */
const CALL_TIMEOUT_MS = 2500;

/** git's stdout on exit 0, undefined on any other exit code. Rejects when git cannot run or times out. */
async function git(repoDir: string, args: string[]): Promise<string | undefined> {
  const { run } = await import('../core/exec.ts');
  const r = await run('git', args, { cwd: repoDir, timeoutMs: CALL_TIMEOUT_MS });
  return r.code === 0 ? r.stdout : undefined;
}

/** The `origin/HEAD` target, else `origin/main` (same rule as gitfacts `defaultRemoteBranch`). */
async function defaultBranch(repoDir: string): Promise<string> {
  return (await git(repoDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.trim() || 'origin/main';
}

/** Real gate dependencies. Config loads on first use of a config field; bd and git modules on first call. */
export function buildGateDeps(env: NodeJS.ProcessEnv = process.env): GateDeps {
  let cfg: Config | undefined;
  const config = () => (cfg ??= loadConfig({ env }));
  const home = homeDir(env);
  const tmpDirs = [...new Set([os.tmpdir(), env.TEMP, env.TMP, path.join(home, 'AppData', 'Local', 'Temp')].filter((d): d is string => !!d))];
  const beads = async () => {
    const { Beads } = await import('../core/bd.ts');
    return new Beads(config().trackerDir, { timeoutMs: CALL_TIMEOUT_MS });
  };
  return {
    get trackerDir() {
      return config().trackerDir;
    },
    get workspaceRoot() {
      return config().workspaceRoot;
    },
    get wip() {
      return config().wip;
    },
    home,
    tmpDirs,
    async snapshot() {
      const [{ loadSnapshot }, b] = await Promise.all([import('../core/snapshot.ts'), beads()]);
      return loadSnapshot(b);
    },
    async show(id) {
      return (await beads()).show(id);
    },
    // An exit code is an answer. A thrown error (git missing, timeout, bad folder) propagates,
    // so runHook allows the action and logs it. gitfacts.ts answers "no" on errors, so it is not used here.
    async branchOpen(repoDir, name) {
      const head = `refs/heads/${name}`;
      if ((await git(repoDir, ['rev-parse', '--verify', '--quiet', head])) === undefined) return false;
      const out = await git(repoDir, ['log', '--format=%H', `${await defaultBranch(repoDir)}..${head}`, '--']);
      return out !== undefined && out.trim() !== '';
    },
    async refExists(repoDir, name) {
      return (await git(repoDir, ['rev-parse', '-q', '--verify', `refs/heads/${name}`])) !== undefined;
    },
    async mergedPrNumbers(repoDir, numbers) {
      if (numbers.length === 0) return [];
      const out = await git(repoDir, ['log', '-500', '--format=%s', await defaultBranch(repoDir), '--']);
      if (out === undefined) return [];
      const found = new Set<number>();
      for (const line of out.split(/\r?\n/)) {
        const m = /\(#(\d+)\)\s*$/.exec(line);
        if (m) found.add(Number(m[1]));
      }
      return numbers.filter((n) => found.has(n));
    },
    async remoteRepo(repoDir) {
      const url = await git(repoDir, ['remote', 'get-url', 'origin']);
      return url === undefined ? undefined : repoOfUrl(url);
    },
  };
}

// --- track dependencies -----------------------------------------------------------------------

export type TrackDeps = GateDeps & {
  beads: Pick<Beads, 'claim' | 'addLabel' | 'removeLabel' | 'addDep' | 'note'>;
  approveSpec: typeof approveSpec;
  recordBaseline: typeof recordBaseline;
  criteriaChanged(id: string): Promise<boolean>;
};

/** PostToolUse runs under an 8 s deadline and may make several bd calls. */
const TRACK_CALL_TIMEOUT_MS = 4000;

/** Real track dependencies: the gate's, plus bd writes and the approval functions. Modules load on first call. */
export function buildTrackDeps(env: NodeJS.ProcessEnv = process.env): TrackDeps {
  const gate = buildGateDeps(env); // Object.assign keeps its lazy config getters
  const bd = async () => new (await import('../core/bd.ts')).Beads(gate.trackerDir, { timeoutMs: TRACK_CALL_TIMEOUT_MS });
  // approveSpec and recordBaseline take a context; the real ones build their own and ignore the argument.
  const ctx = async () => ({ beads: await bd(), config: loadConfig({ env }) });
  return Object.assign(gate, {
    beads: {
      claim: async (id: string) => (await bd()).claim(id),
      addLabel: async (id: string, label: string) => (await bd()).addLabel(id, label),
      removeLabel: async (id: string, label: string) => (await bd()).removeLabel(id, label),
      addDep: async (id: string, dependsOn: string) => (await bd()).addDep(id, dependsOn),
      note: async (id: string, text: string) => (await bd()).note(id, text),
    },
    approveSpec: (async (_ctx, id, opts) => (await import('../core/approve.ts')).approveSpec(await ctx(), id, opts)) as typeof approveSpec,
    recordBaseline: (async (_ctx, id) => (await import('../core/approve.ts')).recordBaseline(await ctx(), id)) as typeof recordBaseline,
    async criteriaChanged(id: string) {
      const [{ criteriaChanged }, b] = await Promise.all([import('../core/approve.ts'), bd()]);
      return criteriaChanged(await b.show(id));
    },
  });
}
