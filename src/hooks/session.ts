// SessionStart (bash `on_start` and `on_sweep`, plus archiving, the /clear handover and the bead context)
// and SessionEnd (record the end; leave a handover on /clear).
import { clearHandover, patchBinding, readBinding, readHandover, writeHandover } from '../core/binding.ts';
import type { Binding } from '../core/binding.ts';
import type { ListedBead } from '../core/bd.ts';
import { branchesOf, prsOf, repoOf } from '../core/facts.ts';
import { assertSafeSegment, beadForSession, recordEnd, recordStart } from '../core/sessions.ts';
import type { Snapshot } from '../core/snapshot.ts';
import { bound, describeBead, ensureIndexed, findBead, isBead, logError, mergeOf, sameFolder, stageChangeLine, titleOf } from './common.ts';
import type { HookDeps, HookResult } from './common.ts';

export type StartInput = { session_id: string; source: string; cwd: string };
export type EndInput = { session_id: string; transcript_path?: string; reason: string; cwd: string };

/** A handover is adopted only this soon after the /clear that left it. */
const HANDOVER_MS = 60_000;

/** The sweep and the drift report together stop after this long. Title and context are set before them. */
export const SWEEP_BUDGET_MS = 3000;

export async function onSessionStart(
  input: StartInput,
  deps: HookDeps,
  env: NodeJS.ProcessEnv = process.env,
  opts: { budgetMs?: number } = {},
): Promise<HookResult> {
  try {
    deps.startArchive();
  } catch (e) {
    logError('SessionStart', 'archive not started', e);
  }
  const sid = input.session_id;
  const cwd = input.cwd || '.';
  // Record first: a handover binding and the index entry are written before any slow work.
  let b = readBinding(deps.trackerDir, sid);
  if (input.source === 'clear') b = adoptHandover(deps, sid, cwd, b);
  // A /clear handover names the session this one replaces in the same terminal.
  if (isBead(b.bead)) ensureIndexed(deps.trackerDir, sid, b.bead, b.handoverFrom);

  const s = await deps.snapshot();
  // `strand work` launched this session for a bead. The env outlives the bead: a resumed session whose bead
  // Stop already closed and released must not bind to it again.
  const launched = env.STRAND_BEAD_ID;
  if (!bound(b) && launched) {
    assertSafeSegment(launched, 'bead id');
    const lb = findBead(s, launched);
    if (lb && lb.status !== 'closed') {
      b = patchBinding(deps.trackerDir, sid, { bead: lb.id });
      ensureIndexed(deps.trackerDir, sid, lb);
    }
  }
  // Title and context first: the slow work below can never lose them.
  const out: HookResult = {};
  const bead = isBead(b.bead) ? findBead(s, b.bead) : undefined;
  if (bead) {
    const { stage, context } = await describeBead(bead.id, s, deps, env);
    out.sessionTitle = titleOf(bead);
    out.additionalContext = context;
    // The context names the stage, so the next prompt says only a change from it. A change since the session
    // last heard (the engineer approved the spec in the cockpit) is said here: the next prompt will not see it.
    if (b.lastStage !== stage) {
      if (b.lastStage) out.additionalContext = `${context}\n${stageChangeLine(b.lastStage, stage)}`;
      b = patchBinding(deps.trackerDir, sid, { lastStage: stage });
    }
  }
  // Sweep and drift report share their own budget. Past it the hook answers with what it has.
  const said: string[] = [];
  const deadline = Date.now() + (opts.budgetMs ?? SWEEP_BUDGET_MS);
  const slow = (async () => {
    try {
      await sweep(deps, sid, cwd, s, said, deadline);
    } catch (e) {
      logError('SessionStart', 'sweep', e);
    }
    if (Date.now() >= deadline) return;
    try {
      const { auditReport } = await import('../core/audit.ts');
      const drift = await auditReport(cwd, s, { quiet: true, trackerDir: deps.trackerDir, heads: (dir) => deps.stackHeads(dir) });
      if (drift) said.push(drift);
    } catch (e) {
      logError('SessionStart', 'drift report', e);
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
    timer.unref();
  });
  await Promise.race([slow, late]);
  clearTimeout(timer);
  if (Date.now() >= deadline) logError('SessionStart', 'sweep', new Error('stopped at its time budget'));
  // The sweep may have closed the bound bead: the title then says DONE.
  const after = bead ? s.beads.get(bead.id) : undefined;
  if (after && after !== bead) out.sessionTitle = titleOf(after);
  if (said.length > 0) out.systemMessage = said.join('\n');
  return out;
}

/** A `/clear` in the same folder within a minute carries the bead over. A stale handover is removed. */
function adoptHandover(deps: HookDeps, sid: string, cwd: string, b: Binding): Binding {
  const h = readHandover(deps.trackerDir, cwd);
  if (!h) return b;
  const age = deps.now().getTime() - Date.parse(h.at);
  if (!(Math.abs(age) <= HANDOVER_MS)) {
    clearHandover(deps.trackerDir, cwd);
    return b;
  }
  if (!sameFolder(h.cwd, cwd) || bound(b)) return b;
  clearHandover(deps.trackerDir, cwd);
  return patchBinding(deps.trackerDir, sid, { bead: h.bead, epic: h.epic, handoverFrom: h.from });
}

/** A bead the sweep may check from this folder: its `repo:` label is the folder's name, or it has none. */
function sweptHere(b: ListedBead, cwd: string): boolean {
  const repo = repoOf(b);
  if (repo === undefined) return true;
  // Either separator: the hook input carries a Windows path on Windows and a POSIX one elsewhere.
  const folder = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  return process.platform === 'win32' ? repo.toLowerCase() === folder.toLowerCase() : repo === folder;
}

/**
 * bash `on_sweep`: close open beads whose PR or branch merged, by the same rule as Stop (`mergeOf`).
 * Only beads of this folder's repo (or with no `repo:` label) are checked. No new git or bd call starts
 * after `deadline`. The squash subjects are read with one git call for every `pr:` number of the origin repo.
 * Each close is in the snapshot afterwards, so the title shows DONE. Lines go into `said` as they happen.
 */
async function sweep(deps: HookDeps, sid: string, cwd: string, s: Snapshot, said: string[], deadline: number): Promise<void> {
  const open = [...s.beads.values()].filter(
    (b) => b.status !== 'closed' && (branchesOf(b.labels).length > 0 || prsOf(b.labels).length > 0) && sweptHere(b, cwd),
  );
  const repo = open.some((b) => prsOf(b.labels).length > 0) ? await deps.remoteRepo(cwd) : undefined;
  const numbers = [...new Set(open.flatMap((b) => prsOf(b.labels).filter((p) => `${p.owner}/${p.repo}` === repo).map((p) => p.number)))];
  const merged = new Set(numbers.length > 0 ? await deps.mergedPrNumbers(cwd, numbers) : []);
  const once = {
    remoteRepo: async () => repo,
    mergedPrNumbers: async (_dir: string, n: number[]) => n.filter((x) => merged.has(x)),
    mergedByChangeId: (dir: string, name: string) => deps.mergedByChangeId(dir, name),
  };
  for (const b of open) {
    if (Date.now() >= deadline) return;
    const m = await mergeOf(once, cwd, b);
    if (!m || Date.now() >= deadline) continue;
    try {
      await deps.beads.close(b.id, m.reason, sid);
    } catch (e) {
      logError('SessionStart', `close ${b.id}`, e);
      continue;
    }
    s.beads.set(b.id, { ...b, status: 'closed' });
    said.push(m.via === 'pr' ? `Closed bead ${b.id}: ${m.repo}#${m.number} merged.` : `Closed bead ${b.id}: branch ${m.name} merged.`);
  }
}

/** Records the end: index writes and one comment. No git, no archiving. On /clear, leaves a handover first. */
export async function onSessionEnd(input: EndInput, deps: Pick<HookDeps, 'trackerDir' | 'beads' | 'now'>): Promise<void> {
  const sid = input.session_id;
  const b = readBinding(deps.trackerDir, sid);
  if (input.reason === 'clear' && isBead(b.bead)) {
    writeHandover(deps.trackerDir, { cwd: input.cwd, bead: b.bead, epic: b.epic, at: deps.now().toISOString(), from: sid });
  }
  let id = beadForSession(deps.trackerDir, sid);
  if (id === undefined && isBead(b.bead)) {
    // Bound by a plan or a claim, never indexed: index it now so its transcript is archived.
    recordStart(deps.trackerDir, { sessionId: sid, beadId: b.bead });
    id = b.bead;
  }
  if (id === undefined) return;
  recordEnd(deps.trackerDir, { sessionId: sid, transcriptPath: input.transcript_path });
  await deps.beads.comment(id, `session ${sid} ended (${input.reason})`);
}
