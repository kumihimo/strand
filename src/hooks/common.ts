// Shared parts of the session hooks (UserPromptSubmit, SessionStart, Stop, SessionEnd): their dependencies,
// the bead context and the small helpers ported from ~/.claude/hooks/bead-workflow.sh.
// The handlers live in prompt.ts, session.ts and stop.ts. Binding state lives in core/binding.ts.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.ts';
import type { Config } from '../core/config.ts';
import { patchBinding } from '../core/binding.ts';
import type { Binding } from '../core/binding.ts';
import type { ListedBead } from '../core/bd.ts';
import { branchesOf, contextOf, mergedAsReason, prsOf } from '../core/facts.ts';
import { sameFolder } from '../core/folders.ts';
import { beadBranch } from '../core/naming.ts';
import { beadForSession, recordStart } from '../core/sessions.ts';
import { findBead, localStage, wipOf } from '../core/snapshot.ts';
export { findBead };
import type { Snapshot } from '../core/snapshot.ts';
import { defaultSpecFormat } from '../core/spec.ts';
import { titleState } from '../core/stage.ts';
import type { Stage } from '../core/stage.ts';
import { buildGateDeps } from './runtime.ts';

export { sameFolder };
export { DEADLINE_MS, runHook } from './runtime.ts';
export type { HookEvent, HookIO, HookResult } from './runtime.ts';

export type HookDeps = {
  trackerDir: string;
  workspaceRoot: string;
  branchPrefix?: string;
  wip: Config['wip'];
  /** CLAUDE_CODE_ENTRYPOINT: `claude-desktop` in the desktop app. */
  entrypoint?: string;
  /** Every bead, from one bd call. A hook run calls this at most once. */
  snapshot(): Promise<Snapshot>;
  beads: {
    claim(id: string): Promise<void>;
    /** `session` is passed to `bd close --session`. */
    close(id: string, reason: string, session?: string): Promise<void>;
    comment(id: string, text: string): Promise<void>;
  };
  /** owner/repo of the folder's `origin` remote. */
  remoteRepo(repoDir: string): Promise<string | undefined>;
  mergedPrNumbers(repoDir: string, numbers: number[]): Promise<number[]>;
  mergedByChangeId(repoDir: string, name: string): Promise<boolean>;
  /** Applied GitButler stacks, top first. */
  stackHeads(repoDir: string): Promise<{ stack: number; name: string }[]>;
  /** Kick off archiving in a detached process and return at once. */
  startArchive(): void;
  now(): Date;
};

/** Detached `strand archive`, so a hook exit can never interrupt a git operation mid-way. */
export function spawnArchive(env: NodeJS.ProcessEnv = process.env): void {
  const cli = fileURLToPath(new URL('../cli/strand.ts', import.meta.url));
  const child = spawn(process.execPath, [cli, 'archive'], { detached: true, stdio: 'ignore', windowsHide: true, env, shell: false });
  child.on('error', () => {});
  child.unref();
}

/** bd calls made by these hooks must end well inside their deadlines. */
const BD_TIMEOUT_MS = 4000;

/** Real dependencies. Config loads on first use of a config field; bd, git and but modules on first call. */
export function buildDeps(env: NodeJS.ProcessEnv = process.env): HookDeps {
  const gate = buildGateDeps(env);
  let cfg: Config | undefined;
  const config = () => (cfg ??= loadConfig({ env }));
  const bd = async () => new (await import('../core/bd.ts')).Beads(gate.trackerDir, { timeoutMs: BD_TIMEOUT_MS });
  return {
    get trackerDir() {
      return gate.trackerDir;
    },
    get workspaceRoot() {
      return gate.workspaceRoot;
    },
    get wip() {
      return gate.wip;
    },
    get branchPrefix() {
      return config().branchPrefix;
    },
    entrypoint: env.CLAUDE_CODE_ENTRYPOINT,
    snapshot: () => gate.snapshot(),
    beads: {
      claim: async (id) => (await bd()).claim(id),
      close: async (id, reason, session) => (await bd()).close(id, reason, session),
      comment: async (id, text) => (await bd()).comment(id, text),
    },
    remoteRepo: (dir) => gate.remoteRepo(dir),
    mergedPrNumbers: (dir, numbers) => gate.mergedPrNumbers(dir, numbers),
    // A "no" here only delays a close, so gitfacts' answer-no-on-error is fine.
    mergedByChangeId: async (dir, name) => (await import('../core/gitfacts.ts')).mergedByChangeId(dir, name),
    stackHeads: async (dir) => (await import('../core/but.ts')).butStackHeads(dir, { timeoutMs: 3000 }),
    startArchive: () => spawnArchive(env),
    now: () => new Date(),
  };
}

