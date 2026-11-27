// Stop: a port of `on_stop`, `nag_once` and `finish` in ~/.claude/hooks/bead-workflow.sh.
// Changes from bash: no in-review label (review is the derived stage), a verified bead with a branch or PR
// stays open until it merges, and the first stop in review asks the close-and-learn question once.
// A bd failure throws to runHook, which logs it: the binding is never cleared because bd failed.
import { createHash } from 'node:crypto';
import { patchBinding, readBinding } from '../core/binding.ts';
import type { Binding } from '../core/binding.ts';
import type { ListedBead } from '../core/bd.ts';
import { branchesOf, parseCriteria, prsOf, unverifiedTicks } from '../core/facts.ts';
import { localStage } from '../core/snapshot.ts';
import { appTitleAsk, appTitleStale, bound, findBead, isBead, mergeOf, release, titleOf } from './common.ts';
import type { HookDeps, HookResult } from './common.ts';
import { markWaiting } from './needs-you.ts';

export type StopInput = { session_id: string; cwd: string; stop_hook_active?: boolean };

export type StopDeps = Pick<HookDeps, 'trackerDir' | 'entrypoint' | 'snapshot' | 'remoteRepo' | 'mergedPrNumbers' | 'mergedByChangeId'> & {
  beads: Pick<HookDeps['beads'], 'close'>;
};

/**
 * Stop, then the needs-you mark: a stop that is let through means Claude waits for the next prompt. A stop that
 * is blocked sends Claude back to work, so it is not marked. A handler error is let through by runHook, so the
 * turn ends there too and it is marked.
 */
export async function onStop(input: StopInput, deps: StopDeps): Promise<HookResult> {
  let blocked = false;
  try {
    const result = await decide(input, deps);
    blocked = result.block !== undefined;
    return result;
  } finally {
    if (!blocked) markWaiting(deps, input.session_id, 'Stop');
  }
}

/** bash `on_stop`. */
async function decide(input: StopInput, deps: StopDeps): Promise<HookResult> {
  if (input.stop_hook_active === true) return {};
  const sid = input.session_id;
  const b = readBinding(deps.trackerDir, sid);
  const id = bound(b);
  if (!isBead(id)) return {};
  const bead = findBead(await deps.snapshot(), id);
  if (!bead) {
    // The snapshot loaded (a failed read throws above) and the bead is gone: deleted elsewhere.
    release(deps.trackerDir, sid, b, id);
    return { systemMessage: `Bead ${id} is no longer in the tracker. This session is no longer bound to it.` };
  }
  if (bead.status === 'closed') {
    release(deps.trackerDir, sid, b, id);
    return {};
  }
  // Close on merge from the chat that holds the bead, not only at the next session start.
  const merged = await mergeOf(deps, input.cwd || '.', bead);
  if (merged) {
    await deps.beads.close(id, merged.reason, sid);
    release(deps.trackerDir, sid, b, id);
    return { systemMessage: `Closed bead ${id}: its ${merged.via === 'pr' ? 'PR' : 'branch'} merged.` };
  }
  const title = titleOf(bead);
  if (appTitleStale(deps.entrypoint, b, title) && nagOnce(deps, sid, b, `title:${title}`)) return { block: appTitleAsk(title) };
  if (localStage(bead) === 'review') {
    if (b.learnAsked) return {};
    patchBinding(deps.trackerDir, sid, { learnAsked: true });
    return {
      block: `Bead ${id} is in review. Ask the engineer once: "What did you correct?" For each answer propose a CLAUDE.md rule, a test or a skill change, and apply only what they accept. Do not wait on this to finish.`,
    };
  }
  const criteria = parseCriteria(bead.acceptance_criteria);
  const open = criteria.filter((c) => !c.ticked).length;
  const ticked = criteria.length - open;
  const unverified = unverifiedTicks(criteria);
  if (open === 0 && ticked > 0 && unverified === 0) return finish(deps, sid, b, bead);
  if (open === 0 && ticked > 0) {
    if (!nagOnce(deps, sid, b, bead.acceptance_criteria ?? '')) return {};
    return {
      block: `Every criterion of bead ${id} is ticked, but ${unverified} have no '(verified: ...)' evidence. Run the check each one names, then add the evidence (bd update ${id} --acceptance '<full list>'), or untick it. If you cannot run a check, say which and why.`,
    };
  }
  if (b.dirty) {
    patchBinding(deps.trackerDir, sid, { dirty: undefined });
    return {
      block: `Bead ${id} is in progress and files changed this turn. Check its acceptance criteria (bd show ${id}). A criterion is met only when the check it names passes: run it, then tick the line with the evidence, as '- [x] <criterion> (verified: <command> passed)', using bd update ${id} --acceptance '<full list>'. If no command can check a criterion, ask the user and write '(verified: user confirmed)'. If the bead has no criteria, ask the user whether it is done. Otherwise say which criteria remain.`,
    };
  }
  return {};
}

/** bash `nag_once`: true the first time for this text, false while the text stays the same. */
function nagOnce(deps: StopDeps, sid: string, b: Binding, text: string): boolean {
  const sum = createHash('sha1').update(text).digest('hex');
  if (b.nagged === sum) return false;
  b.nagged = sum;
  patchBinding(deps.trackerDir, sid, { nagged: sum });
  return true;
}

/**
 * bash `finish`: every criterion is verified. With a branch or PR the bead waits for its merge, still bound so
 * the chat keeps its title, unless an approved epic has a next child. Otherwise it closes now.
 */
async function finish(deps: StopDeps, sid: string, b: Binding, bead: ListedBead): Promise<HookResult> {
  const id = bead.id;
  const hasPr = prsOf(bead.labels).length > 0;
  if (branchesOf(bead.labels).length > 0 || hasPr) {
    if (b.epic) {
      release(deps.trackerDir, sid, b, id);
    } else if (!nagOnce(deps, sid, b, `verified:${id}`)) {
      return {};
    }
    // A PR opened by hand has no pr: label, and without it the merge is never seen.
    const next = hasPr
      ? 'It closes when its PR merges.'
      : 'Open the PR with strand pr; if one is already open, run strand pr anyway: it adds the label. The bead closes when its PR merges.';
    return { systemMessage: `Bead ${id}: every criterion is verified. ${next}` };
  }
  await deps.beads.close(id, 'All acceptance criteria verified', sid);
  release(deps.trackerDir, sid, b, id);
  return { systemMessage: `Closed bead ${id}: every acceptance criterion is verified.` };
}
