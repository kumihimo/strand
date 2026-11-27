// `strand audit` and the SessionStart drift report: a port of `audit_report` in ~/.claude/hooks/bead-workflow.sh.
// Each applied GitButler stack, top first, with the bead that owns each branch and "  ! <problem>" lines.
import { statSync } from 'node:fs';
import type { ListedBead } from './bd.ts';
import { bindingsFor } from './binding.ts';
import { butStackHeads } from './but.ts';
import { beadIdsIn } from './facts.ts';
import { localStage } from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';
import { titleState } from './stage.ts';
import { stateFile } from './state.ts';

export type StackHead = { stack: number; name: string };

export type AuditOptions = {
  /** Print nothing unless there is a problem (bash `drift`). */
  quiet?: boolean;
  /** Where the session bindings live, for the chat column. Without it every chat reads `none`. */
  trackerDir?: string;
  /** The stack reader; `butStackHeads` by default. */
  heads?: (repoDir: string) => Promise<StackHead[]>;
};

/** bash `bead_of_branch`: the first bead with label `branch:<name>`. */
function beadOfBranch(s: Snapshot, name: string): ListedBead | undefined {
  const label = `branch:${name}`;
  for (const b of s.beads.values()) if (b.labels.includes(label)) return b;
  return undefined;
}

/** bash `chat_of`, minus the title lookup: the most recently written binding that holds the bead. */
function chatOf(trackerDir: string | undefined, id: string): string | undefined {
  if (!trackerDir) return undefined;
  let best: { sid: string; at: number } | undefined;
  for (const { sessionId } of bindingsFor(trackerDir, id)) {
    let at = 0;
    try {
      at = statSync(stateFile(trackerDir, 'bindings', `${sessionId}.json`)).mtimeMs;
    } catch {
      // gone since it was listed
    }
    if (!best || at > best.at) best = { sid: sessionId, at };
  }
  return best && `session ${best.sid.slice(0, 8)}`;
}

/** Beads this bead depends on, parent-child links aside. */
function depsOf(b: ListedBead): string[] {
  return b.dependencies.filter((d) => d.type !== 'parent-child').map((d) => d.depends_on_id);
}

/** bash `audit_report`. A failing but call prints nothing, as the bash hook does. */
export async function auditReport(repoDir: string, s: Snapshot, opts: AuditOptions = {}): Promise<string> {
  let heads: StackHead[];
  try {
    heads = await (opts.heads ?? butStackHeads)(repoDir);
  } catch {
    return '';
  }
  if (heads.length === 0) return '';
  const out: string[] = [];
  const seen = new Map<string, string>();
  let lastStack: number | undefined;
  let upper: { name: string; id?: string } | undefined;
  let problems = 0;
  for (const { stack, name } of heads) {
    if (stack !== lastStack) {
      out.push(`Stack ${stack} (top first)`);
      upper = undefined;
      lastStack = stack;
    }
    const bead = beadOfBranch(s, name);
    const id = bead?.id;
    const state = bead && titleState(localStage(bead), bead.status);
    if (bead) out.push(`  ${name}  ${state}: ${bead.id} ${bead.title}  [chat: ${chatOf(opts.trackerDir, bead.id) ?? 'none'}]`);
    else out.push(`  ${name}  (no bead)`);
    const lines: string[] = [];
    if (!id) lines.push(`  ! no bead has label branch:${name}`);
    if (beadIdsIn(name, s.prefixes, s.ids).length > 0) lines.push('  ! bead id in the branch name');
    if (id && state === 'DONE') lines.push(`  ! bead ${id} is closed but its branch is not merged`);
    if (id && seen.has(id)) lines.push(`  ! bead ${id} also owns ${seen.get(id)}`);
    if (id && upper?.id && upper.id !== id && !depsOf(s.beads.get(upper.id)!).includes(id)) {
      lines.push(`  ! ${upper.name} sits on ${name}, but bead ${upper.id} does not depend on ${id}`);
    }
    if (lines.length > 0) {
      out.push(...lines);
      problems++;
    }
    if (id) seen.set(id, name);
    upper = { name, id };
  }
  if (problems === 0) {
    if (opts.quiet) return '';
    return ['Branches and beads: no drift.', ...out].join('\n');
  }
  return [`Branches and beads: ${problems} with drift. Fix with but reword, bd update --add-label branch:<name>, bd dep add.`, ...out].join('\n');
}
