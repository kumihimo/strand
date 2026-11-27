import type { BeadCard } from '../../../src/cockpit/model.ts';
import type { Stage } from '../../../src/core/stage.ts';

/** A board column: one per stage, plus Queued, which holds queued Backlog beads (ADR 0023). */
export type ColumnKey = Stage | 'queued';

const LABELS: Record<Stage, string> = {
  backlog: 'Backlog',
  specify: 'Specify',
  build: 'Build',
  verify: 'Verify',
  review: 'Review',
  done: 'Done',
};

export const stageLabel = (s: Stage): string => LABELS[s];

const byPriority = (a: BeadCard, b: BeadCard) => a.priority - b.priority || a.id.localeCompare(b.id);

/**
 * Group cards into the board columns, one per stage, sorted by priority then id. A Backlog card whose id is in
 * `queue` goes to Queued instead, in queue order. A queued id in another stage stays there: the server drops it.
 */
export function columnsFor(cards: BeadCard[], queue: readonly string[] = []): Record<ColumnKey, BeadCard[]> {
  const cols: Record<ColumnKey, BeadCard[]> = { backlog: [], queued: [], specify: [], build: [], verify: [], review: [], done: [] };
  const at = new Map(queue.map((id, i) => [id, i]));
  for (const c of [...cards].sort(byPriority)) cols[c.stage === 'backlog' && at.has(c.id) ? 'queued' : c.stage].push(c);
  cols.queued.sort((a, b) => at.get(a.id)! - at.get(b.id)!);
  return cols;
}

export const wipState = (n: number, limit: number): 'ok' | 'full' => (n >= limit ? 'full' : 'ok');

export type StatusPillText = 'closed' | 'on hold' | 'blocked' | 'awaiting approval' | 'ready' | 'in progress';

/** The one status pill a card shows. A held bead (blocked or deferred status) reads "on hold". */
export function statusPill(c: BeadCard): StatusPillText {
  if (c.status === 'closed' || c.stage === 'done') return 'closed';
  if (c.held) return 'on hold';
  if (c.blockedBy.length > 0) return 'blocked';
  if (c.awaitingApproval) return 'awaiting approval';
  if (c.ready) return 'ready';
  return 'in progress';
}

export type SessionLight = { state: 'working' | 'waiting'; label: string };

/**
 * The one session light a card shows. `waiting`: a live session has stopped and waits for the engineer.
 * `working`: a session is live (the tracker says so, or this cockpit has a terminal open for the bead).
 * No light: no session.
 */
export function sessionLight(c: Pick<BeadCard, 'live' | 'needsYou'>, terminal = false): SessionLight | undefined {
  if (c.needsYou) return { state: 'waiting', label: 'Claude is waiting for you' };
  if (terminal) return { state: 'working', label: 'Claude session live, terminal open here' };
  if (c.live) return { state: 'working', label: 'Claude session live' };
  return undefined;
}

/** The board's legend for the light, in the order shown. */
export const SESSION_LEGEND: { state: SessionLight['state']; text: string }[] = [
  { state: 'working', text: 'session live' },
  { state: 'waiting', text: 'needs you' },
];

export type ExtraPill ={ label: string; className: string; title: string };

/** Pills shown next to the status pill. */
export function extraPills(c: BeadCard): ExtraPill[] {
  return c.ciUnknown
    ? [{ label: 'CI unknown', className: 'st-ci-unknown', title: 'The forge did not report CI for this PR' }]
    : [];
}
