import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseEnv } from './fixtures/env.ts';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { readBinding, writeBinding } from '../src/core/binding.ts';
import type { Binding } from '../src/core/binding.ts';
import type { Bead, ListedBead } from '../src/core/bd.ts';
import { recordStart, sessionsFor } from '../src/core/sessions.ts';
import { snapshotOf } from '../src/core/snapshot.ts';
import type { Snapshot } from '../src/core/snapshot.ts';
import { DEADLINE_MS, buildGateDeps, repoOfUrl, runHook } from '../src/hooks/runtime.ts';
import type { GateDeps, HookResult } from '../src/hooks/runtime.ts';
import { onPreToolUse } from '../src/hooks/gate.ts';

// --- fixtures ---------------------------------------------------------------------------------

const HOME = 'C:\\Users\\Tester';
const TEMP = 'C:\\Users\\Tester\\AppData\\Local\\Temp';
const PROJECT_FILE = 'C:\\dev\\proj\\src\\a.ts';
const APPROVED = 'plan-approved 2026-11-20T10:00:00Z';

function bead(id: string, over: Partial<ListedBead> = {}): ListedBead {
  return { id, title: `title ${id}`, status: 'in_progress', priority: 2, issue_type: 'task', labels: [], dependencies: [], ...over };
}

type World = {
  beads?: ListedBead[];
  open?: string[]; // branches that are open
  refs?: string[]; // refs/heads that exist
  merged?: number[]; // PR numbers merged on the default branch
  remote?: string | null; // owner/repo of origin; null means no origin; default me/repo
  mode?: 'warn' | 'refuse';
  wipLimits?: { build: number; review: number };
  show?: (id: string) => Promise<Bead>;
  snapshot?: () => Promise<Snapshot>;
};

function setup(w: World = {}) {
  const trackerDir = mkdtempSync(join(tmpdir(), 'strand-gate-'));
  const calls = { show: 0, snapshot: 0, git: 0 };
  const list = w.beads ?? [];
  const deps: GateDeps = {
    trackerDir,
    workspaceRoot: 'C:\\dev',
    home: HOME,
    tmpDirs: [TEMP],
    wip: { build: 3, review: 3, ...w.wipLimits, mode: w.mode ?? 'warn' },
    async snapshot() {
      calls.snapshot++;
      if (w.snapshot) return w.snapshot();
      return snapshotOf(list);
    },
    async show(id) {
      calls.show++;
      if (w.show) return w.show(id);
      const b = list.find((x) => x.id === id);
      if (!b) throw new Error(`bd show ${id}: bead not found`);
      return b as unknown as Bead;
    },
    async branchOpen(_dir, name) {
      calls.git++;
      return (w.open ?? []).includes(name);
    },
    async refExists(_dir, name) {
      calls.git++;
      return (w.refs ?? []).includes(name);
    },
    async mergedPrNumbers(_dir, numbers) {
      calls.git++;
      return numbers.filter((n) => (w.merged ?? []).includes(n));
    },
    async remoteRepo() {
      calls.git++;
      return w.remote === null ? undefined : (w.remote ?? 'me/repo');
    },
  };
  const bind = (b: Binding) => writeBinding(trackerDir, 's1', b);
  const done = () => rmSync(trackerDir, { recursive: true, force: true });
  return { deps, calls, trackerDir, bind, done };
}

function gate(deps: GateDeps, tool_name: string, tool_input: Record<string, unknown>): Promise<HookResult> {
  return onPreToolUse({ session_id: 's1', cwd: 'C:\\dev\\proj', tool_name, tool_input }, deps);
}
const bash = (deps: GateDeps, command: string) => gate(deps, 'Bash', { command });
const edit = (deps: GateDeps, file_path: string) => gate(deps, 'Edit', { file_path, old_string: 'a', new_string: 'b' });

function io(stdin: string) {
  const o = { out: '', err: '', code: -1 };
  return {
    o,
    io: {
      stdin: Readable.from([Buffer.from(stdin)]),
      stdout: { write: (s: string) => void (o.out += s) },
      stderr: { write: (s: string) => void (o.err += s) },
      exit: (c: number) => void (o.code = c),
    },
  };
}

// --- runtime ----------------------------------------------------------------------------------

test('runtime: deadlines per event', () => {
  assert.equal(DEADLINE_MS.PreToolUse, 3000);
  assert.equal(DEADLINE_MS.PostToolUse, 8000);
  assert.equal(DEADLINE_MS.Stop, 15000);
  assert.equal(DEADLINE_MS.SessionEnd, 1200);
  assert.equal(DEADLINE_MS.SessionStart, 8000);
  assert.equal(DEADLINE_MS.UserPromptSubmit, 8000);
});

test('runtime: deny on PreToolUse prints the bash deny shape exactly, exit 0', async () => {
  const a = io('{}');
  await runHook(async () => ({ deny: 'no' }), 'PreToolUse', a.io);
  assert.equal(a.o.out, '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no"}}\n');
  assert.equal(a.o.code, 0);
});

test('runtime: block, systemMessage, context and title shapes', async () => {
  const a = io('{}');
  await runHook(async () => ({ block: 'check it' }), 'Stop', a.io);
  assert.deepEqual(JSON.parse(a.o.out), { decision: 'block', reason: 'check it' });
  const b = io('{}');
  await runHook(async () => ({ systemMessage: 'closed' }), 'Stop', b.io);
  assert.deepEqual(JSON.parse(b.o.out), { systemMessage: 'closed' });
  const c = io('{}');
  await runHook(async () => ({ additionalContext: 'ctx', sessionTitle: 'WIP: x' }), 'UserPromptSubmit', c.io);
  assert.deepEqual(JSON.parse(c.o.out), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'ctx', sessionTitle: 'WIP: x' } });
  const d = io('{}');
  await runHook(async () => ({ sessionTitle: 'WIP: x', systemMessage: 'drift' }), 'SessionStart', d.io);
  assert.deepEqual(JSON.parse(d.o.out), { hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: 'WIP: x' }, systemMessage: 'drift' });
  const e = io('{}');
  await runHook(async () => ({}), 'PreToolUse', e.io);
  assert.equal(e.o.out, '');
});

