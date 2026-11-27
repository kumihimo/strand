export type Stage = 'backlog' | 'specify' | 'build' | 'verify' | 'review' | 'done';

export type PrFacts = {
  state: 'open' | 'merged' | 'closed';
  ci: 'unknown' | 'none' | 'pending' | 'running' | 'success' | 'failure';
};

export type StageFacts = {
  status: string;
  planApproved: boolean;
  verified: boolean;
  hasBranch: boolean;
  pr?: PrFacts;
};

/** A blocked or deferred bead is on hold: it keeps its stage but does not count toward WIP. */
export function isHeld(status: string): boolean {
  return status === 'blocked' || status === 'deferred';
}

/**
 * Derive a bead's stage from its facts (RFC 0003 section 2). Pure: no I/O.
 * `hasBranch` is part of the facts but does not change the result today: a verified bead
 * without a PR is `verify` either way, and the caller closes it when it has no branch.
 */
export function deriveStage(f: StageFacts): Stage {
  if (f.status === 'closed') return 'done';
  if (!f.planApproved) return f.status === 'in_progress' ? 'specify' : 'backlog';
  if (!f.verified) return 'build';
  if (f.pr?.state === 'merged') return 'review';
  if (f.pr?.state === 'open' && (f.pr.ci === 'success' || f.pr.ci === 'unknown')) return 'review';
  return 'verify';
}

/** The state word in a chat title. */
export function titleState(stage: Stage, status: string): 'WIP' | 'REVIEW' | 'HOLD' | 'DONE' {
  if (stage === 'done') return 'DONE';
  if (isHeld(status)) return 'HOLD';
  if (stage === 'review') return 'REVIEW';
  return 'WIP';
}
