// PostToolUse tracking: a port of the track rules in ~/.claude/hooks/bead-workflow.sh.
// One function per bash function, in the bash file's order. `label_pr` is ported too, for a PR opened by hand;
// `strand pr` adds the same label.
// Binding state lives in the session binding file (core/binding.ts), not in ~/.claude/state/beads.
// Nothing here denies. An error in one command of a line is logged to stderr and the rest still run;
// any other thrown error propagates to runHook, which logs it and exits 0.
import { patchBinding, readBinding } from '../core/binding.ts';
import type { Binding } from '../core/binding.ts';
import type { ListedBead } from '../core/bd.ts';
import { findBead } from '../core/snapshot.ts';
import type { approveSpec } from '../core/approve.ts';
import { GLOBAL_VALUE_FLAGS, UPDATE_VALUE_FLAGS, flagValue, parseCommands, positional } from './parse.ts';
import { clearWaiting } from './needs-you.ts';
import type { HookResult, TrackDeps } from './runtime.ts';
import type { GateInput } from './gate.ts';

export type TrackInput = GateInput & { tool_response?: unknown };

const APP_TITLE_TOOL = 'mcp__ccd_session_mgmt__set_session_title';
const STACK_FLAGS = ['-A', '--above', '-B', '--below'];
const MESSAGE_FLAGS = ['-m', '--message'];

/** One hook call: the input, the deps, and the snapshot, read at most once. */
class Track {
  input: TrackInput;
  deps: TrackDeps;
  #snapshot: ReturnType<TrackDeps['snapshot']> | undefined;

  constructor(input: TrackInput, deps: TrackDeps) {
    this.input = input;
    this.deps = deps;
  }

  get cwd(): string {
    return this.input.cwd || '.';
  }

  get sessionId(): string {
    return this.input.session_id;
  }

  binding(): Binding {
    return readBinding(this.deps.trackerDir, this.sessionId);
  }

  patch(p: Partial<Binding>): void {
    patchBinding(this.deps.trackerDir, this.sessionId, p);
  }

  /** bash `bound`: the bead id, `none`, or undefined. Read fresh: this hook changes it. */
  bound(): string | undefined {
    const b = this.binding();
    return b.bead || (b.none ? 'none' : undefined);
  }

  snapshot() {
    return (this.#snapshot ??= this.deps.snapshot());
  }

  /** The bead by id. Like bd, an id typed without its prefix (`a1b` for `sub-a1b`) also resolves. */
  async bead(id: string): Promise<ListedBead | undefined> {
    const s = await this.snapshot();
    return findBead(s, id);
  }

  /** The bead, and whether the snapshot loaded at all. A snapshot that fails to load is logged, not thrown. */
  async resolve(id: string): Promise<{ bead?: ListedBead; loaded: boolean }> {
    try {
      return { bead: await this.bead(id), loaded: true };
    } catch (e) {
      logError('snapshot', e);
      return { loaded: false };
    }
  }
}

function logError(what: string, e: unknown): void {
  process.stderr.write(`strand hook PostToolUse: ${what}: ${e instanceof Error ? e.message : String(e)}\n`);
}

/** bash `is_bead`. */
function isBead(id: string | undefined): id is string {
  return !!id && id !== 'none';
}

/** What every change of bead clears: the marks, the cached approval (the gate recomputes it) and the last stage said. */
const FRESH = { approved: undefined, dirty: undefined, nagged: undefined, lastStage: undefined } as const;

/** bash `bind`. */
function bind(t: Track, id: string): void {
  t.patch({ ...FRESH, bead: id, none: undefined });
}

/** bash `bind none`. */
function bindNone(t: Track): void {
  t.patch({ ...FRESH, bead: undefined, none: true });
}

/** bash `unbind`, plus dropping the epic file. */
function unbind(t: Track): void {
  t.patch({ ...FRESH, bead: undefined, none: undefined, epic: undefined });
}

/** bash `bead_of_branch`. */
async function beadOfBranch(t: Track, name: string): Promise<string | undefined> {
  const label = `branch:${name}`;
  for (const b of (await t.snapshot()).beads.values()) if (b.labels.includes(label)) return b.id;
  return undefined;
}

/** Every string inside a JSON value, depth first (jq `[.. | strings]`). */
function stringsIn(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(stringsIn);
  if (v && typeof v === 'object') return Object.values(v).flatMap(stringsIn);
  return [];
}

function approveCtx(t: Track): Parameters<typeof approveSpec>[0] {
  // The real deps ignore this and use their own context. Fakes record the call.
  return { beads: t.deps.beads, config: { trackerDir: t.deps.trackerDir, wip: t.deps.wip } } as unknown as Parameters<typeof approveSpec>[0];
}

/**
 * Write the approval for a bead the session is already bound to.
 * Returns the WIP warning, or the refusal reason when approveSpec threw. Already approved is not an error.
 */
async function approve(t: Track, id: string, by: 'plan' | 'claim'): Promise<{ warn?: string; reason?: string }> {
  try {
    return await t.deps.approveSpec(approveCtx(t), id, { by });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/is already approved$/.test(msg)) {
      t.patch({ approved: true });
      return {};
    }
    return { reason: msg };
  }
}