test('runtime: a throwing handler or a timeout allows: stderr only, exit 0', async () => {
  const a = io('{}');
  await runHook(async () => {
    throw new Error('kaput');
  }, 'PreToolUse', a.io);
  assert.equal(a.o.out, '');
  assert.match(a.o.err, /strand hook PreToolUse: kaput/);
  assert.equal(a.o.code, 0);
  const b = io('{}');
  await runHook(() => new Promise(() => {}), 'PreToolUse', b.io, { deadlineMs: 20 });
  assert.equal(b.o.out, '');
  assert.match(b.o.err, /timed out after 20 ms/);
  assert.equal(b.o.code, 0);
});

// --- gate_edit --------------------------------------------------------------------------------

const NO_BEAD =
  "No bead is bound to this session. Plan the work with a 'Bead: <id>', 'Bead: new' or 'Bead: none' line and have the user approve it, or confirm a bead with the user and run 'bd update <id> --claim', then retry. If the user said no bead is needed, run 'strand none'.";
const SPECIFY =
  'Bead sub-a1b is in Specify. Write the spec to the bead (bd update -d, --acceptance, --design-file), then stop: the engineer approves it with Approve spec in the cockpit or /strand:approve sub-a1b, or in a plan that carries the line `Bead: sub-a1b`. File edits wait for that.';

test('gate_edit: no binding denies a project file', async () => {
  const t = setup();
  try {
    assert.deepEqual(await edit(t.deps, PROJECT_FILE), { deny: NO_BEAD });
    assert.deepEqual(await gate(t.deps, 'Write', { file_path: PROJECT_FILE, content: '' }), { deny: NO_BEAD });
    assert.deepEqual(await gate(t.deps, 'NotebookEdit', { notebook_path: 'C:/dev/proj/n.ipynb' }), { deny: NO_BEAD });
    assert.deepEqual(t.calls, { show: 0, snapshot: 0, git: 0 });
  } finally {
    t.done();
  }
});

test('gate_edit: no binding allows ~/.claude, temp folders and /tmp, any case or slash', async () => {
  const t = setup();
  try {
    for (const p of [
      'C:\\Users\\Tester\\.claude\\plans\\p.md',
      'c:/users/tester/.claude/projects/x/memory/MEMORY.md',
      'C:\\Users\\Tester\\AppData\\Local\\Temp\\claude\\x.txt',
      'C:\\Users\\Other\\AppData\\Local\\Temp\\y.txt',
      '/tmp/scratch.txt',
    ]) {
      assert.deepEqual(await edit(t.deps, p), {}, p);
    }
    assert.deepEqual(t.calls, { show: 0, snapshot: 0, git: 0 });
  } finally {
    t.done();
  }
});

test('gate_edit: binding none or approved allows with zero bd calls', async () => {
  const t = setup();
  try {
    t.bind({ none: true });
    assert.deepEqual(await edit(t.deps, PROJECT_FILE), {});
    t.bind({ bead: 'sub-a1b', approved: true });
    assert.deepEqual(await edit(t.deps, PROJECT_FILE), {});
    assert.deepEqual(t.calls, { show: 0, snapshot: 0, git: 0 });
  } finally {
    t.done();
  }
});

test('gate_edit: a bead in Specify denies project edits after one show', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await edit(t.deps, PROJECT_FILE), { deny: SPECIFY });
    assert.equal(t.calls.show, 1);
    assert.equal(t.calls.snapshot, 0);
    assert.equal(readBinding(t.trackerDir, 's1').approved, undefined);
  } finally {
    t.done();
  }
});

test('gate: a bead in Specify may save its story and criteria with bd update; file edits stay refused', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    t.bind({ bead: 'sub-a1b' });
    for (const cmd of [
      'bd -C "C:/dev/beads" update sub-a1b -d "As a dev, I want x, so that y"',
      'bd -C "C:/dev/beads" update sub-a1b --acceptance "- [ ] One (check: npm test)"',
      'bd update sub-a1b --description "As a dev, I want x, so that y" --acceptance "- [ ] One (check: npm test)"',
      'bd -C "C:/dev/beads" update sub-a1b --design-file C:/tmp/spec.md',
    ]) {
      assert.deepEqual(await bash(t.deps, cmd), {}, cmd);
    }
    assert.deepEqual(await edit(t.deps, PROJECT_FILE), { deny: SPECIFY });
    assert.equal(readBinding(t.trackerDir, 's1').approved, undefined);
  } finally {
    t.done();
  }
});

test('gate_edit: a bead in Specify may still write docs/rfc and docs/adr, without a bd call', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await edit(t.deps, 'C:\\dev\\proj\\docs\\rfc\\0004-x.md'), {});
    assert.deepEqual(await edit(t.deps, 'C:/dev/proj/docs/adr/0020-y.md'), {});
    assert.equal(t.calls.show, 0);
  } finally {
    t.done();
  }
});

test('gate_edit: a plan-approved note allows and marks the binding approved', async () => {
  const t = setup({ beads: [bead('sub-a1b', { notes: `something\n${APPROVED}` })] });
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await edit(t.deps, PROJECT_FILE), {});
    assert.equal(readBinding(t.trackerDir, 's1').approved, true);
    assert.deepEqual(await edit(t.deps, PROJECT_FILE), {});
    assert.equal(t.calls.show, 1);
  } finally {
    t.done();
  }
});

