// PreToolUse gate: a port of the gate rules in ~/.claude/hooks/bead-workflow.sh.
// One function per bash function, in the bash file's order, with the bash denial text.
// A rule that matches throws Denial, which onPreToolUse turns into { deny }. Any other error
// propagates to runHook, which writes it to stderr and allows the action.
import { patchBinding, readBinding } from '../core/binding.ts';
import type { Binding } from '../core/binding.ts';
import type { ListedBead } from '../core/bd.ts';
import { beadIdsIn, branchesOf, planApprovedAt, prsOf } from '../core/facts.ts';
import { findBead } from '../core/snapshot.ts';
import type { Snapshot } from '../core/snapshot.ts';
import { GLOBAL_VALUE_FLAGS, UPDATE_VALUE_FLAGS, flagValue, flagValues, parseCommands, positional } from './parse.ts';
import { markWaiting } from './needs-you.ts';
import type { GateDeps, HookResult } from './runtime.ts';

export type GateInput = { session_id: string; cwd: string; tool_name: string; tool_input: Record<string, unknown> };

class Denial extends Error {}

function deny(reason: string): never {
  throw new Denial(reason);
}

const STACK_FLAGS = ['-A', '--above', '-B', '--below'];
const MESSAGE_FLAGS = ['-m', '--message'];

/** One hook call: the input, the deps, and the binding and snapshot, each read at most once. */
class Gate {
  input: GateInput;
  deps: GateDeps;
  #binding: Binding | undefined;
  #snapshot: Promise<Snapshot> | undefined;

  constructor(input: GateInput, deps: GateDeps) {
    this.input = input;
    this.deps = deps;
  }

  get cwd(): string {
    return this.input.cwd || '.';
  }

