import type { BeadCard } from '../../../src/cockpit/model.ts';
import { move } from '../../../src/core/queue.ts';

/** Tick or untick `id`. The list keeps the order things were ticked in, which is the order they are queued in. */
export function toggleSelection(sel: readonly string[], id: string): string[] {
  return sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
}

/** The 1-based place of `id` in the selection, or undefined when it is not ticked. */
export function selectionNumber(sel: readonly string[], id: string): number | undefined {
  const i = sel.indexOf(id);
  return i < 0 ? undefined : i + 1;
}

/** An epic child gets a checkbox when it can be queued: in Backlog, not on hold, not queued already. */
export function canSelectChild(c: Pick<BeadCard, 'id' | 'stage' | 'held'>, queued: ReadonlySet<string>): boolean {
  return c.stage === 'backlog' && !c.held && !queued.has(c.id);
}

/** The queue with `id` one place earlier (-1) or later (+1). At an end it stays put. */
export function moveBy(q: readonly string[], id: string, by: -1 | 1): string[] {
  const i = q.indexOf(id);
  if (i < 0 || i + by < 0) return [...q];
  return move(q, id, i + by);
}
