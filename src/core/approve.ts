import type { Ctx } from '../cli/ctx.ts';
import type { Bead, ListedBead } from './bd.ts';
import { bindingsFor, patchBinding } from './binding.ts';
import { criteriaHash } from './criteria-hash.ts';
import { criteriaBaseline, parseCriteria, planApprovedAt, specProblems } from './facts.ts';
import { isWorkItem, loadSnapshot, localStage } from './snapshot.ts';
import type { Stage } from './stage.ts';
import { checkBuild, wipCounts } from './wip.ts';

type ApproveCtx = Pick<Ctx, 'beads' | 'config'>;

/** The spec does not meet the approval rules. The message joins every problem with "; ". */
export class SpecProblemsError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(problems.join('; '));
    this.name = 'SpecProblemsError';
    this.problems = problems;
  }
}

/** The WIP check for approving `id`: open work items count, except the bead being approved. */
export function approvalWip(
  items: { id: string; stage: Stage; status: string }[],
  id: string,
  wip: Ctx['config']['wip'],
): { ok: boolean; reason?: string } {
  return checkBuild(wipCounts(items.filter((i) => i.id !== id)), wip, wip.mode);
}

/**
 * Approve the spec: write `plan-approved <ISO>` and, when criteria exist, the `criteria <hash>` baseline.
 * Every door (plan approval, a claim, `strand approve`, the cockpit button) comes through here.
 * In `warn` mode a full WIP limit comes back as `warn`; in `refuse` mode it throws.
 */
export async function approveSpec(
  ctx: ApproveCtx,
  id: string,
  opts: { by: 'plan' | 'claim' | 'cli' | 'cockpit'; now?: Date },
): Promise<{ warn?: string }> {
  const snap = await loadSnapshot(ctx.beads);
  const b = snap.beads.get(id);
  if (!b) throw new Error(`bead ${id} not found`);
  if (b.status === 'closed') throw new Error(`bead ${id} is closed`);
  if (planApprovedAt(b.notes) !== undefined) throw new Error(`bead ${id} is already approved`);
  const hasCriteria = parseCriteria(b.acceptance_criteria).length > 0;
  // An approved plan or a claim may come before the criteria exist; the engineer's own approval checks the spec.
  if (opts.by === 'cli' || opts.by === 'cockpit') {
    const problems = specProblems({ type: b.issue_type, description: b.description, acceptance: b.acceptance_criteria });
    if (problems.length) throw new SpecProblemsError(problems);
  }
  // An epic is not a work item: it never counts toward WIP, so approving one is never held back by it.
  const items = [...snap.beads.values()].filter(isWorkItem).map((x) => ({ id: x.id, stage: localStage(x), status: x.status }));
  const wip: { ok: boolean; reason?: string } = b.issue_type === 'epic' ? { ok: true } : approvalWip(items, id, ctx.config.wip);
  if (!wip.ok) throw new Error(wip.reason);
  await ctx.beads.note(id, `plan-approved ${(opts.now ?? new Date()).toISOString()}`);
  if (hasCriteria) await ctx.beads.note(id, `criteria ${criteriaHash(b.acceptance_criteria)}`);
  for (const { sessionId } of bindingsFor(ctx.config.trackerDir, id)) {
    patchBinding(ctx.config.trackerDir, sessionId, { approved: true });
  }
  return wip.reason ? { warn: wip.reason } : {};
}

async function loadOne(ctx: ApproveCtx, id: string): Promise<ListedBead> {
  const b = (await loadSnapshot(ctx.beads)).beads.get(id);
  if (!b) throw new Error(`bead ${id} not found`);
  return b;
}

/** Write a `criteria <hash>` baseline line for this acceptance text. */
export async function writeBaseline(ctx: ApproveCtx, id: string, acceptance: string | undefined): Promise<void> {
  await ctx.beads.note(id, `criteria ${criteriaHash(acceptance)}`);
}

/** Write the first `criteria <hash>` line when the bead is approved, has criteria and no baseline yet. */
export async function recordBaseline(ctx: ApproveCtx, id: string): Promise<void> {
  const b = await loadOne(ctx, id);
  if (planApprovedAt(b.notes) === undefined || criteriaBaseline(b.notes) !== undefined) return;
  if (parseCriteria(b.acceptance_criteria).length === 0) return;
  await writeBaseline(ctx, id, b.acceptance_criteria);
}

/** True when a baseline exists and the criteria text no longer matches it. */
export function criteriaChanged(b: ListedBead | Bead): boolean {
  const base = criteriaBaseline(b.notes);
  return base !== undefined && base !== criteriaHash(b.acceptance_criteria);
}

/**
 * The engineer accepted the changed criteria: write a new baseline line. Only for an open, approved bead
 * with criteria: a baseline of nothing would make the first real criteria read as changed.
 */
export async function acceptCriteria(ctx: ApproveCtx, id: string): Promise<void> {
  const b = await loadOne(ctx, id);
  if (b.status === 'closed') throw new Error(`bead ${id} is closed`);
  if (planApprovedAt(b.notes) === undefined) throw new Error(`bead ${id} is not approved`);
  if (parseCriteria(b.acceptance_criteria).length === 0) throw new Error(`bead ${id} has no acceptance criteria`);
  await writeBaseline(ctx, id, b.acceptance_criteria);
}

/** The engineer asked for changes to the spec. The stage does not move. */
export async function requestChanges(ctx: ApproveCtx, id: string, note: string): Promise<void> {
  if (typeof note !== 'string' || note.length < 1 || note.length > 2000) throw new Error('note must be 1 to 2000 characters');
  await ctx.beads.comment(id, `changes requested: ${note}`);
}