// --- track (PostToolUse) --------------------------------------------------------------------

/** bash `on_track`. */
export async function onPostToolUse(input: TrackInput, deps: TrackDeps): Promise<HookResult> {
  // A tool ran: the engineer answered or allowed it, and work goes on. AskUserQuestion is matched only for this.
  clearWaiting(deps, input.session_id, 'PostToolUse');
  const t = new Track(input, deps);
  switch (input.tool_name) {
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      if (t.bound()) t.patch({ dirty: true });
      return {};
    case 'ExitPlanMode':
      return context(await trackPlan(t));
    case APP_TITLE_TOOL: {
      const ti = input.tool_input;
      if (ti.session_id === 'self') t.patch({ appTitle: typeof ti.title === 'string' ? ti.title : '' });
      return {};
    }
    case 'Bash':
    case 'PowerShell': {
      const command = input.tool_input.command;
      if (typeof command !== 'string') return {};
      const said: string[] = [];
      for (const args of parseCommands(command)) {
        // One failed bd call must not drop the rest of the line.
        try {
          const m = await trackCommand(t, args);
          if (m) said.push(m);
        } catch (e) {
          logError(args.slice(0, 2).join(' '), e);
        }
      }
      try {
        await labelPr(t, command);
      } catch (e) {
        logError('label_pr', e);
      }
      return context(said.join(' '));
    }
  }
  return {};
}

function context(text: string | undefined): HookResult {
  return text ? { additionalContext: text } : {};
}

/** bash `track_plan`. PostToolUse fires for ExitPlanMode only once the user has approved the plan. */
async function trackPlan(t: Track): Promise<string | undefined> {
  const re = /[Bb]ead:[*_\s]*([A-Za-z0-9._-]+)/;
  const m = re.exec(stringsIn(t.input.tool_input).join('\n')) ?? re.exec(stringsIn(t.input.tool_response).join('\n'));
  if (!m) {
    // No Bead: line in a bound session: the plan is for the bound bead.
    const bound = t.bound();
    return isBead(bound) ? claimApproved(t, bound) : undefined;
  }
  const id = m[1]!;
  switch (id.toLowerCase()) {
    case 'none':
      bindNone(t);
      t.patch({ epic: undefined });
      return undefined;
    case 'new':
      return "Bead workflow: the plan was approved with 'Bead: new'. File the bead with strand new, then run 'bd update <id> --claim' before the first edit.";
    default:
      return claimApproved(t, id);
  }
}