test('gate_edit: a bound bead closed elsewhere does not deny edits', async () => {
  const t = setup({ beads: [bead('sub-a1b', { status: 'closed' })] });
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await edit(t.deps, PROJECT_FILE), {});
  } finally {
    t.done();
  }
});

test('gate_edit: a bound bead deleted elsewhere, or bd missing, allows with a stderr line', async () => {
  const t = setup({ beads: [] });
  try {
    t.bind({ bead: 'sub-a1b' });
    const input = JSON.stringify({ session_id: 's1', cwd: 'C:\\dev\\proj', tool_name: 'Edit', tool_input: { file_path: PROJECT_FILE } });
    const a = io(input);
    await runHook((i) => onPreToolUse(i, t.deps), 'PreToolUse', a.io);
    assert.equal(a.o.out, '');
    assert.match(a.o.err, /strand hook PreToolUse: .*not found/);
    assert.equal(a.o.code, 0);
  } finally {
    t.done();
  }
});

test('gate_edit: bd slow allows with a stderr line', async () => {
  const t = setup({ show: () => new Promise(() => {}) });
  try {
    t.bind({ bead: 'sub-a1b' });
    const input = JSON.stringify({ session_id: 's1', cwd: 'C:\\dev\\proj', tool_name: 'Edit', tool_input: { file_path: PROJECT_FILE } });
    const a = io(input);
    await runHook((i) => onPreToolUse(i, t.deps), 'PreToolUse', a.io, { deadlineMs: 30 });
    assert.equal(a.o.out, '');
    assert.match(a.o.err, /timed out/);
    assert.equal(a.o.code, 0);
  } finally {
    t.done();
  }
});

// --- gate_command, snapshot loading -----------------------------------------------------------

test('gate_command: commands the gate does not know load nothing', async () => {
  const t = setup();
  try {
    for (const c of ['ls -la', 'git status', 'git log --oneline', 'bd list', 'but status', 'git commit --amend --no-edit', 'npm test']) {
      assert.deepEqual(await bash(t.deps, c), {}, c);
    }
    assert.deepEqual(t.calls, { show: 0, snapshot: 0, git: 0 });
  } finally {
    t.done();
  }
});

test('gate_command: deps.snapshot throwing allows with a stderr line', async () => {
  const t = setup({
    snapshot: async () => {
      throw new Error('bd: command not found');
    },
  });
  try {
    t.bind({ bead: 'sub-a1b', approved: true });
    const input = JSON.stringify({ session_id: 's1', cwd: 'C:\\dev\\proj', tool_name: 'Bash', tool_input: { command: 'but branch new ada/topic' } });
    const a = io(input);
    await runHook((i) => onPreToolUse(i, t.deps), 'PreToolUse', a.io);
    assert.equal(a.o.out, '');
    assert.match(a.o.err, /strand hook PreToolUse: bd: command not found/);
    assert.equal(a.o.code, 0);
  } finally {
    t.done();
  }
});

test('gate_command: one snapshot per hook call, however many commands', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    await bash(t.deps, 'git commit -m "one" && git commit -m "two" ; git checkout -b ada/x');
    assert.equal(t.calls.snapshot, 1);
  } finally {
    t.done();
  }
});

test('the gate denies strand approve and the legacy sdlc approve in every form', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    for (const c of [
      'strand approve sub-a1b',
      'node "/x/src/cli/strand.ts" approve sub-a1b',
      'sdlc approve sub-a1b',
      'C:\\npm\\sdlc.cmd approve sub-a1b',
      'node "/old/src/cli/sdlc.ts" approve sub-a1b',
    ]) {
      assert.match((await bash(t.deps, c)).deny ?? '', /^Approving the spec is the engineer's decision/, c);
    }
  } finally {
    t.done();
  }
});

// --- gate_name and gate_message ---------------------------------------------------------------

test('gate_name: a branch name with a known bead id is denied', async () => {
  const t = setup({ beads: [bead('sub-a1b'), bead('sub-c2d')] });
  try {
    assert.deepEqual(await bash(t.deps, 'git checkout -b ada/sub-c2d-fix'), {
      deny: "Branch name 'ada/sub-c2d-fix' contains bead id sub-c2d. Bead ids stay on this PC: name branches <username>/<topic>, and the bead finds its branch through its branch: label.",
    });
    // An id-shaped word that is not a bead is fine.
    assert.deepEqual(await bash(t.deps, 'git checkout -b ada/sub-zzz9'), {});
  } finally {
    t.done();
  }
});

test('a tracker with sdlc- and strand- ids: the gate denies a commit message or branch naming either', async () => {
  const t = setup({ beads: [bead('sdlc-cpi.12'), bead('strand-a1b')] });
  try {
    assert.match((await bash(t.deps, 'git commit -m "Refs sdlc-cpi.12"')).deny ?? '', /^The commit message names bead sdlc-cpi\.12\./);
    assert.match((await bash(t.deps, 'git commit -m "Refs strand-a1b"')).deny ?? '', /^The commit message names bead strand-a1b\./);
    assert.match((await bash(t.deps, 'git checkout -b ada/strand-a1b-x')).deny ?? '', /contains bead id strand-a1b/);
    assert.match((await bash(t.deps, 'git checkout -b ada/sdlc-cpi.12')).deny ?? '', /contains bead id sdlc-cpi\.12/);
  } finally {
    t.done();
  }
});

