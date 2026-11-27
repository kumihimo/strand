import { createHash } from 'node:crypto';
import type { Ctx } from '../cli/ctx.ts';
import { writeBaseline } from './approve.ts';
import type { Bead } from './bd.ts';
import { bindingsFor, patchBinding } from './binding.ts';
import { BEAD_ID, repoSet, repoSetLabels } from './create-bead.ts';
import { criteriaHash } from './criteria-hash.ts';
import { branchesOf, captureProblems, contextOf, criterionKey, mergeAcceptance, mergeCriteria, parseCriteria, planApprovedAt, repoOf, specProblems } from './facts.ts';
import { isRepoLabelName } from './naming.ts';

export type BeadEdit = {
  title?: string;
  description?: string;
  acceptance?: string;
  design?: string;
  type?: string;
  priority?: number;
  parent?: string;
  /** The primary repo; an empty string clears it. Sent with `context`, it replaces the bead's repo labels. */
  repo?: string;
  context?: string[];
};

/** The fields an edit can touch, in the order `changed` lists them (`repos` last). */
const FIELDS = ['title', 'description', 'acceptance', 'design', 'type', 'priority', 'parent'] as const;
/** The fields `specProblems` reads. */
const SPEC_FIELDS = ['description', 'acceptance', 'type'] as const;

const TYPE = /^[a-z][a-z0-9-]{0,31}$/;

/** The bead moved on since the form was opened. `current` is what is stored now. */
export class StaleEditError extends Error {
  current: Bead;
  constructor(current: Bead) {
    super(`bead ${current.id} changed since it was read`);
    this.name = 'StaleEditError';
    this.current = current;
  }
}

/** The first thing wrong with the shape of the edit, or undefined. Needs no bd call. */
export function editProblem(edit: BeadEdit): string | undefined {
  const text = ['title', 'description', 'acceptance', 'design', 'type', 'parent', 'repo'] as const;
  for (const k of text) if (edit[k] !== undefined && typeof edit[k] !== 'string') return `invalid ${k}`;
  if (edit.context !== undefined && (!Array.isArray(edit.context) || edit.context.some((c) => typeof c !== 'string'))) return 'invalid context';
  for (const name of [...(edit.repo ? [edit.repo] : []), ...(edit.context ?? [])]) {
    if (!isRepoLabelName(name)) return `invalid repo name ${name}`;
  }
  if (edit.title !== undefined && !edit.title.trim()) return 'title is required';
  if (edit.title !== undefined && edit.title.length > 500) return 'title is too long';
  if (edit.type !== undefined && !TYPE.test(edit.type)) return `invalid type ${edit.type}`;
  if (edit.priority !== undefined && (!Number.isInteger(edit.priority) || edit.priority < 0 || edit.priority > 4)) {
    return `invalid priority ${String(edit.priority)}: use a whole number from 0 to 4`;
  }
  if (edit.parent !== undefined && !BEAD_ID.test(edit.parent)) return `invalid parent ${edit.parent}`;
  return undefined;
}

/** After approval a mistyped criterion line (`- [] x`, `1. x`) must not vanish in the merge. */
function strayLine(acceptance: string): string | undefined {
  for (const line of acceptance.split(/\r?\n/)) {
    if (line.trim() !== '' && parseCriteria(line).length === 0) return `criterion must start "- [ ] ": ${line.trim()}`;
  }
  return undefined;
}

/** The bead's `repo:` and `context:` labels, sorted. */
const repoLabelsOf = (labels: string[]): string[] => labels.filter((l) => /^(repo|context):/.test(l)).sort();

/** The bead's parent: bd's `parent` field, else its `parent-child` dependency. */
function parentOfBead(b: Bead): string | undefined {
  return b.parent ?? b.dependencies.find((d) => d.dependency_type === 'parent-child')?.id;
}

/**
 * What a form is opened at. bd's `updated_at` has one-second precision, so a write in the same second
 * would go unseen: the fingerprint of the editable fields (raw acceptance, ticks included) catches it.
 */
export function beadVersion(b: Bead): string {
  const fields = [b.title, b.description ?? '', b.acceptance_criteria ?? '', b.design ?? '', b.issue_type, b.priority, parentOfBead(b) ?? '', repoLabelsOf(b.labels ?? [])];
  return `${b.updated_at ?? ''}:${createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 12)}`;
}

/** The criteria as an ordered list of text and check, whitespace collapsed. */
const criteriaSig = (text: string | undefined): string => parseCriteria(text).map(criterionKey).join('\n');

/**
 * Edit a bead from the cockpit. Refuses a closed bead and a stale `version` (the `updated_at` the form was
 * opened with). Ticks and evidence stay only on criteria whose text and check are unchanged. The result must
 * pass the capture rules, and after approval the spec rules. A `repo` or `context` edit replaces the bead's
 * repo labels; `known` is the repo list the names must be in. One `bd update` call; on an approved bead a
 * criteria change re-records the baseline. Every session bound to the bead is told through its binding.
 */