/** bash `claim_approved`, plus the approval write. */
async function claimApproved(t: Track, typed: string): Promise<string> {
  const bead = await t.bead(typed);
  if (!bead) {
    return `Bead workflow: the approved plan names bead ${typed}, which bd cannot find. Find the right id and run 'bd update <id> --claim'.`;
  }
  const id = bead.id;
  // A claim would reopen a closed bead.
  if (bead.status === 'closed') {
    return `Bead workflow: the approved plan names bead ${id}, which is closed. It was not claimed and this session was not bound. File a new bead for the work, or ask the engineer.`;
  }
  // Bind first: a slow or failed claim must not leave the session unbound after an approved plan.
  bind(t, id);
  t.patch({ epic: bead.issue_type === 'epic' ? id : undefined });
  let claimError: string | undefined;
  try {
    await t.deps.beads.claim(id);
  } catch (e) {
    claimError = e instanceof Error ? e.message : String(e);
    logError(`claim ${id}`, e);
  }
  const r = await approve(t, id, 'plan');
  let text = `Bead workflow: plan approved. Claimed bead ${id} and bound this session to it.`;
  if (claimError) text = `Bead workflow: plan approved. Bound this session to bead ${id}, but the claim failed: ${claimError}. Run 'bd update ${id} --claim'.`;
  if (r.warn) text += ` Warning: ${r.warn}.`;
  if (r.reason) text += ` The approval was not written: ${r.reason}.`;
  return text;
}

/** bash `track_command`, plus `strand none` and the criteria check. args[0] is the tool name. */
async function trackCommand(t: Track, args: string[]): Promise<string | undefined> {
  const [tool, a1, a2] = args;
  const id = t.bound();
  if (tool === 'bd' && a1 === 'update') return trackClaim(t, args.slice(2));
  if (tool === 'bd' && a1 === 'close') {
    if (isBead(id) && (await closesBound(t, id, args.slice(2)))) release(t, id);
  } else if (tool === 'but' && a1 === 'branch' && a2 === 'new') {
    if (isBead(id)) await labelBranch(t, id, args.slice(3));
  } else if (tool === 'but' && a1 === 'reword') {
    await relabelBranch(t, args.slice(2));
  } else if (tool === 'strand' && a1 === 'none') {
    bindNone(t);
  }
  return undefined;
}

/** bd close value flags and bd global value flags: their values are not bead ids. */
const CLOSE_VALUE_FLAGS = ['-r', '--reason', '--session', ...GLOBAL_VALUE_FLAGS.bd!];

/** `bd close <ids>` names the bound bead. Ids compare canonically, so `a1b` and `sub-a1b` are one bead. */
async function closesBound(t: Track, bound: string, args: string[]): Promise<boolean> {
  const ids: string[] = [];
  let skip = false;
  for (const a of args) {
    if (skip) skip = false;
    else if (CLOSE_VALUE_FLAGS.includes(a)) skip = true;
    else if (!a.startsWith('-')) ids.push(a);
  }
  if (ids.includes(bound)) return true;
  if (ids.length === 0) return false;
  const canonical = (await t.resolve(bound)).bead?.id ?? bound;
  for (const typed of ids) if (((await t.resolve(typed)).bead?.id ?? typed) === canonical) return true;
  return false;
}

/** bash `track_claim`: a claim, or a move to in_progress, binds the session to that bead. */
async function trackClaim(t: Track, args: string[]): Promise<string | undefined> {
  const typed = positional(args, [...UPDATE_VALUE_FLAGS, ...GLOBAL_VALUE_FLAGS.bd!]);
  if (typed === undefined) return undefined;
  const status = flagValue(args, ['-s', '--status']);
  const said: string[] = [];
  let id = typed;
  if (args.includes('--claim') || status === 'in_progress') {
    // bd takes an id without its prefix: bind the canonical id, and nothing that is not a bead.
    const found = await t.resolve(typed);
    if (found.loaded && !found.bead) {
      return `Bead workflow: bead ${typed} is not in the tracker, so this session was not bound to it. Check the id and claim again.`;
    }
    id = found.bead?.id ?? typed;
    bind(t, id);
    const r = await approve(t, id, 'claim');
    if (r.warn) said.push(`Bead workflow: bead ${id} claimed. Warning: ${r.warn}.`);
    if (r.reason) said.push(`Bead workflow: bead ${id} claimed and bound, but the approval was not written: ${r.reason}.`);
  }
  const criteria = await trackCriteria(t, id, args);
  if (criteria) said.push(criteria);
  return said.length > 0 ? said.join(' ') : undefined;
}

