import { isHeld } from './stage.ts';
import type { Stage } from './stage.ts';

export type WipCounts = { build: number; review: number };
export type WipMode = 'warn' | 'refuse';

/** Count the stages that hold WIP: Build and Review. Held beads do not count. */
export function wipCounts(items: { stage: Stage; status: string }[]): WipCounts {
  const live = items.filter((i) => !isHeld(i.status));
  return {
    build: live.filter((i) => i.stage === 'build').length,
    review: live.filter((i) => i.stage === 'review').length,
  };
}

/**
 * Check whether Build may start. Review is checked first.
 * `reason` is set whenever a limit is hit. `ok` is false only in `refuse` mode.
 */
export function checkBuild(c: WipCounts, l: WipCounts, mode: WipMode): { ok: boolean; reason?: string } {
  let reason: string | undefined;
  if (c.review >= l.review) reason = `Review is at its WIP limit (${c.review}/${l.review})`;
  else if (c.build >= l.build) reason = `Build is at its WIP limit (${c.build}/${l.build})`;
  if (reason === undefined) return { ok: true };
  return { ok: mode !== 'refuse', reason };
}
