// One-off move of an existing tracker onto the label workflow (RFC 0003 section 11).
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Beads } from './bd.ts';
import { readBinding, writeBinding } from './binding.ts';
import type { Binding } from './binding.ts';
import { branchesOf, parseCriteria, planApprovedAt, prsOf, repoOf } from './facts.ts';
import { assertSafeSegment, beadForSession, writeEntry } from './sessions.ts';
import type { Snapshot } from './snapshot.ts';
import { stateDir } from './state.ts';

/** A binding from the old bash hook. `bead` is a bead id or the word `none`. */
export type OldBinding = { sessionId: string; bead: string; epic?: string };

/** An old session as the index will hold it: ended, with the transcript it can be resumed from. */
export type ImportedSession = { sessionId: string; beadId: string; startedAt: string; endedAt: string; transcriptPath: string };

export type MigrationPlan = {
  addRepo: { id: string; repo: string }[];
  unassigned: string[];
  removeInReview: string[];
  approve: string[];
  /** in_progress beads that get no approval: their sessions refuse edits until approved or claimed again. Report only. */
  staysInSpecify: string[];
  bindings: OldBinding[];
  /**
   * Old sessions to write to the session index, so the cockpit lists them on their bead. Set by the command:
   * a session bound to a bead, with a transcript on disk and no index entry yet.
   */
  sessions?: ImportedSession[];
  /** Workspace folders that share an origin. The first in sorted order is the one used. Set by the command. */
  sharedOrigins?: { repo: string; folders: string[] }[];
};

export type MigrationInput = {
  workspaceRoot: string;
  /** `owner/repo` of each workspace folder's origin -> folder name. */
  remotes: Map<string, string>;
  branchRepo(name: string): string | undefined;
  oldBindings: OldBinding[];
};

export function planMigration(s: Snapshot, o: MigrationInput): MigrationPlan {
  const remotes = new Map([...o.remotes].map(([k, v]) => [k.toLowerCase(), v]));
  const plan: MigrationPlan = { addRepo: [], unassigned: [], removeInReview: [], approve: [], staysInSpecify: [], bindings: [] };
  for (const b of s.beads.values()) {
    const branches = branchesOf(b.labels);
    const prs = prsOf(b.labels);
    if (repoOf(b) === undefined && (branches.length > 0 || prs.length > 0)) {
      let repo: string | undefined;
      for (const p of prs) repo ??= remotes.get(`${p.owner}/${p.repo}`.toLowerCase());
      for (const name of branches) repo ??= o.branchRepo(name);
      if (repo) plan.addRepo.push({ id: b.id, repo });
      else plan.unassigned.push(b.id);
    }
    if (b.labels.includes('in-review')) plan.removeInReview.push(b.id);
    if (b.status === 'in_progress' && planApprovedAt(b.notes) === undefined) {
      if (branches.length > 0 || parseCriteria(b.acceptance_criteria).some((c) => c.ticked)) plan.approve.push(b.id);
      else plan.staysInSpecify.push(b.id);
    }
  }
  for (const old of o.oldBindings) {
    if (old.bead !== 'none' && !s.ids.has(old.bead)) continue;
    const next: OldBinding = { sessionId: old.sessionId, bead: old.bead };
    if (old.bead !== 'none' && old.epic && s.ids.has(old.epic)) next.epic = old.epic;
    plan.bindings.push(next);
  }
  return plan;
}