/** New: an acceptance update on the bound bead records the baseline, or reports a change after approval. */
async function trackCriteria(t: Track, typed: string, args: string[]): Promise<string | undefined> {
  if (!args.some((a) => a === '--acceptance' || a.startsWith('--acceptance='))) return undefined;
  const bound = t.bound();
  if (!isBead(bound)) return undefined;
  // The binding holds the canonical id; the command may name the bead without its prefix.
  const id = bound === typed ? typed : (await t.resolve(typed)).bead?.id;
  if (id !== bound) return undefined;
  await t.deps.recordBaseline(approveCtx(t), id);
  if (!(await t.deps.criteriaChanged(id))) return undefined;
  return `The acceptance criteria of ${id} changed after approval. Show the engineer the change and ask. On a yes, run strand criteria accept ${id}.`;
}

/** bash `label_branch`. args are the words after `but branch new`. */
async function labelBranch(t: Track, id: string, args: string[]): Promise<void> {
  const name = positional(args, STACK_FLAGS);
  if (name === undefined) return;
  if (!(await t.deps.refExists(t.cwd, name))) return;
  await t.deps.beads.addLabel(id, `branch:${name}`);
  // The stack is the merge order, so the bead order must match it.
  const above = flagValue(args, ['-A', '--above']);
  if (above !== undefined) {
    const parent = await beadOfBranch(t, above);
    if (parent) await t.deps.beads.addDep(id, parent);
    return;
  }
  const below = flagValue(args, ['-B', '--below']);
  if (below !== undefined) {
    const parent = await beadOfBranch(t, below);
    if (parent) await t.deps.beads.addDep(parent, id);
  }
}

/** bash `relabel_branch`. args are the words after `but reword`. */
async function relabelBranch(t: Track, args: string[]): Promise<void> {
  const old = positional(args, [...MESSAGE_FLAGS, '-F', '--file']);
  if (old === undefined) return;
  const next = flagValue(args, MESSAGE_FLAGS);
  if (next === undefined) return;
  const owner = await beadOfBranch(t, old);
  if (!owner || !(await t.deps.refExists(t.cwd, next))) return;
  // Add first: if the remove fails, the bead still has a label for its branch.
  await t.deps.beads.addLabel(owner, `branch:${next}`);
  await t.deps.beads.removeLabel(owner, `branch:${old}`);
}