  binding(): Binding {
    return (this.#binding ??= readBinding(this.deps.trackerDir, this.input.session_id));
  }

  snapshot(): Promise<Snapshot> {
    return (this.#snapshot ??= this.deps.snapshot());
  }

  /** bash `bound`: the bead id, `none`, or empty. */
  bound(): string | undefined {
    const b = this.binding();
    return b.bead || (b.none ? 'none' : undefined);
  }

  /** The bead by id. Like bd, an id typed without its prefix (`a1b` for `sub-a1b`) also resolves. */
  async bead(id: string): Promise<ListedBead | undefined> {
    const s = await this.snapshot();
    return findBead(s, id);
  }
}

/** bash `is_bead`. */
function isBead(id: string | undefined): id is string {
  return !!id && id !== 'none';
}

/** bash `bead_ids_in`: known bead ids in the text, each once. */
async function beadIdsInText(g: Gate, text: string): Promise<string[]> {
  if (text.trim() === '') return [];
  const s = await g.snapshot();
  return [...new Set(beadIdsIn(text, s.prefixes, s.ids))];
}

/** bash `bead_of_branch`. */
async function beadOfBranch(g: Gate, name: string): Promise<string | undefined> {
  const label = `branch:${name}`;
  for (const b of (await g.snapshot()).beads.values()) if (b.labels.includes(label)) return b.id;
  return undefined;
}

/** bash `pr_merged`: a `pr:` label for the origin repo whose number ends a subject on the default remote branch. */
async function prMerged(g: Gate, bead: ListedBead): Promise<boolean> {
  const prs = prsOf(bead.labels);
  if (prs.length === 0) return false;
  const repo = await g.deps.remoteRepo(g.cwd);
  if (repo === undefined) return false;
  const numbers = prs.filter((p) => `${p.owner}/${p.repo}` === repo).map((p) => p.number);
  if (numbers.length === 0) return false;
  return (await g.deps.mergedPrNumbers(g.cwd, numbers)).length > 0;
}

/** bash `open_branch_of`: the bead's first open branch, unless its PR merged. */
async function openBranchOf(g: Gate, bead: ListedBead | undefined): Promise<string | undefined> {
  if (!bead || (await prMerged(g, bead))) return undefined;
  for (const name of branchesOf(bead.labels)) {
    if (await g.deps.branchOpen(g.cwd, name)) return name;
  }
  return undefined;
}

// --- gate (PreToolUse) ----------------------------------------------------------------------

/** bash `on_gate`. */
export async function onPreToolUse(input: GateInput, deps: GateDeps): Promise<HookResult> {
  const g = new Gate(input, deps);
  try {
    switch (input.tool_name) {
      case 'Edit':
      case 'Write':
      case 'NotebookEdit':
        await gateEdit(g);
        break;
      case 'Bash':
      case 'PowerShell':
        await eachCommand(g);
        break;
      case 'ExitPlanMode':
        await gatePlan(g);
        break;
      case 'AskUserQuestion':
        // No rule: a question is always allowed. It is on screen now, so the session waits for the engineer.
        markWaiting(deps, input.session_id, 'PreToolUse');
        break;
    }
  } catch (e) {
    if (e instanceof Denial) return { deny: e.message };
    throw e;
  }
  return {};
}

/** Forward slashes, lower case, and a Git Bash `/c/...` path as `c:/...`. */
function lower(p: string): string {
  return p
    .replace(/\\/g, '/')
    .toLowerCase()
    .replace(/^\/([a-z])\//, '$1:/');
}

function under(p: string, dir: string): boolean {
  const d = lower(dir).replace(/\/+$/, '');
  return d !== '' && p.startsWith(d + '/');
}

/** Memory, plans, hooks and scratch files are not project work. */
function exempt(g: Gate, p: string): boolean {
  return under(p, `${g.deps.home}/.claude`) || g.deps.tmpDirs.some((d) => under(p, d)) || p.includes('/appdata/local/temp/') || p.startsWith('/tmp/');
}

/** bash `gate_edit`, plus the Specify rule: a bead whose plan is not approved edits only docs/rfc and docs/adr. */
async function gateEdit(g: Gate): Promise<void> {
  const ti = g.input.tool_input;
  const raw = typeof ti.file_path === 'string' ? ti.file_path : typeof ti.notebook_path === 'string' ? ti.notebook_path : '';
  const p = lower(raw);
  if (exempt(g, p)) return;
  const b = g.binding();
  if (!g.bound()) {
    deny(
      "No bead is bound to this session. Plan the work with a 'Bead: <id>', 'Bead: new' or 'Bead: none' line and have the user approve it, or confirm a bead with the user and run 'bd update <id> --claim', then retry. If the user said no bead is needed, run 'strand none'.",
    );
  }
  if (!isBead(b.bead) || b.none || b.approved) return;
  if (/(^|\/)docs\/(rfc|adr)\//.test(p)) return;
  // A bead deleted elsewhere makes show throw: runHook allows and logs it.
  const bead = await g.deps.show(b.bead);
  if (bead.status === 'closed') return; // closed elsewhere: never deny edits forever
  if (planApprovedAt(bead.notes) === undefined) {
    deny(
      `Bead ${b.bead} is in Specify. Write the spec to the bead (bd update -d, --acceptance, --design-file), then stop: the engineer approves it with Approve spec in the cockpit or /strand:approve ${b.bead}, or in a plan that carries the line \`Bead: ${b.bead}\`. File edits wait for that.`,
    );
  }
  patchBinding(g.deps.trackerDir, g.input.session_id, { approved: true });
}

/** bash `each_command`: run gateCommand for each but, git, bd and strand command in the line. */
async function eachCommand(g: Gate): Promise<void> {
  const command = g.input.tool_input.command;
  if (typeof command !== 'string') return;
  for (const args of parseCommands(command)) await gateCommand(g, args);
}

/** bash `gate_command`, plus `strand approve`. args[0] is the tool name. */
async function gateCommand(g: Gate, args: string[]): Promise<void> {
  const [tool, a1, a2] = args;
  if (tool === 'but' && a1 === 'branch' && a2 === 'new') return gateBranchNew(g, args.slice(3));
  if (tool === 'but' && a1 === 'reword') return gateReword(g, args.slice(2));
  if (tool === 'but' && a1 === 'commit') return gateCommit(g, args.slice(2));
  if (tool === 'git' && (a1 === 'checkout' || a1 === 'switch' || a1 === 'branch')) return gateGitBranch(g, args);
  if (tool === 'git' && a1 === 'commit') return gateMessage(g, flagValues(args, MESSAGE_FLAGS).join('\n'));
  if (tool === 'bd' && a1 === 'close') return gateCloseAll(g, args.slice(2));
  if (tool === 'bd' && a1 === 'update') return gateUpdate(g, args.slice(2));
  if (tool === 'strand' && a1 === 'approve') return gateApprove();
}

/** bash `gate_name`. */
async function gateName(g: Gate, name: string): Promise<void> {
  const ids = await beadIdsInText(g, name);
  if (ids.length > 0) {
    deny(`Branch name '${name}' contains bead id ${ids.join(', ')}. Bead ids stay on this PC: name branches <username>/<topic>, and the bead finds its branch through its branch: label.`);
  }
}

/** bash `gate_message`. */
async function gateMessage(g: Gate, text: string): Promise<void> {
  const ids = await beadIdsInText(g, text);
  if (ids.length > 0) deny(`The commit message names bead ${ids.join(', ')}. Bead ids stay on this PC: leave them out of commit messages.`);
}

/** bash `gate_branch_new`. args are the words after `but branch new`. */
async function gateBranchNew(g: Gate, args: string[]): Promise<void> {
  const name = positional(args, STACK_FLAGS);
  if (name === undefined) deny('Name the branch: but branch new <username>/<topic>.');
  await gateName(g, name);
  const id = g.bound();
  if (!isBead(id)) {
    deny('A branch belongs to one bead, and this session has none. Claim the bead first (bd update <id> --claim), or start the work in a session for that bead.');
  }
  const bead = await g.bead(id);
  if (bead?.status === 'closed') deny(`Bead ${id} is closed. A new branch needs an open bead.`);
  const other = await openBranchOf(g, bead);
  if (other !== undefined && other !== name) {
    deny(`Bead ${id} already has branch ${other}, and a bead has one branch. Commit to it with but commit --branch ${other}, or file a new bead for separate work.`);
  }
  const parent = flagValue(args, STACK_FLAGS);
  if (parent === undefined) return;
  if ((await beadOfBranch(g, parent)) === undefined) {
    deny(`Stack on a branch by its full name, and only on a branch that belongs to a bead: '${parent}' has no bead with label branch:${parent}.`);
  }
}

/** bash `gate_reword`. args are the words after `but reword`. */
async function gateReword(g: Gate, args: string[]): Promise<void> {
  const target = positional(args, ['-m', '--message', '-F', '--file']);
  if (target === undefined) return;
  const name = flagValue(args, MESSAGE_FLAGS);
  if (name === undefined) return;
  if (name.includes('/') && !/\s/.test(name)) {
    await gateName(g, name);
    if (!(await g.deps.refExists(g.cwd, target))) {
      deny(`Rename a branch by its full name (but reword <old-name> -m ${name}), so its bead label follows.`);
    }
  } else {
    await gateMessage(g, name);
  }
}

/** bash `gate_commit`. args are the words after `but commit`. */
async function gateCommit(g: Gate, args: string[]): Promise<void> {
  await gateMessage(g, flagValues(args, MESSAGE_FLAGS).join('\n'));
  if (flagValue(args, STACK_FLAGS) !== undefined) {
    deny('Make a new branch with but branch new, then commit with but commit --branch <name>, so the branch is labelled on its bead.');
  }
  const id = g.bound();
  if (!isBead(id)) deny("Commits land on a bead's branch, and this session has no bead. Claim the bead first (bd update <id> --claim).");
  const bead = await g.bead(id);
  const own = (await openBranchOf(g, bead)) ?? branchesOf(bead?.labels ?? []).at(-1);
  if (own === undefined) {
    deny(`Bead ${id} has no branch yet. Make one with but branch new <username>/<topic>, then commit with but commit --branch <that name>.`);
  }
  const target = flagValue(args, ['-b', '--branch']);
  if (target !== own) {
    deny(`This session is bead ${id}, whose branch is ${own}. Commit with but commit --branch ${own}. Changes for another bead belong in that bead's session.`);
  }
}

/** bash `gate_git_branch`. args start with `git`. */
async function gateGitBranch(g: Gate, args: string[]): Promise<void> {
  const name = flagValue(args, ['-b', '-B', '-c', '-C', '--create', '--force-create']);
  if (name !== undefined) {
    await gateName(g, name);
  } else if (args[1] === 'branch' && !args.some((a) => ['-d', '-D', '-l', '--delete', '--list'].includes(a))) {
    // "git branch <name>" and "git branch -m [<old>] <new>": the new name is last.
    const last = args[args.length - 1]!;
    if (args.length > 2 && !last.startsWith('-')) await gateName(g, last);
  }
}

/** bash `gate_close_all`. args are the words after `bd close`. */
async function gateCloseAll(g: Gate, args: string[]): Promise<void> {
  for (const id of args) if (!id.startsWith('-')) await gateClose(g, id);
}

/** bash `gate_close`. */
async function gateClose(g: Gate, id: string): Promise<void> {
  const bead = await g.bead(id);
  if (!bead) return;
  const name = await openBranchOf(g, bead);
  if (name !== undefined) {
    deny(`Bead ${bead.id} has branch ${name}, which is not merged into the remote default branch. It closes itself when its PR merges.`);
  }
}

/** bash `gate_update`, plus the WIP check on a claim. args are the words after `bd update`. */
async function gateUpdate(g: Gate, args: string[]): Promise<void> {
  const id = positional(args, [...UPDATE_VALUE_FLAGS, ...GLOBAL_VALUE_FLAGS.bd!]);
  if (id === undefined) return;
  const status = flagValue(args, ['-s', '--status']);
  if (status === 'closed') await gateClose(g, id);
  if (args.includes('--claim') || status === 'in_progress') {
    await gateSwitch(g, id);
    await gateWip(g, id);
  }
}

/** bash `gate_switch`: one bead per chat, except the next child of an approved epic. */
async function gateSwitch(g: Gate, typed: string): Promise<void> {
  const bound = g.bound();
  if (!isBead(bound)) return;
  const next = await g.bead(typed);
  const id = next?.id ?? typed;
  // A binding may hold an id typed without its prefix: compare canonical ids.
  const bead = await g.bead(bound);
  const current = bead?.id ?? bound;
  if (current === id) return;
  if (!bead || bead.status === 'closed') return;
  const epic = g.binding().epic;
  if (epic && next) {
    const { parentOf } = await import('../core/snapshot.ts');
    if (parentOf(next) === epic) return;
  }
  deny(`This chat is bead ${current}, which is still open. One chat holds one bead: start a new session for ${id}. If ${current} is finished, let it close on merge first.`);
}

/** bash `gate_plan`, plus the WIP check for a plan that names a bead. */
async function gatePlan(g: Gate): Promise<void> {
  const m = /[Bb]ead:[*_\s]*([A-Za-z0-9._-]+)/.exec(stringsIn(g.input.tool_input).join('\n'));
  if (!m) {
    // No Bead: line in a bound session: the plan is for the bound bead (track does the same).
    const bound = g.bound();
    if (isBead(bound)) await gateWip(g, bound);
    return;
  }
  const named = m[1]!;
  const fresh = ['none', 'new'].includes(named.toLowerCase());
  await gateSwitch(g, fresh ? 'a new bead' : named);
  if (!fresh) await gateWip(g, named);
}

/** Every string inside a JSON value, depth first (jq `[.. | strings]`). */
function stringsIn(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(stringsIn);
  if (v && typeof v === 'object') return Object.values(v).flatMap(stringsIn);
  return [];
}

/** New: Claude may not approve a spec. That is the engineer's decision. */
function gateApprove(): void {
  deny("Approving the spec is the engineer's decision. Ask them to approve the plan, run /strand:approve, or use the cockpit.");
}

/** New: in `refuse` mode, starting Build on a work item is denied at a WIP limit (RFC 0003 section 8). */
async function gateWip(g: Gate, id: string): Promise<void> {
  if (g.deps.wip.mode !== 'refuse') return;
  const bead = await g.bead(id);
  if (bead?.issue_type === 'epic') return; // an epic is not a work item; its children are checked when claimed
  const [{ wipOf }, { checkBuild }] = await Promise.all([import('../core/snapshot.ts'), import('../core/wip.ts')]);
  const verdict = checkBuild(wipOf(await g.snapshot(), bead?.id ?? id), g.deps.wip, 'refuse');
  if (!verdict.ok) deny(verdict.reason!);
}