test('gate_message: git commit -m naming a bead is denied, other messages pass', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    assert.deepEqual(await bash(t.deps, 'git commit -m "fix: thing" -m "Refs sub-a1b"'), {
      deny: 'The commit message names bead sub-a1b. Bead ids stay on this PC: leave them out of commit messages.',
    });
    assert.deepEqual(await bash(t.deps, 'git commit --message="sub-a1b: x"'), {
      deny: 'The commit message names bead sub-a1b. Bead ids stay on this PC: leave them out of commit messages.',
    });
    assert.deepEqual(await bash(t.deps, 'git commit -m "fix: thing"'), {});
  } finally {
    t.done();
  }
});

// --- gate_branch_new --------------------------------------------------------------------------

test('gate_branch_new: needs a name', async () => {
  const t = setup();
  try {
    assert.deepEqual(await bash(t.deps, 'but branch new'), { deny: 'Name the branch: but branch new <username>/<topic>.' });
    assert.deepEqual(await bash(t.deps, 'but branch new -A ada/base'), { deny: 'Name the branch: but branch new <username>/<topic>.' });
  } finally {
    t.done();
  }
});

test('gate_branch_new: a bead id in the name is denied', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.match((await bash(t.deps, 'but branch new ada/sub-a1b')).deny ?? '', /^Branch name 'ada\/sub-a1b' contains bead id sub-a1b\./);
  } finally {
    t.done();
  }
});

test('gate_branch_new: no bead, or binding none, is denied', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  const want = {
    deny: 'A branch belongs to one bead, and this session has none. Claim the bead first (bd update <id> --claim), or start the work in a session for that bead.',
  };
  try {
    assert.deepEqual(await bash(t.deps, 'but branch new ada/topic'), want);
    t.bind({ none: true });
    assert.deepEqual(await bash(t.deps, 'but branch new ada/topic'), want);
  } finally {
    t.done();
  }
});

test('gate_branch_new: a closed bound bead is denied', async () => {
  const t = setup({ beads: [bead('sub-a1b', { status: 'closed' })] });
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await bash(t.deps, 'but branch new ada/topic'), { deny: 'Bead sub-a1b is closed. A new branch needs an open bead.' });
  } finally {
    t.done();
  }
});

test('gate_branch_new: one branch per bead, unless its PR merged', async () => {
  const t = setup({ beads: [bead('sub-a1b', { labels: ['branch:ada/first'] })], open: ['ada/first'] });
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await bash(t.deps, 'but branch new ada/second'), {
      deny: 'Bead sub-a1b already has branch ada/first, and a bead has one branch. Commit to it with but commit --branch ada/first, or file a new bead for separate work.',
    });
    assert.deepEqual(await bash(t.deps, 'but branch new ada/first'), {});
  } finally {
    t.done();
  }
  const m = setup({ beads: [bead('sub-a1b', { labels: ['branch:ada/first', 'pr:me/repo#7'] })], open: ['ada/first'], merged: [7] });
  try {
    m.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await bash(m.deps, 'but branch new ada/second'), {});
  } finally {
    m.done();
  }
});

test('gate_branch_new: stacking needs a parent that belongs to a bead', async () => {
  const t = setup({ beads: [bead('sub-a1b'), bead('sub-c2d', { labels: ['branch:ada/base'] })] });
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await bash(t.deps, 'but branch new -A base ada/top'), {
      deny: "Stack on a branch by its full name, and only on a branch that belongs to a bead: 'base' has no bead with label branch:base.",
    });
    assert.deepEqual(await bash(t.deps, 'but branch new -A ada/base ada/top'), {});
    assert.deepEqual(await bash(t.deps, 'but branch new ada/top --below=ada/base'), {});
  } finally {
    t.done();
  }
});

// --- gate_reword ------------------------------------------------------------------------------

test('gate_reword: a branch rename checks the name and needs the full old name', async () => {
  const t = setup({ beads: [bead('sub-a1b')], refs: ['ada/old'] });
  try {
    assert.match((await bash(t.deps, 'but reword ada/old -m ada/sub-a1b')).deny ?? '', /^Branch name 'ada\/sub-a1b' contains bead id/);
    assert.deepEqual(await bash(t.deps, 'but reword old -m ada/new'), {
      deny: 'Rename a branch by its full name (but reword <old-name> -m ada/new), so its bead label follows.',
    });
    assert.deepEqual(await bash(t.deps, 'but reword ada/old -m ada/new'), {});
  } finally {
    t.done();
  }
});

test('gate_reword: a commit reword checks the message', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    assert.deepEqual(await bash(t.deps, 'but reword abc123 -m "fix sub-a1b"'), {
      deny: 'The commit message names bead sub-a1b. Bead ids stay on this PC: leave them out of commit messages.',
    });
    assert.deepEqual(await bash(t.deps, 'but reword abc123 -m "fix: the thing"'), {});
    assert.deepEqual(await bash(t.deps, 'but reword abc123'), {});
  } finally {
    t.done();
  }
});

// --- gate_commit ------------------------------------------------------------------------------

test('gate_commit: message, stacking flag and binding', async () => {
  const t = setup({ beads: [bead('sub-a1b', { labels: ['branch:ada/mine'] })], open: ['ada/mine'] });
  try {
    assert.match((await bash(t.deps, 'but commit --branch ada/mine -m "sub-a1b done"')).deny ?? '', /^The commit message names bead sub-a1b\./);
    assert.deepEqual(await bash(t.deps, 'but commit -A ada/mine -m "x"'), {
      deny: 'Make a new branch with but branch new, then commit with but commit --branch <name>, so the branch is labelled on its bead.',
    });
    assert.deepEqual(await bash(t.deps, 'but commit --branch ada/mine -m "x"'), {
      deny: "Commits land on a bead's branch, and this session has no bead. Claim the bead first (bd update <id> --claim).",
    });
  } finally {
    t.done();
  }
});