// `label_pr`: a PR opened by hand. The request must create a pull (bash matched /pulls plus a data flag or POST;
// that also matched GETs that list pulls, whose reply holds many PR web URLs), so every part is checked here.
/** The request goes to a URL ending in `/pulls` (a trailing slash or quote is fine; a query string is not). */
const PULLS_TARGET_RE = /https?:\/\/[^\s'"]+\/pulls\/?['"]?(?=[\s;|&)]|$)/;
/** curl's GET switches: with them, data flags become a query string. */
const CURL_GET_RE = /(^|\s)(-G|--get)(?=\s|$)/;
/** An explicit method: curl `-X POST`, `-XPOST`, `--request POST`, `--request=POST`; PowerShell `-Method Post`. */
const CURL_METHOD_RE = /(?:^|\s)(?:-X\s*|--request[\s=]+)['"]?([A-Za-z]+)/;
const PS_METHOD_RE = /(?:^|\s)-Method\s+['"]?([A-Za-z]+)/i;
const PS_WEB_RE = /(^|[\s;|(])(Invoke-RestMethod|Invoke-WebRequest|irm|iwr)(?=\s|$)/i;
/** curl data flags, which make curl POST when there is no GET switch. */
const CURL_DATA_RE = /(?:^|\s)(?:-d|-F)|(?:^|\s)--(?:data|data-raw|data-binary|json|form)(?=[\s=]|$)/;
/** A pull's web URL (never the API's `/api/v1/` URL): owner, repo, number. */
const PR_WEB_RE = /^https:\/\/[^\s"]+\/([^/\s"]+)\/([^/\s"]+)\/pulls\/([0-9]+)$/;
const PR_WEB_ALL_RE = /https:\/\/[^"\s\\]+\/pulls\/[0-9]+/g;

/** The command creates a pull: it targets `.../pulls` with POST, and nothing in it says GET. */
function createsPull(command: string): boolean {
  if (!PULLS_TARGET_RE.test(command)) return false;
  if (PS_WEB_RE.test(command)) return PS_METHOD_RE.exec(command)?.[1]?.toLowerCase() === 'post';
  if (CURL_GET_RE.test(command)) return false;
  const method = CURL_METHOD_RE.exec(command)?.[1];
  if (method !== undefined) return method.toLowerCase() === 'post';
  return CURL_DATA_RE.test(command);
}

/** The reply text: the tool's stdout when it has one, else the response itself. */
function replyText(r: unknown): string {
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object' && typeof (r as { stdout?: unknown }).stdout === 'string') return (r as { stdout: string }).stdout;
  return JSON.stringify(r ?? '');
}

/** Parse leniently: the whole text, else from its first `{` or `[` (whichever comes first) to the last matching bracket. */
function parseLenient(text: string): unknown {
  const s = text.trim();
  try {
    return JSON.parse(s);
  } catch {
    // look for the JSON inside other output
  }
  const obj = s.indexOf('{');
  const arr = s.indexOf('[');
  const isArray = arr >= 0 && (obj < 0 || arr < obj);
  const a = isArray ? arr : obj;
  const b = s.lastIndexOf(isArray ? ']' : '}');
  if (a < 0 || b <= a) return undefined;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return undefined;
  }
}

/** One pull in the reply: a JSON object with a `number` and a web URL for that number. Lists and errors give nothing. */
function singlePull(text: string): { owner: string; repo: string; number: number } | undefined {
  const distinct = new Set((text.match(PR_WEB_ALL_RE) ?? []).filter((u) => !u.includes('/api/v1/')));
  if (distinct.size > 1) return undefined;
  const v = parseLenient(text);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as { number?: unknown; html_url?: unknown; url?: unknown };
  if (typeof o.number !== 'number') return undefined;
  for (const u of [o.html_url, o.url]) {
    if (typeof u !== 'string' || u.includes('/api/v1/')) continue;
    const m = PR_WEB_RE.exec(u);
    if (m && Number(m[3]) === o.number) return { owner: m[1]!, repo: m[2]!, number: o.number };
  }
  return undefined;
}

/**
 * bash `label_pr`: a PR opened by hand (a POST to Gitea's .../pulls) labels the bound bead `pr:<owner>/<repo>#<n>`.
 * Reads the raw command and the tool response; no network call.
 */
async function labelPr(t: Track, command: string): Promise<void> {
  if (!createsPull(command)) return;
  const id = t.bound();
  if (!isBead(id)) return;
  const pull = singlePull(replyText(t.input.tool_response));
  if (!pull) return;
  await t.deps.beads.addLabel(id, `pr:${pull.owner}/${pull.repo}#${pull.number}`);
}

/** bash `release`: the bound bead is finished. Fall back to the approved epic, if there is one. */
function release(t: Track, id: string): void {
  const epic = t.binding().epic;
  if (epic && epic !== id) bind(t, epic);
  else unbind(t);
}
