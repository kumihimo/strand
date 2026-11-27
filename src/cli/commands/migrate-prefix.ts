import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { applyPrefixMigration, planPrefixMigration, PrefixMigrationError } from '../../core/migrate-prefix.ts';
import type { PrefixPlan } from '../../core/migrate-prefix.ts';
import { loadSnapshot } from '../../core/snapshot.ts';
import type { Ctx } from '../ctx.ts';

const USAGE = 'usage: strand migrate-prefix <old> <new> [--apply] [--json]';

const KINDS = [
  ['artefacts', 'artefacts folders'],
  ['session', 'session entries'],
  ['binding', 'bindings'],
  ['handover', 'handovers'],
] as const;

function planLines(plan: PrefixPlan): string[] {
  const lines = plan.items.map(
    (i) => `${i.kind.padEnd(9)}  ${i.path}  ${i.ids.map((c) => `${c.field} ${c.from} -> ${c.to}`).join(', ')}`,
  );
  for (const c of plan.conflicts) lines.push(`${'conflict'.padEnd(9)}  ${c.path}  ${c.target} already exists, left alone`);
  const counts = KINDS.map(([k, name]) => `${name}: ${plan.items.filter((i) => i.kind === k).length}`);
  lines.push(`${counts.join(', ')}, conflicts: ${plan.conflicts.length}`);
  return lines;
}

const beadsWord = (n: number) => `${n} bead${n === 1 ? '' : 's'}`;

/**
 * `strand migrate-prefix <old> <new> [--apply] [--json]`: after `bd rename-prefix`, move the artefacts folders and
 * rewrite the session entries, bindings and handovers that still name an old id. Dry run unless `--apply`.
 */
export async function main(args: string[], ctx: Ctx): Promise<number> {
  let values: { apply?: boolean; json?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { apply: { type: 'boolean' }, json: { type: 'boolean' } },
    }));
  } catch (e) {
    ctx.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    ctx.err(USAGE);
    return 2;
  }
  if (positionals.length !== 2) {
    ctx.err(USAGE);
    return 2;
  }
  const tracker = ctx.config.trackerDir;
  let plan: PrefixPlan;
  try {
    plan = planPrefixMigration(tracker, positionals[0], positionals[1]);
  } catch (e) {
    ctx.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const snapshot = await loadSnapshot(ctx.beads);
  const left = [...snapshot.ids].filter((id) => id.startsWith(`${plan.from}-`)).length;
  const notRenamed = `bd still holds ${beadsWord(left)} named ${plan.from}-: run bd -C "${tracker}" rename-prefix ${plan.to}- first`;

  if (!values.apply) {
    if (values.json) {
      ctx.out(JSON.stringify({ ...plan, beadsWithOldPrefix: left }, null, 2));
      return 0;
    }
    ctx.out(`Tracker: ${tracker} (${beadsWord(snapshot.beads.size)})`);
    ctx.out(`Prefix: ${plan.from}- -> ${plan.to}-`);
    for (const l of planLines(plan)) ctx.out(l);
    if (left > 0) ctx.out(notRenamed);
    ctx.out('Dry run: nothing changed. Rerun with --apply to make these changes.');
    return 0;
  }

  if (left > 0) {
    ctx.err(`error: ${beadsWord(left)} still named ${plan.from}-. Nothing changed. Run bd -C "${tracker}" rename-prefix ${plan.to}- first.`);
    return 1;
  }
  let applied: number;
  let failure: string | undefined;
  try {
    applied = applyPrefixMigration(tracker, plan).applied;
  } catch (e) {
    if (!(e instanceof PrefixMigrationError)) throw e;
    applied = e.applied;
    failure = e.message;
  }
  const moved = plan.items.slice(0, applied).some((i) => i.kind === 'artefacts');
  if (values.json) {
    ctx.out(JSON.stringify({ ...plan, applied, ...(failure ? { error: failure } : {}) }, null, 2));
  } else {
    ctx.out(`Tracker: ${tracker}`);
    ctx.out(`Prefix: ${plan.from}- -> ${plan.to}-`);
    for (const l of planLines(plan)) ctx.out(l);
    ctx.out(`Applied ${applied} of ${plan.items.length}.`);
    if (failure) ctx.out(`Stopped: ${failure}. Rerun strand migrate-prefix ${plan.from} ${plan.to} --apply to finish.`);
    if (plan.conflicts.length > 0) ctx.out('Move or merge each conflicting folder by hand, then rerun.');
    if (moved && existsSync(path.join(tracker, '.git'))) {
      ctx.out(`Commit the renamed artefacts folders in the tracker: git -C "${tracker}" add -A artefacts, then git -C "${tracker}" commit.`);
    }
  }
  return failure || plan.conflicts.length > 0 ? 1 : 0;
}