// --- small ports of the bash helpers ----------------------------------------------------------

/** bash `bound`: the bead id, `none`, or undefined. */
export function bound(b: Binding): string | undefined {
  return b.bead || (b.none ? 'none' : undefined);
}

/** bash `is_bead`. */
export function isBead(id: string | undefined): id is string {
  return !!id && id !== 'none';
}


/** bash `title_of`: `<STATE>: <id> <title>`. */
export function titleOf(b: ListedBead): string {
  return `${titleState(localStage(b), b.status)}: ${b.id} ${b.title}`;
}

export const APP_TITLE_TOOL = 'mcp__ccd_session_mgmt__set_session_title';

/** bash `app_title_stale`: the desktop app keeps its own title, which only Claude can change. */
export function appTitleStale(entrypoint: string | undefined, b: Binding, title: string | undefined): title is string {
  return entrypoint === 'claude-desktop' && !!title && b.appTitle !== title;
}

/** bash `app_title_ask`. */
export function appTitleAsk(title: string): string {
  return `Set this chat's title in the app: call ${APP_TITLE_TOOL} with session_id "self" and title "${title}".`;
}

/** bash `release`: the bound bead is finished. Fall back to the approved epic, if there is one. */
export function release(trackerDir: string, sessionId: string, b: Binding, id: string): void {
  const clear = { none: undefined, approved: undefined, dirty: undefined, nagged: undefined, learnAsked: undefined, lastStage: undefined };
  if (b.epic && b.epic !== id) patchBinding(trackerDir, sessionId, { ...clear, bead: b.epic });
  else patchBinding(trackerDir, sessionId, { ...clear, bead: undefined, epic: undefined });
}

/**
 * Put a bound session in the session index, so its transcript is archived with the bead. `replaces` names the
 * session it took over after a /clear, so a cockpit terminal that ran both can end both.
 */
export function ensureIndexed(trackerDir: string, sessionId: string, bead: ListedBead | string, replaces?: string): void {
  const id = typeof bead === 'string' ? bead : bead.id;
  if (beadForSession(trackerDir, sessionId) !== undefined) return;
  recordStart(trackerDir, { sessionId, beadId: id, branch: typeof bead === 'string' ? undefined : beadBranch(bead), replaces });
}

/**
 * bash `pr_merged`, plus the Gerrit case. One rule for Stop and the SessionStart sweep: every open bead is
 * checked. With `pr:` labels for the cwd's origin repo (with or without a `branch:` label), a squash subject
 * `(#<n>)` on the default remote branch means merged; otherwise every Change-Id of a `branch:` label's branch
 * on it does. No stage limit.
 */
export async function mergeOf(
  deps: Pick<HookDeps, 'remoteRepo' | 'mergedPrNumbers' | 'mergedByChangeId'>,
  cwd: string,
  bead: ListedBead,
): Promise<{ reason: string; via: 'pr' | 'branch'; name?: string; number?: number; repo?: string } | undefined> {
  if (bead.status === 'closed') return undefined;
  const branches = branchesOf(bead.labels);
  const prs = prsOf(bead.labels);
  if (branches.length === 0 && prs.length === 0) return undefined;
  const repo = prs.length > 0 ? await deps.remoteRepo(cwd) : undefined;
  const mine = repo === undefined ? [] : prs.filter((p) => `${p.owner}/${p.repo}` === repo).map((p) => p.number);
  if (mine.length > 0) {
    const merged = await deps.mergedPrNumbers(cwd, mine);
    return merged.length > 0 ? { reason: mergedAsReason(repo!, merged[0]!), via: 'pr', number: merged[0], repo } : undefined;
  }
  for (const name of branches) {
    if (await deps.mergedByChangeId(cwd, name)) return { reason: `Merged by Change-Id from ${name}`, via: 'branch', name };
  }
  return undefined;
}