test('gate_commit: only to the bead\'s own branch', async () => {
  const t = setup({ beads: [bead('sub-a1b', { labels: ['branch:ada/old', 'branch:ada/mine'] })], open: [] });
  try {
    t.bind({ bead: 'sub-a1b', approved: true });
    // No open branch: the last label wins.
    assert.deepEqual(await bash(t.deps, 'but commit --branch ada/other -m "x"'), {
      deny: 'This session is bead sub-a1b, whose branch is ada/mine. Commit with but commit --branch ada/mine. Changes for another bead belong in that bead\'s session.',
    });
    assert.match((await bash(t.deps, 'but commit -m "x"')).deny ?? '', /whose branch is ada\/mine/);
    assert.deepEqual(await bash(t.deps, 'but commit -b ada/mine -m "x"'), {});
  } finally {
    t.done();
  }
  const o = setup({ beads: [bead('sub-a1b', { labels: ['branch:ada/old', 'branch:ada/mine'] })], open: ['ada/old'] });
  try {
    o.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await bash(o.deps, 'but commit --branch ada/old -m "x"'), {});
  } finally {
    o.done();
  }
});

test('gate_commit: a bead with no branch is denied', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await bash(t.deps, 'but commit --branch ada/x -m "x"'), {
      deny: 'Bead sub-a1b has no branch yet. Make one with but branch new <username>/<topic>, then commit with but commit --branch <that name>.',
    });
  } finally {
    t.done();
  }
});

test('closed bound bead: branch and commit are denied as in bash, edits are allowed', async () => {
  const t = setup({ beads: [bead('sub-a1b', { status: 'closed' })] });
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.match((await bash(t.deps, 'but branch new ada/x')).deny ?? '', /is closed/);
    assert.match((await bash(t.deps, 'but commit --branch ada/x -m "x"')).deny ?? '', /has no branch yet/);
    assert.deepEqual(await edit(t.deps, PROJECT_FILE), {});
  } finally {
    t.done();
  }
});

// --- gate_git_branch --------------------------------------------------------------------------

test('gate_git_branch: new branch names via git are checked, deletes and lists are not', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    for (const c of ['git checkout -b ada/sub-a1b', 'git switch -c ada/sub-a1b', 'git switch --create=ada/sub-a1b', 'git branch ada/sub-a1b', 'git branch -m old ada/sub-a1b']) {
      assert.match((await bash(t.deps, c)).deny ?? '', /^Branch name 'ada\/sub-a1b' contains bead id sub-a1b/, c);
    }
    for (const c of ['git branch -D ada/sub-a1b', 'git branch --delete ada/sub-a1b', 'git branch -l', 'git checkout ada/sub-a1b', 'git branch', 'git checkout -b ada/fine']) {
      assert.deepEqual(await bash(t.deps, c), {}, c);
    }
  } finally {
    t.done();
  }
});

// --- gate_close -------------------------------------------------------------------------------

test('gate_close: an unmerged branch keeps the bead open', async () => {
  const t = setup({ beads: [bead('sub-a1b', { labels: ['branch:ada/mine'] }), bead('sub-c2d')], open: ['ada/mine'] });
  const want = { deny: 'Bead sub-a1b has branch ada/mine, which is not merged into the remote default branch. It closes itself when its PR merges.' };
  try {
    assert.deepEqual(await bash(t.deps, 'bd close sub-a1b --reason "done"'), want);
    assert.deepEqual(await bash(t.deps, 'bd close sub-c2d sub-a1b'), want);
    assert.deepEqual(await bash(t.deps, 'bd update sub-a1b --status closed'), want);
    assert.deepEqual(await bash(t.deps, 'bd update sub-a1b -s=closed'), {}); // -s=x is not a value form for short flags
    assert.deepEqual(await bash(t.deps, 'bd close sub-c2d --reason "all done"'), {});
    assert.deepEqual(await bash(t.deps, 'bd close sub-zzz'), {});
  } finally {
    t.done();
  }
});

test('gate_close: a merged PR or a branch already on main allows the close', async () => {
  const t = setup({ beads: [bead('sub-a1b', { labels: ['branch:ada/mine', 'pr:me/repo#4'] })], open: ['ada/mine'], merged: [4] });
  try {
    assert.deepEqual(await bash(t.deps, 'bd close sub-a1b'), {});
  } finally {
    t.done();
  }
  const u = setup({ beads: [bead('sub-a1b', { labels: ['branch:ada/mine'] })], open: [] });
  try {
    assert.deepEqual(await bash(u.deps, 'bd close sub-a1b'), {});
  } finally {
    u.done();
  }
});

// --- gate_update and gate_switch --------------------------------------------------------------

const SWITCH = {
  deny: 'This chat is bead sub-a1b, which is still open. One chat holds one bead: start a new session for sub-c2d. If sub-a1b is finished, let it close on merge first.',
};

test('gate_switch: claiming another bead while this one is open is denied', async () => {
  const t = setup({ beads: [bead('sub-a1b'), bead('sub-c2d', { status: 'open' })] });
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await bash(t.deps, 'bd update sub-c2d --claim'), SWITCH);
    assert.deepEqual(await bash(t.deps, 'bd update --notes "x" sub-c2d --status in_progress'), SWITCH);
    assert.deepEqual(await bash(t.deps, 'bd update sub-a1b --claim'), {});
    assert.deepEqual(await bash(t.deps, 'bd update sub-c2d --notes "hello"'), {});
  } finally {
    t.done();
  }
});

