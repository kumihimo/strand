import type { Ctx } from '../cli/ctx.ts';
import { captureProblems } from './facts.ts';
import { sameRepoName } from './folders.ts';
import { isRepoLabelName } from './naming.ts';

export const BEAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TYPE = /^[a-z][a-z0-9-]{0,31}$/;

export type NewBeadInput = {
  title: unknown;
  type: unknown;
  priority?: unknown;
  repo?: unknown;
  context?: unknown;
  parent?: unknown;
  description?: unknown;
  acceptance?: unknown;
};

const repoName = (v: unknown): string => {
  if (v === '') throw new Error('invalid repo name: empty');
  if (typeof v !== 'string' || !isRepoLabelName(v)) throw new Error(`invalid repo name ${String(v)}`);
  return v;
};

/**
 * The bead's primary repo and context folders, checked: safe folder names, and in `known` when it is given.
 * A context folder equal to the primary repo, and a repeated one, are dropped (case-insensitive on win32).
 * An empty repo means none. Names in `kept` (already on the bead) are not checked against `known`, so a bead
 * whose folder has gone can still be edited.
 */
export function repoSet(
  repo: unknown,
  context: unknown,
  known?: readonly string[],
  opts: { kept?: readonly string[]; platform?: NodeJS.Platform } = {},
): { repo?: string; context: string[] } {
  const same = (a: string, b: string) => sameRepoName(a, b, opts.platform);
  const primary = repo === undefined || repo === '' ? undefined : repoName(repo);
  if (context !== undefined && !Array.isArray(context)) throw new Error('invalid context');
  const folders: string[] = [];
  for (const c of (context ?? []) as unknown[]) {
    const name = repoName(c);
    if ((primary === undefined || !same(name, primary)) && !folders.some((f) => same(f, name))) folders.push(name);
  }
  if (folders.length && !primary) throw new Error('a bead with context folders needs a primary repo');
  if (known) {
    for (const name of [...(primary ? [primary] : []), ...folders]) {
      if (!known.some((k) => same(k, name)) && !(opts.kept ?? []).some((k) => same(k, name))) throw new Error(`unknown repo ${name}`);
    }
  }
  return primary ? { repo: primary, context: folders } : { context: folders };
}

/** The labels for a repo set: `repo:<primary>` then one `context:<folder>` per folder. */
export function repoSetLabels(s: { repo?: string; context: string[] }): string[] {
  return [...(s.repo ? [`repo:${s.repo}`] : []), ...s.context.map((c) => `context:${c}`)];
}

/**
 * Validate and create a bead (shared by `strand new` and the cockpit). A title, a type and, for a non-epic, a
 * parent are enough: the description and criteria are free text here and are checked at approval.
 * `known` is the repo list the names must be in (the cockpit passes it). Throws plain Errors for bad input.
 */
export async function createBead(ctx: Pick<Ctx, 'beads'>, i: NewBeadInput, known?: readonly string[]) {
  if (typeof i.title !== 'string' || !i.title.trim()) throw new Error('title is required');
  if (i.title.length > 500) throw new Error('title is too long');
  if (typeof i.type !== 'string' || !i.type) throw new Error('--type is required');
  if (!TYPE.test(i.type)) throw new Error(`invalid type ${i.type}`);
  const priority = typeof i.priority === 'string' && i.priority.trim() ? Number(i.priority) : i.priority ?? 2;
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 4) {
    throw new Error(`--priority must be a whole number from 0 to 4, got ${String(i.priority)}`);
  }
  // An empty name clears a repo in an edit; at creation it is a mistake.
  if (i.repo === '') throw new Error('invalid repo name: empty');
  const repos = repoSet(i.repo, i.context, known);
  if (i.parent !== undefined && (typeof i.parent !== 'string' || !BEAD_ID.test(i.parent))) throw new Error(`invalid parent ${String(i.parent)}`);
  for (const k of ['description', 'acceptance'] as const) {
    if (i[k] !== undefined && typeof i[k] !== 'string') throw new Error(`invalid ${k}`);
  }
  const description = i.description as string | undefined;
  const acceptance = i.acceptance as string | undefined;
  const problems = captureProblems({ title: i.title, type: i.type, parent: i.parent as string | undefined });
  if (problems.length) throw new Error(problems[0]);
  return ctx.beads.create({
    title: i.title,
    type: i.type,
    priority,
    labels: repoSetLabels(repos),
    parent: i.parent as string | undefined,
    description,
    acceptance,
  });
}
