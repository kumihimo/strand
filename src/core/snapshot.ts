// One in-memory snapshot of every bead, shared by hooks, CLI and cockpit.
import type { Beads, ListedBead } from './bd.ts';
import { allVerified, parseCriteria, planApprovedAt, branchesOf, prsOf } from './facts.ts';
import { deriveStage } from './stage.ts';
import type { Stage, StageFacts } from './stage.ts';
import { wipCounts } from './wip.ts';
import type { WipCounts } from './wip.ts';

/**
 * Every bead by id. `prefixes` holds each distinct id prefix (the text before the first `-`), sorted: a tracker
 * keeps its old `sdlc-` ids when new beads get `strand-` ones (ADR 0021).
 */
export type Snapshot = { beads: Map<string, ListedBead>; ids: Set<string>; prefixes: string[] };

/** The snapshot of a list of beads. */
export function snapshotOf(all: readonly ListedBead[]): Snapshot {
  const map = new Map<string, ListedBead>();
  const prefixes = new Set<string>();
  for (const b of all) {
    map.set(b.id, b);
    const dash = b.id.indexOf('-');
    if (dash > 0) prefixes.add(b.id.slice(0, dash));
  }
  return { beads: map, ids: new Set(map.keys()), prefixes: [...prefixes].sort() };
}

/** Read every bead with exactly one bd call. */
export async function loadSnapshot(beads: Pick<Beads, 'listAll'>): Promise<Snapshot> {
  return snapshotOf(await beads.listAll());
}

/** Stage facts from the bead's own fields. A `pr:` label means an open PR with unknown CI (no forge call). */
export function localFacts(b: ListedBead): StageFacts {
  const f: StageFacts = {
    status: b.status,
    planApproved: planApprovedAt(b.notes) !== undefined,
    verified: allVerified(parseCriteria(b.acceptance_criteria)),
    hasBranch: branchesOf(b.labels).length > 0,
  };
  if (prsOf(b.labels).length > 0) f.pr = { state: 'open', ci: 'unknown' };
  return f;
}

export function localStage(b: ListedBead): Stage {
  return deriveStage(localFacts(b));
}

/** The parent epic: the `parent` field, else the `parent-child` dependency (bd list does not always set `parent`). */
export function parentOf(b: ListedBead): string | undefined {
  return b.parent ?? b.dependencies.find((d) => d.type === 'parent-child')?.depends_on_id;
}

export function isWorkItem(b: ListedBead): boolean {
  return b.issue_type !== 'epic' && b.issue_type !== 'gate' && b.status !== 'closed';
}

/** WIP counts over open work items, optionally leaving one bead out. */
export function wipOf(s: Snapshot, exclude?: string): WipCounts {
  const items: { stage: Stage; status: string }[] = [];
  for (const b of s.beads.values()) {
    if (b.id !== exclude && isWorkItem(b)) items.push({ stage: localStage(b), status: b.status });
  }
  return wipCounts(items);
}

/**
 * The bead by id. Like bd, an id typed without its prefix (`a1b` for `sub-a1b`) also resolves, when exactly one
 * prefix gives a bead; a short id two prefixes share resolves to none.
 */
export function findBead(s: Snapshot, id: string): ListedBead | undefined {
  const exact = s.beads.get(id);
  if (exact) return exact;
  const hits = s.prefixes.map((p) => s.beads.get(`${p}-${id}`)).filter((b) => b !== undefined);
  return hits.length === 1 ? hits[0] : undefined;
}