test('gate_switch: allowed when unbound, bound to none, or the bound bead is closed or gone', async () => {
  for (const [binding, beads] of [
    [{}, [bead('sub-c2d')]],
    [{ none: true }, [bead('sub-c2d')]],
    [{ bead: 'sub-a1b' }, [bead('sub-a1b', { status: 'closed' }), bead('sub-c2d')]],
    [{ bead: 'sub-a1b' }, [bead('sub-c2d')]],
  ] as [Binding, ListedBead[]][]) {
    const t = setup({ beads });
    try {
      t.bind(binding);
      assert.deepEqual(await bash(t.deps, 'bd update sub-c2d --claim'), {}, JSON.stringify(binding));
    } finally {
      t.done();
    }
  }
});

test('gate_switch: the next child of the approved epic is allowed', async () => {
  const t = setup({ beads: [bead('sub-e00', { issue_type: 'epic' }), bead('sub-a1b', { parent: 'sub-e00' }), bead('sub-c2d', { parent: 'sub-e00' }), bead('sub-f3g')] });
  try {
    t.bind({ bead: 'sub-a1b', epic: 'sub-e00' });
    assert.deepEqual(await bash(t.deps, 'bd update sub-c2d --claim'), {});
    assert.match((await bash(t.deps, 'bd update sub-f3g --claim')).deny ?? '', /^This chat is bead sub-a1b/);
  } finally {
    t.done();
  }
});

test('gate_switch: a short bound id and the full id are one bead', async () => {
  const t = setup({ beads: [bead('sub-a1b'), bead('sub-c2d', { status: 'open' })] });
  try {
    t.bind({ bead: 'a1b' });
    assert.deepEqual(await bash(t.deps, 'bd update sub-a1b --claim'), {});
    assert.deepEqual(await bash(t.deps, 'bd update a1b --claim'), {});
    assert.deepEqual(await bash(t.deps, 'bd update sub-c2d --claim'), SWITCH);
  } finally {
    t.done();
  }
});

test('gate_update: bd global flags and update value flags after the subcommand are not the bead id', async () => {
  const t = setup({ beads: [bead('sub-a1b'), bead('sub-c2d', { status: 'open' })] });
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await bash(t.deps, 'bd update -C C:/dev/beads sub-a1b --claim'), {});
    assert.deepEqual(await bash(t.deps, 'bd update -C C:/dev/beads sub-c2d --claim'), SWITCH);
    assert.deepEqual(await bash(t.deps, 'bd update --external-ref R149 sub-c2d --claim'), SWITCH);
    assert.deepEqual(await bash(t.deps, 'bd update --external-ref R149 sub-a1b --claim'), {});
  } finally {
    t.done();
  }
});

test('gate_update: a claim through PowerShell is gated like Bash', async () => {
  const t = setup({ beads: [bead('sub-a1b'), bead('sub-c2d', { status: 'open' })] });
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await gate(t.deps, 'PowerShell', { command: 'bd.exe update sub-c2d --claim; Write-Host done' }), SWITCH);
    assert.deepEqual(await gate(t.deps, 'PowerShell', { command: 'bd update sub-a1b --claim' }), {});
  } finally {
    t.done();
  }
});

// --- gate_plan --------------------------------------------------------------------------------

test('gate_plan: with no Bead line, a bound bead gets the WIP check in refuse mode', async () => {
  const t = setup({ beads: [...building(3), bead('sub-c2d', { status: 'open' })], mode: 'refuse' });
  try {
    t.bind({ bead: 'sub-c2d' });
    assert.deepEqual(await gate(t.deps, 'ExitPlanMode', { plan: '# Plan\n\nno bead line' }), { deny: 'Build is at its WIP limit (3/3)' });
  } finally {
    t.done();
  }
  const u = setup({ beads: [...building(3)], mode: 'refuse' });
  try {
    assert.deepEqual(await gate(u.deps, 'ExitPlanMode', { plan: 'no bead line' }), {});
    u.bind({ none: true });
    assert.deepEqual(await gate(u.deps, 'ExitPlanMode', { plan: 'no bead line' }), {});
  } finally {
    u.done();
  }
});

test('gate_plan: a plan naming another bead is denied while this one is open', async () => {
  const t = setup({ beads: [bead('sub-a1b'), bead('sub-c2d')] });
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await gate(t.deps, 'ExitPlanMode', { plan: '# Plan\n\n**Bead:** sub-c2d\n\nSteps' }), SWITCH);
    assert.match((await gate(t.deps, 'ExitPlanMode', { plan: 'Bead: new' })).deny ?? '', /start a new session for a new bead\./);
    assert.deepEqual(await gate(t.deps, 'ExitPlanMode', { plan: 'Bead: sub-a1b' }), {});
    assert.deepEqual(await gate(t.deps, 'ExitPlanMode', { plan: 'no line here' }), {});
  } finally {
    t.done();
  }
});

test('gate_plan: unbound, any plan line is allowed and warn mode loads nothing', async () => {
  const t = setup({ beads: [bead('sub-c2d')] });
  try {
    assert.deepEqual(await gate(t.deps, 'ExitPlanMode', { plan: 'Bead: sub-c2d' }), {});
    assert.equal(t.calls.snapshot, 0);
  } finally {
    t.done();
  }
});

// --- strand approve -----------------------------------------------------------------------------

test('strand approve run by Claude is denied, in Bash and PowerShell', async () => {
  const t = setup();
  const want = { deny: "Approving the spec is the engineer's decision. Ask them to approve the plan, run /strand:approve, or use the cockpit." };
  try {
    assert.deepEqual(await bash(t.deps, 'strand approve sub-a1b'), want);
    assert.deepEqual(await bash(t.deps, 'cd x && node C:/dev/strand/src/cli/strand.ts approve sub-a1b'), want);
    assert.deepEqual(await gate(t.deps, 'PowerShell', { command: 'strand approve sub-a1b' }), want);
    assert.deepEqual(await bash(t.deps, 'strand brief'), {});
    assert.deepEqual(await bash(t.deps, 'strand none'), {});
  } finally {
    t.done();
  }
});

