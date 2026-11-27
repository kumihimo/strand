// UserPromptSubmit: `/strand:work <id>` claims and binds; any other prompt ports bash `on_prompt`.
import { join } from 'node:path';
import { patchBinding, readBinding } from '../core/binding.ts';
import type { Binding } from '../core/binding.ts';
import { planApprovedAt } from '../core/facts.ts';
import { localStage, parentOf } from '../core/snapshot.ts';
import type { Stage } from '../core/stage.ts';
import type { ListedBead } from '../core/bd.ts';
import { beadBranch, isSafeRepoName, repoOf } from '../core/naming.ts';
import { assertSafeSegment, beadForSession, recordStart } from '../core/sessions.ts';
import { appTitleAsk, appTitleStale, bound, describeBead, ensureIndexed, findBead, isBead, logError, sameFolder, stageChangeLine, titleOf } from './common.ts';
import type { HookDeps, HookResult } from './common.ts';
import { clearWaiting } from './needs-you.ts';

export type PromptInput = { session_id: string; prompt: string; cwd?: string };

const NO_ID =
  'Strand: /strand:work was typed with no bead id, and no bead is bound to this session. Ask the engineer which bead to work (bd ready or bd list --status=in_progress list candidates), then run /strand:work <id>.';

/**
 * `/strand:work <id>`, the pre-rename `/sdlc:work <id>`, or `/work <id>`, else bash `on_prompt`. With no id it works the bead bound to the session,
 * the same way; with no bound bead it tells Claude to ask for an id.
 */
export async function onUserPromptSubmit(input: PromptInput, deps: HookDeps, env: NodeJS.ProcessEnv = process.env): Promise<HookResult> {
  // The engineer answered: the session no longer waits.
  clearWaiting(deps, input.session_id, 'UserPromptSubmit');
  const m = /^\s*\/(?:strand:|sdlc:)?work(?:\s+(\S+)|\s*$)/.exec(input.prompt ?? '');
  if (!m) return onPrompt(input, deps);
  if (m[1] !== undefined) return work(input, m[1], deps, env);
  const id = bound(readBinding(deps.trackerDir, input.session_id));
  if (!isBead(id)) return { additionalContext: NO_ID };
  return work(input, id, deps, env);
}

/** `<workspace>/<repo>` for the bead's repo label, when the label is a safe folder name. */
function repoFolder(workspaceRoot: string, b: ListedBead): string | undefined {
  const repo = repoOf(b);
  return repo && isSafeRepoName(repo) ? join(workspaceRoot, repo) : undefined;
}

/** The in-session twin of `strand work`: record the session, bind, claim, then context. No plan approval. */
async function work(input: PromptInput, typed: string, deps: HookDeps, env: NodeJS.ProcessEnv): Promise<HookResult> {
  assertSafeSegment(typed, 'bead id');
  const s = await deps.snapshot();
  // Unknown id: throw before any write, so a typo leaves no index entry or binding.
  let bead = findBead(s, typed);
  if (!bead) throw new Error(`bead ${typed} not found`);
  const id = bead.id;
  const sid = input.session_id;
  const fresh = beadForSession(deps.trackerDir, sid) !== id;
  if (fresh) recordStart(deps.trackerDir, { sessionId: sid, beadId: id, branch: beadBranch(bead) });
  // A child of the approved epic keeps the epic walk going; any other bead ends it.
  const current = readBinding(deps.trackerDir, sid).epic;
  const epic = bead.issue_type === 'epic' ? id : current && parentOf(bead) === current ? current : undefined;
  // The stage once the claim below lands, so the first prompt after an approval says the stage changed.
  const stage = localStage(bead.status === 'open' ? { ...bead, status: 'in_progress' } : bead);
  patchBinding(deps.trackerDir, sid, {
    bead: id,
    none: undefined,
    epic,
    approved: undefined,
    dirty: undefined,
    nagged: undefined,
    learnAsked: undefined,
    lastStage: stage,
  });
  if (bead.status === 'open') {
    await deps.beads.claim(id);
    bead = { ...bead, status: 'in_progress' };
    s.beads.set(id, bead);
  }
  if (fresh) await deps.beads.comment(id, `session ${sid} started`);
  const { context } = await describeBead(id, s, deps, env);
  const cwd = input.cwd || process.cwd();
  const dir = repoFolder(deps.workspaceRoot, bead);
  const warning = dir && !sameFolder(cwd, dir) ? `Warning: this session's folder is ${cwd}, but bead ${id} belongs to ${dir}\n` : '';
  return { additionalContext: warning + context, sessionTitle: titleOf(bead) };
}

