import type { Ctx } from '../cli/ctx.ts';
import { bindingsFor, patchBinding } from './binding.ts';
import { planApprovedAt } from './facts.ts';
import { loadSnapshot } from './snapshot.ts';

/**
 * Give a Specify bead back to Backlog: status `open`, and no session bound to it any more.
 * Specify is `in_progress` with no `plan-approved` note. A live terminal must be stopped first.
 * Sessions that were bound hear about it from their hooks on the next prompt (no bead is bound).
 * Only the bead and the state that belongs to it are cleared: `none`, `epic`, `appTitle` and the rest stay.
 * The status is written first. Each unbind stands alone: one that fails does not stop the others, and
 * nothing is thrown for it (the release has happened). The counts say how many worked.
 */
export async function releaseClaim(
  ctx: Pick<Ctx, 'beads' | 'config'>,
  id: string,
  o: { hasLiveTerminal: boolean },
): Promise<{ unbound: number; failed: number }> {
  const b = (await loadSnapshot(ctx.beads)).beads.get(id);
  if (!b) throw new Error(`bead ${id} not found`);
  if (b.status !== 'in_progress' || planApprovedAt(b.notes) !== undefined) throw new Error(`bead ${id} is not in Specify`);
  if (o.hasLiveTerminal) throw new Error(`bead ${id} has a live session`);
  await ctx.beads.setStatus(id, 'open');
  let unbound = 0;
  let failed = 0;
  let bound: ReturnType<typeof bindingsFor>;
  try {
    bound = bindingsFor(ctx.config.trackerDir, id);
  } catch {
    // The release has happened. Say that the bindings could not be read, do not throw.
    return { unbound: 0, failed: 1 };
  }
  for (const { sessionId } of bound) {
    try {
      patchBinding(ctx.config.trackerDir, sessionId, {
        bead: undefined,
        approved: undefined,
        dirty: undefined,
        nagged: undefined,
        lastStage: undefined,
        specEditedAt: undefined,
      });
      unbound++;
    } catch {
      failed++;
    }
  }
  return { unbound, failed };
}