// --- WIP refuse mode --------------------------------------------------------------------------

function building(n: number): ListedBead[] {
  return Array.from({ length: n }, (_, i) => bead(`sub-b0${i}`, { notes: APPROVED, acceptance_criteria: '- [ ] x' }));
}

test('WIP refuse: ExitPlanMode with a Bead line and a Bash claim are denied at the limit', async () => {
  const t = setup({ beads: [...building(3), bead('sub-c2d', { status: 'open' })], mode: 'refuse' });
  const want = { deny: 'Build is at its WIP limit (3/3)' };
  try {
    assert.deepEqual(await gate(t.deps, 'ExitPlanMode', { plan: 'Bead: sub-c2d' }), want);
    assert.deepEqual(await bash(t.deps, 'bd update sub-c2d --claim'), want);
    assert.deepEqual(await bash(t.deps, 'bd update sub-c2d --status=in_progress'), want);
    assert.deepEqual(await gate(t.deps, 'ExitPlanMode', { plan: 'Bead: none' }), {});
    assert.deepEqual(await gate(t.deps, 'ExitPlanMode', { plan: 'Bead: new' }), {});
    // A bead already in Build does not count against itself.
    assert.deepEqual(await bash(t.deps, 'bd update sub-b00 --claim'), {});
  } finally {
    t.done();
  }
});

test('WIP refuse: under the limit, or in warn mode, nothing is denied', async () => {
  const t = setup({ beads: [...building(2), bead('sub-c2d', { status: 'open' })], mode: 'refuse' });
  try {
    assert.deepEqual(await gate(t.deps, 'ExitPlanMode', { plan: 'Bead: sub-c2d' }), {});
  } finally {
    t.done();
  }
  const w = setup({ beads: [...building(3), bead('sub-c2d', { status: 'open' })], mode: 'warn' });
  try {
    assert.deepEqual(await gate(w.deps, 'ExitPlanMode', { plan: 'Bead: sub-c2d' }), {});
    assert.deepEqual(await bash(w.deps, 'bd update sub-c2d --claim'), {});
  } finally {
    w.done();
  }
});

// --- real process -----------------------------------------------------------------------------

const PRE_TOOL_USE = fileURLToPath(new URL('../src/hooks/pre-tool-use.ts', import.meta.url));

test('real process: pre-tool-use denies an Edit with no binding, exit 0, median under 300 ms', () => {
  const home = mkdtempSync(join(tmpdir(), 'strand-gate-home-'));
  try {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData'),
      XDG_CONFIG_HOME: join(home, 'cfg'),
      STRAND_WORKSPACE: join(home, 'ws'),
      PATH: '',
      Path: '',
    };
    const input = JSON.stringify({ session_id: 's1', cwd: home, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/work/proj/a.ts' } });
    const once = () => {
      const t0 = performance.now();
      const r = spawnSync(process.execPath, [PRE_TOOL_USE], { input, encoding: 'utf8', env });
      return { r, ms: performance.now() - t0 };
    };
    once(); // warm-up
    const runs = Array.from({ length: 5 }, once);
    for (const { r } of runs) {
      assert.equal(r.status, 0);
      assert.equal(r.stderr, '');
      assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NO_BEAD } });
    }
    const median = runs.map((x) => x.ms).sort((a, b) => a - b)[2]!;
    assert.ok(median < 300, `median ${median.toFixed(0)} ms`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- review round 1 ---------------------------------------------------------------------------

test('fail open: a refExists error reaches runHook, which allows and logs it', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  t.deps.refExists = async () => {
    throw new Error('git did not answer within 2.5 s');
  };
  try {
    const input = JSON.stringify({ session_id: 's1', cwd: 'C:\\dev\\proj', tool_name: 'Bash', tool_input: { command: 'but reword old -m ada/new' } });
    const a = io(input);
    await runHook((i) => onPreToolUse(i, t.deps), 'PreToolUse', a.io);
    assert.equal(a.o.out, '');
    assert.match(a.o.err, /strand hook PreToolUse: git did not answer/);
    assert.equal(a.o.code, 0);
  } finally {
    t.done();
  }
});

test('buildGateDeps: git errors throw, so the gate fails open', async () => {
  const deps = buildGateDeps({ ...baseEnv(), STRAND_WORKSPACE: join(tmpdir(), 'strand-nonexistent-ws') });
  const gone = join(tmpdir(), 'strand-no-such-repo-dir');
  await assert.rejects(deps.refExists(gone, 'ada/x'), /working directory not found/);
  await assert.rejects(deps.branchOpen(gone, 'ada/x'), /working directory not found/);
  await assert.rejects(deps.mergedPrNumbers(gone, [1]), /working directory not found/);
  await assert.rejects(deps.remoteRepo(gone), /working directory not found/);
});

test('buildGateDeps: a git exit code is an answer', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'strand-gate-repo-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  try {
    if (git('init', '-q', '-b', 'main').status !== 0) return; // git missing: nothing to check
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'one');
    const deps = buildGateDeps({ ...baseEnv(), STRAND_WORKSPACE: join(tmpdir(), 'strand-nonexistent-ws') });
    assert.equal(await deps.refExists(repo, 'main'), true);
    assert.equal(await deps.refExists(repo, 'ada/none'), false);
    assert.equal(await deps.branchOpen(repo, 'main'), false); // no origin/main: not open
    assert.deepEqual(await deps.mergedPrNumbers(repo, [1]), []);
    assert.equal(await deps.remoteRepo(repo), undefined);
    git('remote', 'add', 'origin', 'git@gitea.example.com:me/repo.git');
    assert.equal(await deps.remoteRepo(repo), 'me/repo');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('repoOfUrl: owner/repo from https, ssh and scp remotes, like bash repo_of', () => {
  assert.equal(repoOfUrl('https://gitea.example.com/me/repo.git'), 'me/repo');
  assert.equal(repoOfUrl('https://gitea.example.com/me/repo\n'), 'me/repo');
  assert.equal(repoOfUrl('ssh://git@gitea.example.com:2222/me/repo.git'), 'me/repo');
  assert.equal(repoOfUrl('git@gitea.example.com:me/repo.git'), 'me/repo');
  assert.equal(repoOfUrl('repo'), undefined);
});

test('pr_merged: only pr labels for the origin repo count, and no origin means not merged', async () => {
  const t = setup({ beads: [bead('sub-a1b', { labels: ['branch:ada/first', 'pr:other/repo#7'] })], open: ['ada/first'], merged: [7] });
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.match((await bash(t.deps, 'but branch new ada/second')).deny ?? '', /already has branch ada\/first/);
  } finally {
    t.done();
  }
  const n = setup({ beads: [bead('sub-a1b', { labels: ['branch:ada/first', 'pr:me/repo#7'] })], open: ['ada/first'], merged: [7], remote: null });
  try {
    n.bind({ bead: 'sub-a1b' });
    assert.match((await bash(n.deps, 'but branch new ada/second')).deny ?? '', /already has branch ada\/first/);
  } finally {
    n.done();
  }
});

