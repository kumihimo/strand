/**
 * The work queue: an ordered list of bead ids, first in, first out (ADR 0023). Pure: no I/O.
 * Every function returns a new array and leaves its input alone.
 */
export type Queue = readonly string[];

/** Append `ids` in the order given. An id already queued, or repeated in `ids`, keeps its first place. */
export function enqueue(q: Queue, ids: readonly string[]): string[] {
  const out = [...q];
  const seen = new Set(q);
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** The front id and the rest. An empty queue gives no id. */
export function dequeue(q: Queue): { id: string | undefined; rest: string[] } {
  return { id: q[0], rest: q.slice(1) };
}

/** The queue without `id`. */
export function remove(q: Queue, id: string): string[] {
  return q.filter((x) => x !== id);
}

/** Move `id` to position `to` (0 is the front; past the end is last). An id not queued changes nothing. */
export function move(q: Queue, id: string, to: number): string[] {
  if (!Number.isInteger(to) || to < 0) throw new Error(`index must be a whole number from 0, got ${to}`);
  if (!q.includes(id)) return [...q];
  const out = remove(q, id);
  out.splice(Math.min(to, out.length), 0, id);
  return out;
}

/**
 * The queue in the order `ids` gives: some or all of the queued ids, each once. Leaving an id out removes it.
 * Anything else is refused, so a stale client cannot add beads this way.
 */
export function reorder(q: Queue, ids: readonly string[]): string[] {
  const queued = new Set(q);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`id given more than once: ${id}`);
    if (!queued.has(id)) throw new Error(`not queued: ${id}`);
    seen.add(id);
  }
  return [...ids];
}

/** The ids for which `keep` is true, in order. */
export function prune(q: Queue, keep: (id: string) => boolean): string[] {
  return q.filter(keep);
}

/** How many more beads may start: the room left under `limit`, never below 0. */
export function freeSlots(inProgress: number, limit: number): number {
  return Math.max(0, limit - inProgress);
}