export async function editBead(
  ctx: Pick<Ctx, 'beads' | 'config'>,
  id: string,
  edit: BeadEdit,
  opts: { version: string; now?: Date; known?: readonly string[] },
): Promise<{ bead: Bead; changed: string[]; rebaselined: boolean; warning?: string }> {
  const bead = await ctx.beads.show(id);
  if (bead.status === 'closed') throw new Error(`bead ${id} is closed`);
  if (opts.version !== beadVersion(bead)) throw new StaleEditError(bead);
  const bad = editProblem(edit);
  if (bad) throw new Error(bad);
  // Before approval the criteria are free text; after it they are criterion lines only.
  const approved = planApprovedAt(bead.notes) !== undefined;
  const merge = approved ? mergeCriteria : mergeAcceptance;
  if (approved && edit.acceptance !== undefined) {
    const stray = strayLine(edit.acceptance);
    if (stray) throw new Error(stray);
  }

  const current: Record<(typeof FIELDS)[number], string | number | undefined> = {
    title: bead.title,
    description: bead.description ?? '',
    // Compared in the shape a save produces, so stored whitespace does not read as an edit.
    acceptance: merge(bead.acceptance_criteria, bead.acceptance_criteria ?? ''),
    design: bead.design ?? '',
    type: bead.issue_type,
    priority: bead.priority,
    parent: parentOfBead(bead),
  };
  const next = { ...current };
  if (edit.acceptance !== undefined) next.acceptance = merge(bead.acceptance_criteria, edit.acceptance);
  for (const k of FIELDS) if (k !== 'acceptance' && edit[k] !== undefined) (next as Record<string, unknown>)[k] = edit[k];

  const shape = { title: next.title as string, type: next.type as string, parent: next.parent as string | undefined };
  const spec = { type: next.type as string, description: next.description as string, acceptance: next.acceptance as string };
  // The rules judge the fields they read: an edit of the repos, the priority or the spec body is not held back
  // by an older spec.
  const fieldsChanged = FIELDS.some((k) => next[k] !== current[k]);
  const specChanged = SPEC_FIELDS.some((k) => next[k] !== current[k]);
  const problems = [...(fieldsChanged ? captureProblems(shape) : []), ...(approved && specChanged ? specProblems(spec) : [])];
  if (problems.length) throw new Error(problems[0]);

  // The repo labels: the whole set of `repo:` and `context:` labels is replaced in the same update.
  const labels = { add: [] as string[], remove: [] as string[] };
  if (edit.repo !== undefined || edit.context !== undefined) {
    const repo = repoOf(bead);
    const kept = [...(repo ? [repo] : []), ...contextOf(bead.labels)];
    // Only names the edit adds must be in the repo list; a folder that has gone can stay or be removed.
    const set = repoSet(edit.repo ?? repo ?? '', edit.context ?? contextOf(bead.labels), opts.known, { kept });
    if (repo !== undefined && set.repo !== repo && branchesOf(bead.labels).length > 0) throw new Error(`bead ${id} has a branch in ${repo}`);
    const want = repoSetLabels(set);
    const have = bead.labels.filter((l) => /^(repo|context):/.test(l));
    labels.add = want.filter((l) => !have.includes(l));
    labels.remove = have.filter((l) => !want.includes(l));
  }

  const changed: string[] = FIELDS.filter((k) => next[k] !== current[k]);
  if (labels.add.length || labels.remove.length) changed.push('repos');
  if (changed.length === 0) return { bead, changed: [], rebaselined: false };

  const fields: Parameters<Ctx['beads']['update']>[1] = {};
  for (const k of FIELDS) if (changed.includes(k)) (fields as Record<string, unknown>)[k] = next[k];
  if (labels.add.length) fields.addLabels = labels.add;
  if (labels.remove.length) fields.removeLabels = labels.remove;
  await ctx.beads.update(id, fields);

  // Tell every bound session first: the spec is already changed, whatever happens to the notes below.
  // The edit is saved by now: a binding that cannot be written is a warning, not a failed save.
  const warnings: string[] = [];
  const at = (opts.now ?? new Date()).toISOString();
  try {
    for (const { sessionId } of bindingsFor(ctx.config.trackerDir, id)) {
      patchBinding(ctx.config.trackerDir, sessionId, { specEditedAt: at });
    }
  } catch (e) {
    warnings.push(`Saved. A session bound to this bead was not told of the edit: ${e instanceof Error ? e.message : String(e)}`);
  }

  let rebaselined = false;
  const after = next.acceptance as string;
  // The comment follows the criteria as the engineer sees them (text and check, count and order).
  // The baseline follows the hash, which the hooks share and which covers the text only.
  if (planApprovedAt(bead.notes) !== undefined && criteriaSig(bead.acceptance_criteria) !== criteriaSig(after)) {
    try {
      // No criteria left (a chore) is a baseline too, so the hooks stop reporting a change.
      if (criteriaHash(bead.acceptance_criteria) !== criteriaHash(after)) {
        await writeBaseline(ctx, id, after);
        rebaselined = true;
      }
      await ctx.beads.comment(id, `spec edited in the cockpit: ${changed.join(', ')}`);
    } catch (e) {
      warnings.push(`Saved. The criteria baseline or the comment was not recorded: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const result = { bead: await ctx.beads.show(id), changed, rebaselined };
  return warnings.length ? { ...result, warning: warnings.join(' ') } : result;
}