/** Writes a hook's non-fatal error to stderr. */
/**
 * What a session is told when its bead's stage moved since it last heard (RFC 0003 section 1). SessionStart
 * and UserPromptSubmit both say it, whichever runs first after the change.
 */
export function stageChangeLine(from: string, to: string): string {
  const line = `Stage changed: ${from} -> ${to}.`;
  return from === 'specify' && to === 'build' ? `${line} The spec is approved. Start Build.` : line;
}

export function logError(event: string, what: string, e: unknown): void {
  process.stderr.write(`strand hook ${event}: ${what}: ${e instanceof Error ? e.message : String(e)}\n`);
}

// --- bead context -----------------------------------------------------------------------------

const SPEC_LIMIT = 4000;

/** The WIP line, and for a build bead at a limit the warning or block line. Best effort: `WIP: unknown` on failure. */
async function wipLines(s: Snapshot, id: string, stage: Stage, wip: Config['wip']): Promise<string[]> {
  try {
    const counts = wipOf(s, id); // in memory: no bd call, so no timeout of its own
    const lines = [`WIP: Build ${counts.build}/${wip.build}, Review ${counts.review}/${wip.review}`];
    if (stage === 'build') {
      const { checkBuild } = await import('../core/wip.ts');
      const verdict = checkBuild(counts, wip, wip.mode);
      if (verdict.reason) lines.push(wip.mode === 'refuse' ? `Build blocked: ${verdict.reason}` : `WIP warning: ${verdict.reason}`);
    }
    return lines;
  } catch {
    return ['WIP: unknown'];
  }
}

/** Bead, stage and the plain-text context describing it, all from one snapshot. Throws for an unknown bead. */
export async function describeBead(
  id: string,
  s: Snapshot,
  deps: Pick<HookDeps, 'trackerDir' | 'branchPrefix' | 'wip'>,
  env: NodeJS.ProcessEnv,
): Promise<{ bead: ListedBead; stage: Stage; context: string }> {
  const bead = findBead(s, id);
  if (!bead) throw new Error(`bead ${id} not found`);
  const stage = localStage(bead);
  const format = env.STRAND_SPEC_FORMAT || defaultSpecFormat(bead.issue_type);
  const branch = beadBranch(bead);
  const lines = [
    `Strand bead ${bead.id}: ${bead.title}`,
    `Type: ${bead.issue_type}; stage: ${stage}; spec format: ${format}`,
    ...(await wipLines(s, bead.id, stage, deps.wip)),
    branch
      ? `Commit with: but commit --branch ${branch} -m "..." <files>`
      : `Branch: none yet. Make one with but branch new ${deps.branchPrefix ?? '<username>'}/<topic>.`,
    `Tracker: ${deps.trackerDir} (run bd there: bd -C "${deps.trackerDir}" <args>)`,
    ...(contextOf(bead.labels).length ? [`Context folders: ${contextOf(bead.labels).join(', ')}`] : []),
    `Run tests only via the Test command in this repo's CLAUDE.md (ADR 0008).`,
  ];
  const criteria = bead.acceptance_criteria?.trim();
  if (criteria) lines.push('', 'Acceptance criteria:', criteria);
  const spec = bead.design?.trim();
  if (spec) lines.push('', 'Spec:', spec.length > SPEC_LIMIT ? spec.slice(0, SPEC_LIMIT) + '\n[spec truncated]' : spec);
  return { bead, stage, context: lines.join('\n') };
}