/** bash `on_prompt`: remind Claude of the bound bead, or of how to bind one, and title the chat. */
async function onPrompt(input: PromptInput, deps: HookDeps): Promise<HookResult> {
  const b = readBinding(deps.trackerDir, input.session_id);
  const id = bound(b);
  if (!id) {
    return {
      additionalContext:
        "Bead workflow: no bead is bound to this session. Questions and read-only work need none. For new work, enter plan mode before the first file edit and put one line in the plan: 'Bead: <id>' for an existing bead (find it with bd search <words>, bd ready, bd list --status=in_progress), 'Bead: new' to file one with strand new once approved, or 'Bead: none'. Approving the plan claims the bead. For a large feature, name its epic and plan its child beads as the tasks. A one-line change may skip plan mode: confirm the bead with AskUserQuestion, then run 'bd update <id> --claim', or 'strand none' if the user says no bead is needed.",
    };
  }
  if (id === 'none') return {};
  ensureIndexed(deps.trackerDir, input.session_id, id);
  let title: string | undefined;
  let stage: Stage | undefined;
  let approved = false;
  try {
    const bead = findBead(await deps.snapshot(), id);
    if (bead) {
      title = titleOf(bead);
      stage = localStage(bead);
      approved = planApprovedAt(bead.notes) !== undefined;
    }
  } catch (e) {
    // bash: a failed title_of leaves the title empty; the reminder still goes out.
    logError('UserPromptSubmit', 'no title', e);
  }
  // RFC 0003 section 1: a desktop session learns of a cockpit approval from the next prompt.
  let stageLine = '';
  let changed = '';
  const patch: Partial<Binding> = {};
  if (stage) {
    stageLine = ` Stage: ${stage}.`;
    if (b.lastStage && b.lastStage !== stage) changed = stageChangeLine(b.lastStage, stage);
    if (b.lastStage !== stage) patch.lastStage = stage;
    if (approved && !b.approved) patch.approved = true; // the Edit gate then needs no bd call
  }
  // The engineer edited the spec in the cockpit: say so once, in the same write that updates the stage.
  let edited = '';
  if (b.specEditedAt) {
    edited = `The engineer edited the spec of ${id} in the cockpit. Re-read it before you continue: bd -C "${deps.trackerDir}" show ${id}.`;
    patch.specEditedAt = undefined;
  }
  if (Object.keys(patch).length > 0) patchBinding(deps.trackerDir, input.session_id, patch);
  const ask = appTitleStale(deps.entrypoint, b, title) ? ` ${appTitleAsk(title)}` : '';
  const prefix = deps.branchPrefix ?? '<username>';
  const reminder = b.epic
    ? `Bead workflow: the user approved epic ${b.epic} and this session is on ${id}. Claim each ready child in turn (bd ready --parent ${b.epic}) without asking again. Each child gets its own branch, ${prefix}/<topic> with no bead id, made with but branch new and committed to with but commit --branch <name>.`
    : `Bead workflow: this session is bead ${id}, and only that bead. Its branch is ${prefix}/<topic> with no bead id, made with but branch new, and every commit names it with but commit --branch <name>. Keep bead ids out of branch names, commit messages, PR titles and bodies. Unrelated work belongs in a new session.`;
  const additionalContext = [reminder + stageLine + ask, changed, edited].filter(Boolean).join('\n');
  return title ? { additionalContext, sessionTitle: title } : { additionalContext };
}
