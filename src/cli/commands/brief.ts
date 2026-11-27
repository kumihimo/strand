import { parseArgs } from 'node:util';
import type { ListedBead } from '../../core/bd.ts';
import { specReady } from '../../core/facts.ts';
import { liveSessions } from '../../core/sessions.ts';
import { isWorkItem, loadSnapshot, localStage, wipOf } from '../../core/snapshot.ts';
import type { Snapshot } from '../../core/snapshot.ts';
import type { Stage } from '../../core/stage.ts';
import { checkBuild } from '../../core/wip.ts';
import type { Ctx } from '../ctx.ts';

type Item = { id: string; title: string };

export type Brief = {
  /** Beads in `review`, and beads in `specify` whose criteria wait for approval. */
  waiting: (Item & { action: 'approve spec' | 'review' })[];
  ready: (Item & { priority: number })[];
  blocked: (Item & { blockers: string[] })[];
  /** `warning` is the WIP limit reached, if any (RFC 0003 section 8). */
  wip: { build: { count: number; limit: number }; review: { count: number; limit: number }; warning?: string };
  sessions: { sessionId: string; beadId: string; startedAt: string }[];
};

/** What a bead in this stage waits on you for: a review, or approval of a spec that meets the approval rules. */
export function waitingAction(stage: Stage, specReady: boolean): 'approve spec' | 'review' | undefined {
  if (stage === 'review') return 'review';
  if (stage === 'specify' && specReady) return 'approve spec';
  return undefined;
}

/** Open `blocks` dependencies: beads this one waits on that are not closed. */
function blockersOf(s: Snapshot, b: ListedBead): string[] {
  return b.dependencies.filter((d) => d.type === 'blocks' && s.beads.get(d.depends_on_id)?.status !== 'closed').map((d) => d.depends_on_id);
}

/** What needs you, what is ready, what is stuck, WIP and live sessions, from one bd call. */
export async function collectBrief(ctx: Pick<Ctx, 'beads' | 'config'>): Promise<Brief> {
  const s = await loadSnapshot(ctx.beads);
  const waiting: Brief['waiting'] = [];
  const blocked: Brief['blocked'] = [];
  const ready: Brief['ready'] = [];
  for (const b of s.beads.values()) {
    if (!isWorkItem(b)) continue;
    const item = { id: b.id, title: b.title };
    const stage = localStage(b);
    const action = waitingAction(stage, specReady({ type: b.issue_type, description: b.description, acceptance: b.acceptance_criteria }));
    if (action) waiting.push({ ...item, action });
    const blockers = blockersOf(s, b);
    if (b.status === 'blocked' || blockers.length > 0) blocked.push({ ...item, blockers });
    else if (b.status === 'open') ready.push({ ...item, priority: b.priority });
  }
  ready.sort((a, b) => a.priority - b.priority);
  const c = wipOf(s);
  const { wip: limits } = ctx.config;
  const wip: Brief['wip'] = { build: { count: c.build, limit: limits.build }, review: { count: c.review, limit: limits.review } };
  const reason = checkBuild(c, limits, 'warn').reason;
  if (reason) wip.warning = reason;
  const sessions = liveSessions(ctx.config.trackerDir).map(({ sessionId, beadId, startedAt }) => ({ sessionId, beadId, startedAt }));
  return { waiting, ready, blocked, wip, sessions };
}

function section(ctx: Ctx, title: string, lines: string[]): void {
  ctx.out(title);
  for (const l of lines.length ? lines : ['(none)']) ctx.out(`  ${l}`);
  ctx.out('');
}

/** `strand brief`: what needs you, what is ready, what is stuck, WIP and live sessions. */
export async function main(args: string[], ctx: Ctx): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
  const b = await collectBrief(ctx);
  if (values.json) {
    ctx.out(JSON.stringify(b));
    return 0;
  }
  section(ctx, 'Waiting on you', b.waiting.map((w) => `${w.id}  ${w.action}  ${w.title}`));
  section(ctx, 'Ready', b.ready.map((r) => `${r.id}  P${r.priority}  ${r.title}`));
  section(ctx, 'Blocked', b.blocked.map((x) => `${x.id}  ${x.title}${x.blockers.length ? `  (by ${x.blockers.join(', ')})` : ''}`));
  section(ctx, 'WIP', [
    `Build ${b.wip.build.count}/${b.wip.build.limit}`,
    `Review ${b.wip.review.count}/${b.wip.review.limit}`,
    ...(b.wip.warning ? [`warning: ${b.wip.warning}`] : []),
  ]);
  section(ctx, 'Live sessions', b.sessions.map((s) => `${s.beadId}  ${s.sessionId}  since ${s.startedAt}`));
  return 0;
}