function firstLine(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The old hook's `<home>/.claude/state/beads/<session>.bead` (and `.epic`) files. */
export function readOldBindings(home: string): OldBinding[] {
  const dir = path.join(home, '.claude', 'state', 'beads');
  if (!existsSync(dir)) return [];
  const out: OldBinding[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.bead')) continue;
    const sessionId = f.slice(0, -'.bead'.length);
    try {
      assertSafeSegment(sessionId, 'session id');
    } catch {
      continue;
    }
    const bead = firstLine(path.join(dir, f));
    if (!bead) continue;
    const epic = firstLine(path.join(dir, `${sessionId}.epic`));
    out.push(epic ? { sessionId, bead, epic } : { sessionId, bead });
  }
  return out;
}

export const DRY_RUN_LINE = 'Dry run. Nothing was changed. Rerun with --apply to make these changes.';

/** Where the safety export goes, with the trailing separator the report prints. */
export function backupsDir(trackerDir: string): string {
  return stateDir(trackerDir, 'backups');
}

/** The plain-text dry-run report. */
export function formatPlan(p: MigrationPlan, s: Snapshot, trackerDir?: string): string {
  const title = (id: string) => s.beads.get(id)?.title ?? '';
  const lines: string[] = [];
  const group = (heading: string, rows: string[]) => {
    lines.push(`${heading} (${rows.length})`, ...rows.map((r) => `  ${r}`), '');
  };
  group('repo: labels to add', p.addRepo.map((r) => `${r.id}  ${title(r.id)}  -> repo:${r.repo}`));
  group('needs a repo: label, assign by hand', p.unassigned.map((id) => `${id}  ${title(id)}  -> (none)`));
  group('in-review labels to remove', p.removeInReview.map((id) => `${id}  ${title(id)}  -> remove in-review`));
  group('plan-approved to write', p.approve.map((id) => `${id}  ${title(id)}  -> plan-approved`));
  group('in_progress, stays in Specify: approve it or claim it again', (p.staysInSpecify ?? []).map((id) => `${id}  ${title(id)}`));
  group(
    'session bindings to import',
    p.bindings.map((b) => `${b.bead}  ${b.bead === 'none' ? 'no bead' : title(b.bead)}  -> session ${b.sessionId}`),
  );
  group(
    'sessions to list on their bead',
    (p.sessions ?? []).map((x) => `${x.beadId}  ${title(x.beadId)}  -> session ${x.sessionId}`),
  );
  for (const o of p.sharedOrigins ?? []) {
    lines.push(`Folders sharing an origin (${o.repo}): ${o.folders.join(', ')}. The first one wins.`);
  }
  if (trackerDir) lines.push(`With --apply, a safety export is written first to ${backupsDir(trackerDir)}${path.sep}.`);
  lines.push(DRY_RUN_LINE);
  return lines.join('\n');
}

export type Count = { done: number; total: number };
export type MigrationProgress = { addRepo: Count; removeInReview: Count; approve: Count; bindings: Count; sessions: Count };

function zeroProgress(p: MigrationPlan): MigrationProgress {
  return {
    addRepo: { done: 0, total: p.addRepo.length },
    removeInReview: { done: 0, total: p.removeInReview.length },
    approve: { done: 0, total: p.approve.length },
    bindings: { done: 0, total: p.bindings.length },
    sessions: { done: 0, total: (p.sessions ?? []).length },
  };
}

/** A failed apply. `progress` says how far it got; `stage` says whether the safety export or a later write failed. */
export class MigrationError extends Error {
  progress: MigrationProgress;
  stage: 'export' | 'apply';
  exportFile: string;
  constructor(message: string, o: { progress: MigrationProgress; stage: 'export' | 'apply'; exportFile: string }) {
    super(message);
    this.name = 'MigrationError';
    this.progress = o.progress;
    this.stage = o.stage;
    this.exportFile = o.exportFile;
  }
}

function stamp(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
}

/** Write the safety export and check it: the file exists and has a line for every bead. */
async function safetyExport(
  beads: Pick<Beads, 'exportAll'>,
  file: string,
  beadCount: number,
): Promise<void> {
  mkdirSync(path.dirname(file), { recursive: true });
  await beads.exportAll(file);
  if (!existsSync(file)) throw new Error('file not found');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').length;
  if (beadCount > 0 && lines < beadCount) throw new Error(`${lines} lines for ${beadCount} beads`);
}

/**
 * Apply the plan. The first action is the safety export of every bead: if it fails or is short, nothing
 * else runs. Any later failure stops the run and the error carries the per-group counts.
 * Rerun `strand migrate`: the plan is derived again from what is left.
 */
export async function applyMigration(
  p: MigrationPlan,
  d: {
    beads: Pick<Beads, 'exportAll' | 'addLabel' | 'removeLabel' | 'note'>;
    trackerDir: string;
    beadCount: number;
    now?: () => Date;
  },
): Promise<{ progress: MigrationProgress; exportFile: string }> {
  const now = d.now ?? (() => new Date());
  const progress = zeroProgress(p);
  const exportFile = path.join(backupsDir(d.trackerDir), `pre-migrate-${stamp(now())}.jsonl`);
  try {
    await safetyExport(d.beads, exportFile, d.beadCount);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new MigrationError(`Could not write a safety export to ${exportFile}: ${why}. Nothing was changed.`, {
      progress,
      stage: 'export',
      exportFile,
    });
  }
  try {
    for (const r of p.addRepo) {
      await d.beads.addLabel(r.id, `repo:${r.repo}`);
      progress.addRepo.done++;
    }
    for (const id of p.removeInReview) {
      await d.beads.removeLabel(id, 'in-review');
      progress.removeInReview.done++;
    }
    const at = now().toISOString();
    for (const id of p.approve) {
      await d.beads.note(id, `plan-approved ${at}`);
      progress.approve.done++;
    }
    for (const b of p.bindings) {
      const existing = readBinding(d.trackerDir, b.sessionId);
      // A session that already has a new-style binding keeps it.
      if (existing.bead === undefined && !existing.none) {
        const next: Binding = b.bead === 'none' ? { none: true } : b.epic ? { bead: b.bead, epic: b.epic } : { bead: b.bead };
        writeBinding(d.trackerDir, b.sessionId, next);
      }
      progress.bindings.done++;
    }
    for (const x of p.sessions ?? []) {
      // A session the index already knows keeps its entry.
      if (beadForSession(d.trackerDir, x.sessionId) === undefined) writeEntry(d.trackerDir, { ...x });
      progress.sessions.done++;
    }
  } catch (e) {
    throw new MigrationError(e instanceof Error ? e.message : String(e), { progress, stage: 'apply', exportFile });
  }
  return { progress, exportFile };
}