test('gate_switch: an epic child known only by its parent-child dependency is allowed', async () => {
  const dep = (id: string) => [{ issue_id: id, depends_on_id: 'sub-e00', type: 'parent-child' }];
  const t = setup({
    beads: [bead('sub-e00', { issue_type: 'epic' }), bead('sub-a1b', { dependencies: dep('sub-a1b') }), bead('sub-c2d', { dependencies: dep('sub-c2d') })],
  });
  try {
    t.bind({ bead: 'sub-a1b', epic: 'sub-e00' });
    assert.deepEqual(await bash(t.deps, 'bd update sub-c2d --claim'), {});
  } finally {
    t.done();
  }
});

test('ids typed without the prefix resolve like bd does', async () => {
  const t = setup({ beads: [bead('sub-a1b', { labels: ['branch:ada/mine'] }), bead('sub-c2d', { status: 'open' })], open: ['ada/mine'] });
  try {
    assert.deepEqual(await bash(t.deps, 'bd close a1b'), {
      deny: 'Bead sub-a1b has branch ada/mine, which is not merged into the remote default branch. It closes itself when its PR merges.',
    });
    assert.match((await bash(t.deps, 'bd update a1b --status closed')).deny ?? '', /^Bead sub-a1b has branch ada\/mine/);
    t.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await bash(t.deps, 'bd update c2d --claim'), SWITCH);
    assert.deepEqual(await bash(t.deps, 'bd update a1b --claim'), {});
  } finally {
    t.done();
  }
  const w = setup({ beads: [...building(3), bead('sub-c2d', { status: 'open' })], mode: 'refuse' });
  try {
    assert.deepEqual(await bash(w.deps, 'bd update b00 --claim'), {}); // already in Build: does not count against itself
    assert.deepEqual(await bash(w.deps, 'bd update c2d --claim'), { deny: 'Build is at its WIP limit (3/3)' });
  } finally {
    w.done();
  }
});

test('AskUserQuestion is allowed with no rule check and marks the session as waiting', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    // No index entry: nothing to mark, still allowed.
    assert.deepEqual(await gate(t.deps, 'AskUserQuestion', { questions: [] }), {});
    assert.deepEqual(sessionsFor(t.trackerDir, 'sub-a1b'), []);
    recordStart(t.trackerDir, { sessionId: 's1', beadId: 'sub-a1b' });
    // No bead bound: an edit would be denied, a question is not.
    assert.deepEqual(await gate(t.deps, 'AskUserQuestion', { questions: [] }), {});
    assert.match(sessionsFor(t.trackerDir, 'sub-a1b')[0]?.needsYou ?? '', /^\d{4}-/);
    assert.deepEqual(t.calls, { show: 0, snapshot: 0, git: 0 });
  } finally {
    t.done();
  }
});

test('AskUserQuestion is allowed when the marking fails; other tools do not mark', async () => {
  const t = setup({ beads: [bead('sub-a1b', { notes: APPROVED })] });
  try {
    recordStart(t.trackerDir, { sessionId: 's1', beadId: 'sub-a1b' });
    t.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await edit(t.deps, PROJECT_FILE), {});
    assert.deepEqual(await bash(t.deps, 'ls'), {});
    assert.equal(sessionsFor(t.trackerDir, 'sub-a1b')[0]?.needsYou, undefined);
    const broken: GateDeps = {
      ...t.deps,
      get trackerDir(): string {
        throw new Error('config gone');
      },
    };
    assert.deepEqual(await gate(broken, 'AskUserQuestion', {}), {});
  } finally {
    t.done();
  }
});

test('gate_edit: Git Bash style paths under home and temp are exempt', async () => {
  const t = setup();
  try {
    assert.deepEqual(await edit(t.deps, '/c/Users/Tester/.claude/plans/p.md'), {});
    assert.deepEqual(await edit(t.deps, '/c/users/tester/appdata/local/temp/x.txt'), {});
    assert.deepEqual(await edit(t.deps, '/c/dev/proj/a.ts'), { deny: NO_BEAD });
  } finally {
    t.done();
  }
});
