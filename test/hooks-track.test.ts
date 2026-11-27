import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBinding, writeBinding } from '../src/core/binding.ts';
import type { Binding } from '../src/core/binding.ts';
import type { Bead, ListedBead } from '../src/core/bd.ts';
import { markNeedsYou, recordStart, sessionsFor } from '../src/core/sessions.ts';
import type { TrackDeps } from '../src/hooks/runtime.ts';
import type { HookResult } from '../src/hooks/runtime.ts';
import { onPostToolUse } from '../src/hooks/track.ts';

// --- fixtures ---------------------------------------------------------------------------------

function bead(id: string, over: Partial<ListedBead> = {}): ListedBead {
  return { id, title: `title ${id}`, status: 'open', priority: 2, issue_type: 'task', labels: [], dependencies: [], ...over };
}

type World = {
  beads?: ListedBead[];
  refs?: string[]; // refs/heads that exist
  approve?: (id: string, by: string) => Promise<{ warn?: string }>;
  changed?: boolean;
  failLabel?: boolean;
  failSnapshot?: boolean;
  failClaim?: boolean;
};

function setup(w: World = {}) {
  const trackerDir = mkdtempSync(join(tmpdir(), 'strand-track-'));
  const list = w.beads ?? [];
  const calls: string[] = [];
  const deps: TrackDeps = {
    trackerDir,
    workspaceRoot: 'C:\\dev',
    home: 'C:\\Users\\Tester',
    tmpDirs: [],
    wip: { build: 3, review: 3, mode: 'warn' },
    async snapshot() {
      calls.push('snapshot');
      if (w.failSnapshot) throw new Error('bd list timed out');
      return { beads: new Map(list.map((b) => [b.id, b])), ids: new Set(list.map((b) => b.id)), prefixes: ['sub'] };
    },
    async show(id) {
      return list.find((b) => b.id === id) as unknown as Bead;
    },
    async branchOpen() {
      return false;
    },
    async refExists(_dir, name) {
      return (w.refs ?? []).includes(name);
    },
    async mergedPrNumbers() {
      return [];
    },
    async remoteRepo() {
      return undefined;
    },
    beads: {
      async claim(id) {
        calls.push(`claim ${id}`);
        if (w.failClaim) throw new Error('bd update timed out');
      },
      async addLabel(id, label) {
        if (w.failLabel) throw new Error('bd is down');
        calls.push(`addLabel ${id} ${label}`);
      },
      async removeLabel(id, label) {
        calls.push(`removeLabel ${id} ${label}`);
      },
      async addDep(id, on) {
        calls.push(`addDep ${id} ${on}`);
      },
      async note(id, text) {
        calls.push(`note ${id} ${text}`);
      },
    },
    async approveSpec(_ctx, id, opts) {
      calls.push(`approve ${id} ${opts.by}`);
      return w.approve ? w.approve(id, opts.by) : {};
    },
    async recordBaseline(_ctx, id) {
      calls.push(`baseline ${id}`);
    },
    async criteriaChanged(id) {
      calls.push(`changed? ${id}`);
      return w.changed ?? false;
    },
  };
  const bind = (b: Binding) => writeBinding(trackerDir, 's1', b);
  const binding = () => readBinding(trackerDir, 's1');
  const done = () => rmSync(trackerDir, { recursive: true, force: true });
  return { deps, calls, trackerDir, bind, binding, done };
}

function track(deps: TrackDeps, tool_name: string, tool_input: Record<string, unknown>, tool_response?: unknown): Promise<HookResult> {
  return onPostToolUse({ session_id: 's1', cwd: 'C:\\dev\\proj', tool_name, tool_input, tool_response }, deps);
}
const bash = (deps: TrackDeps, command: string) => track(deps, 'Bash', { command });
const plan = (deps: TrackDeps, text: string) => track(deps, 'ExitPlanMode', { plan: text });

const alreadyApproved = (id: string) => async () => {
  throw new Error(`bead ${id} is already approved`);
};

// --- track_plan and claim_approved ------------------------------------------------------------

test('track_plan: Bead: <id> claims, binds, approves by plan and says so', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    t.bind({ dirty: true, nagged: 'x', appTitle: 'keep me' });
    const r = await plan(t.deps, '# Plan\n\nBead: sub-a1b\n\nSteps...');
    assert.deepEqual(r, { additionalContext: 'Bead workflow: plan approved. Claimed bead sub-a1b and bound this session to it.' });
    assert.deepEqual(t.calls.filter((c) => c !== 'snapshot'), ['claim sub-a1b', 'approve sub-a1b plan']);
    assert.deepEqual(t.binding(), { bead: 'sub-a1b', appTitle: 'keep me' });
  } finally {
    t.done();
  }
});

test('track_plan: bold Bead lines parse, and tool_response is the fallback', async () => {
  const t = setup({ beads: [bead('sub-a1b'), bead('sub-c2d')] });
  try {
    await plan(t.deps, '**Bead:** sub-a1b');
    assert.equal(t.binding().bead, 'sub-a1b');
    await track(t.deps, 'ExitPlanMode', {}, { plan: 'bead: **sub-c2d' });
    assert.equal(t.binding().bead, 'sub-c2d');
  } finally {
    t.done();
  }
});

test('claim_approved: an epic sets the epic, a task clears it', async () => {
  const t = setup({ beads: [bead('sub-e1', { issue_type: 'epic' }), bead('sub-a1b')] });
  try {
    await plan(t.deps, 'Bead: sub-e1');
    assert.deepEqual(t.binding(), { bead: 'sub-e1', epic: 'sub-e1' });
    await plan(t.deps, 'Bead: sub-a1b');
    assert.deepEqual(t.binding(), { bead: 'sub-a1b' });
  } finally {
    t.done();
  }
});

test('claim_approved: a WIP warning rides along in the context', async () => {
  const t = setup({ beads: [bead('sub-a1b')], approve: async () => ({ warn: 'Review is at its WIP limit (3/3)' }) });
  try {
    const r = await plan(t.deps, 'Bead: sub-a1b');
    assert.equal(
      r.additionalContext,
      'Bead workflow: plan approved. Claimed bead sub-a1b and bound this session to it. Warning: Review is at its WIP limit (3/3).',
    );
  } finally {
    t.done();
  }
});

test('claim_approved: refuse mode throws, so bind anyway, write nothing, and return the reason', async () => {
  const t = setup({
    beads: [bead('sub-a1b')],
    approve: async () => {
      throw new Error('Build is at its WIP limit (3/3)');
    },
  });
  try {
    const r = await plan(t.deps, 'Bead: sub-a1b');
    assert.equal(t.binding().bead, 'sub-a1b');
    assert.notEqual(t.binding().approved, true);
    assert.match(r.additionalContext!, /Claimed bead sub-a1b and bound this session to it\./);
    assert.match(r.additionalContext!, /not written: Build is at its WIP limit \(3\/3\)\./);
  } finally {
    t.done();
  }
});

test('claim_approved: an already approved bead is not an error and marks the binding approved', async () => {
  const t = setup({ beads: [bead('sub-a1b')], approve: alreadyApproved('sub-a1b') });
  try {
    const r = await plan(t.deps, 'Bead: sub-a1b');
    assert.deepEqual(r, { additionalContext: 'Bead workflow: plan approved. Claimed bead sub-a1b and bound this session to it.' });
    assert.deepEqual(t.binding(), { bead: 'sub-a1b', approved: true });
  } finally {
    t.done();
  }
});

test('claim_approved: a bead bd cannot find is reported and nothing is claimed or bound', async () => {
  const t = setup({ beads: [] });
  try {
    const r = await plan(t.deps, 'Bead: sub-zzz');
    assert.equal(
      r.additionalContext,
      "Bead workflow: the approved plan names bead sub-zzz, which bd cannot find. Find the right id and run 'bd update <id> --claim'.",
    );
    assert.deepEqual(t.calls, ['snapshot']);
    assert.deepEqual(t.binding(), {});
  } finally {
    t.done();
  }
});

test('track_plan: Bead: none binds none and drops the epic', async () => {
  const t = setup();
  try {
    t.bind({ bead: 'sub-e1', epic: 'sub-e1' });
    assert.deepEqual(await plan(t.deps, 'Bead: none'), {});
    assert.deepEqual(t.binding(), { none: true });
    assert.deepEqual(t.calls, []);
  } finally {
    t.done();
  }
});

test('track_plan: Bead: new gives the filing reminder and binds nothing', async () => {
  const t = setup();
  try {
    const r = await plan(t.deps, 'Bead: new');
    assert.equal(
      r.additionalContext,
      "Bead workflow: the plan was approved with 'Bead: new'. File the bead with strand new, then run 'bd update <id> --claim' before the first edit.",
    );
    assert.deepEqual(t.binding(), {});
    assert.deepEqual(t.calls, []);
  } finally {
    t.done();
  }
});

test('track_plan: a plan with no Bead line does nothing', async () => {
  const t = setup();
  try {
    assert.deepEqual(await plan(t.deps, 'Just a plan'), {});
    assert.deepEqual(t.calls, []);
  } finally {
    t.done();
  }
});

// --- track_claim ------------------------------------------------------------------------------

test('track_claim: bd update --claim binds the bead and approves by claim', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    t.bind({ none: true, dirty: true });
    assert.deepEqual(await bash(t.deps, 'bd update sub-a1b --claim'), {});
    assert.deepEqual(t.binding(), { bead: 'sub-a1b' });
    assert.deepEqual(t.calls, ['snapshot', 'approve sub-a1b claim']);
  } finally {
    t.done();
  }
});

test('track_claim: --status in_progress binds too, in both flag spellings', async () => {
  const t = setup({ beads: [bead('sub-a1b'), bead('sub-c2d')] });
  try {
    await bash(t.deps, 'bd update sub-a1b -s in_progress');
    assert.equal(t.binding().bead, 'sub-a1b');
    await bash(t.deps, 'bd update sub-c2d --status=in_progress');
    assert.equal(t.binding().bead, 'sub-c2d');
  } finally {
    t.done();
  }
});

test('track_claim: an update that is not a claim binds nothing', async () => {
  const t = setup();
  try {
    await bash(t.deps, 'bd update sub-a1b --add-label x');
    await bash(t.deps, 'bd update sub-a1b --status blocked');
    assert.deepEqual(t.binding(), {});
    assert.deepEqual(t.calls, []);
  } finally {
    t.done();
  }
});

test('track_claim: an already approved bead is silent', async () => {
  const t = setup({ beads: [bead('sub-a1b')], approve: alreadyApproved('sub-a1b') });
  try {
    assert.deepEqual(await bash(t.deps, 'bd update sub-a1b --claim'), {});
    assert.deepEqual(t.binding(), { bead: 'sub-a1b', approved: true });
  } finally {
    t.done();
  }
});

test('track_claim: a WIP warning and a refuse reason come back as context, the bind stays', async () => {
  const warn = setup({ beads: [bead('sub-a1b')], approve: async () => ({ warn: 'Review is at its WIP limit (3/3)' }) });
  try {
    const r = await bash(warn.deps, 'bd update sub-a1b --claim');
    assert.match(r.additionalContext!, /Warning: Review is at its WIP limit \(3\/3\)\./);
  } finally {
    warn.done();
  }
  const refuse = setup({
    beads: [bead('sub-a1b')],
    approve: async () => {
      throw new Error('Review is at its WIP limit (3/3)');
    },
  });
  try {
    const r = await bash(refuse.deps, 'bd update sub-a1b --claim');
    assert.match(r.additionalContext!, /approval was not written: Review is at its WIP limit \(3\/3\)\./);
    assert.equal(refuse.binding().bead, 'sub-a1b');
  } finally {
    refuse.done();
  }
});

test('track_claim: an epic child keeps the approved epic', async () => {
  const t = setup({ beads: [bead('sub-e1', { issue_type: 'epic' }), bead('sub-e1.1'), bead('sub-e1.2')] });
  try {
    t.bind({ bead: 'sub-e1.1', epic: 'sub-e1' });
    await bash(t.deps, 'bd update sub-e1.2 --claim');
    assert.deepEqual(t.binding(), { bead: 'sub-e1.2', epic: 'sub-e1' });
  } finally {
    t.done();
  }
});

// --- strand none --------------------------------------------------------------------------------

test('strand none: a command that runs it binds none', async () => {
  const t = setup();
  try {
    await bash(t.deps, 'strand none');
    assert.deepEqual(t.binding(), { none: true });
    await bash(t.deps, 'bd update sub-a1b --claim && strand none');
    assert.deepEqual(t.binding(), { none: true });
  } finally {
    t.done();
  }
});

test('strand none: the words inside an echo do not bind', async () => {
  const t = setup();
  try {
    await bash(t.deps, 'echo "strand none"');
    assert.deepEqual(t.binding(), {});
  } finally {
    t.done();
  }
});

// --- release ----------------------------------------------------------------------------------

test('release: bd close of the bound bead unbinds it and clears the epic', async () => {
  const t = setup();
  try {
    t.bind({ bead: 'sub-a1b', dirty: true, appTitle: 'keep me' });
    await bash(t.deps, 'bd close sub-a1b --reason done');
    assert.deepEqual(t.binding(), { appTitle: 'keep me' });
  } finally {
    t.done();
  }
});

test('release: bd close of another bead leaves the binding alone', async () => {
  const t = setup();
  try {
    t.bind({ bead: 'sub-a1b' });
    await bash(t.deps, 'bd close sub-zzz');
    assert.deepEqual(t.binding(), { bead: 'sub-a1b' });
  } finally {
    t.done();
  }
});

test('release: a finished child falls back to the approved epic', async () => {
  const t = setup();
  try {
    t.bind({ bead: 'sub-e1.1', epic: 'sub-e1', dirty: true });
    await bash(t.deps, 'bd close sub-e1.1');
    assert.deepEqual(t.binding(), { bead: 'sub-e1', epic: 'sub-e1' });
    await bash(t.deps, 'bd close sub-e1');
    assert.deepEqual(t.binding(), {});
  } finally {
    t.done();
  }
});

// --- label_branch -----------------------------------------------------------------------------

test('label_branch: but branch new labels the bound bead when the ref exists', async () => {
  const t = setup({ refs: ['ada/topic'] });
  try {
    t.bind({ bead: 'sub-a1b' });
    await bash(t.deps, 'but branch new ada/topic');
    assert.deepEqual(t.calls, ['addLabel sub-a1b branch:ada/topic']);
  } finally {
    t.done();
  }
});

test('label_branch: no ref, no bound bead, or bound none means no label', async () => {
  const t = setup({ refs: ['ada/topic'] });
  try {
    t.bind({ bead: 'sub-a1b' });
    await bash(t.deps, 'but branch new ada/other');
    t.bind({ none: true });
    await bash(t.deps, 'but branch new ada/topic');
    t.bind({});
    await bash(t.deps, 'but branch new ada/topic');
    assert.deepEqual(t.calls, []);
  } finally {
    t.done();
  }
});

test('label_branch: -A makes this bead depend on the parent branch bead', async () => {
  const t = setup({ refs: ['ada/child'], beads: [bead('sub-p1', { labels: ['branch:ada/parent'] })] });
  try {
    t.bind({ bead: 'sub-a1b' });
    await bash(t.deps, 'but branch new -A ada/parent ada/child');
    assert.deepEqual(t.calls.filter((c) => c !== 'snapshot'), ['addLabel sub-a1b branch:ada/child', 'addDep sub-a1b sub-p1']);
  } finally {
    t.done();
  }
});

test('label_branch: -B makes the other bead depend on this one', async () => {
  const t = setup({ refs: ['ada/child'], beads: [bead('sub-p1', { labels: ['branch:ada/parent'] })] });
  try {
    t.bind({ bead: 'sub-a1b' });
    await bash(t.deps, 'but branch new --below ada/parent ada/child');
    assert.deepEqual(t.calls.filter((c) => c !== 'snapshot'), ['addLabel sub-a1b branch:ada/child', 'addDep sub-p1 sub-a1b']);
  } finally {
    t.done();
  }
});

test('label_branch: a parent branch with no bead adds no dependency', async () => {
  const t = setup({ refs: ['ada/child'] });
  try {
    t.bind({ bead: 'sub-a1b' });
    await bash(t.deps, 'but branch new -A ada/stray ada/child');
    assert.deepEqual(t.calls.filter((c) => c !== 'snapshot'), ['addLabel sub-a1b branch:ada/child']);
  } finally {
    t.done();
  }
});

// --- relabel_branch ---------------------------------------------------------------------------

test('relabel_branch: but reword old -m new moves the label on the owner', async () => {
  const t = setup({ refs: ['ada/new'], beads: [bead('sub-a1b', { labels: ['branch:ada/old'] })] });
  try {
    await bash(t.deps, 'but reword ada/old -m ada/new');
    // Add first, so a failure part way leaves the bead with a label it can be found by.
    assert.deepEqual(t.calls.filter((c) => c !== 'snapshot'), ['addLabel sub-a1b branch:ada/new', 'removeLabel sub-a1b branch:ada/old']);
  } finally {
    t.done();
  }
});

test('relabel_branch: no new ref, no owner, or a commit message means no change', async () => {
  const t = setup({ refs: [], beads: [bead('sub-a1b', { labels: ['branch:ada/old'] })] });
  try {
    await bash(t.deps, 'but reword ada/old -m ada/new');
    await bash(t.deps, 'but reword abc123 -m "fix the thing"');
    await bash(t.deps, 'but reword ada/old');
    assert.deepEqual(t.calls.filter((c) => c !== 'snapshot'), []);
  } finally {
    t.done();
  }
});

// --- dirty flag and app title -----------------------------------------------------------------

test('dirty: an edit marks a bound session, an unbound one stays clean, bind clears it', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      t.bind({});
      await track(t.deps, tool, { file_path: 'a.ts' });
      assert.deepEqual(t.binding(), {}, tool);
    }
    t.bind({ bead: 'sub-a1b' });
    await track(t.deps, 'Edit', { file_path: 'a.ts' });
    assert.deepEqual(t.binding(), { bead: 'sub-a1b', dirty: true });
    t.bind({ none: true });
    await track(t.deps, 'Write', { file_path: 'a.ts' });
    assert.equal(t.binding().dirty, true);
    assert.equal(t.calls.includes('snapshot'), false);
    await bash(t.deps, 'bd update sub-a1b --claim');
    assert.equal(t.binding().dirty, undefined);
  } finally {
    t.done();
  }
});

test('app title: the set-title tool for this session records the title', async () => {
  const t = setup();
  try {
    t.bind({ bead: 'sub-a1b' });
    const tool = 'mcp__ccd_session_mgmt__set_session_title';
    await track(t.deps, tool, { session_id: 'other', title: 'nope' });
    assert.equal(t.binding().appTitle, undefined);
    await track(t.deps, tool, { session_id: 'self', title: 'WIP: sub-a1b title' });
    assert.deepEqual(t.binding(), { bead: 'sub-a1b', appTitle: 'WIP: sub-a1b title' });
  } finally {
    t.done();
  }
});

// --- criteria baseline ------------------------------------------------------------------------

test('criteria: an acceptance update on the bound bead records the baseline, quiet when unchanged', async () => {
  const t = setup();
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await bash(t.deps, "bd update sub-a1b --acceptance '- [ ] a (check: x)'"), {});
    assert.deepEqual(t.calls, ['baseline sub-a1b', 'changed? sub-a1b']);
  } finally {
    t.done();
  }
});

test('criteria: a changed hash tells Claude to ask the engineer', async () => {
  const t = setup({ changed: true });
  try {
    t.bind({ bead: 'sub-a1b' });
    const r = await bash(t.deps, 'bd update sub-a1b --acceptance="- [ ] b (check: y)"');
    assert.equal(
      r.additionalContext,
      'The acceptance criteria of sub-a1b changed after approval. Show the engineer the change and ask. On a yes, run strand criteria accept sub-a1b.',
    );
  } finally {
    t.done();
  }
});

test('criteria: another bead, or an unbound session, is ignored', async () => {
  const t = setup({ changed: true });
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await bash(t.deps, "bd update sub-zzz --acceptance 'x'"), {});
    t.bind({});
    assert.deepEqual(await bash(t.deps, "bd update sub-a1b --acceptance 'x'"), {});
    // Another bead's id is resolved through the snapshot, then ignored: no baseline, no check.
    assert.deepEqual(t.calls.filter((c) => c !== 'snapshot'), []);
  } finally {
    t.done();
  }
});

test('criteria: an update typed with the short id records the baseline of the bound canonical bead', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    t.bind({ bead: 'sub-a1b' });
    assert.deepEqual(await bash(t.deps, "bd update a1b --acceptance '- [ ] a (check: x)'"), {});
    assert.deepEqual(t.calls.filter((c) => c !== 'snapshot'), ['baseline sub-a1b', 'changed? sub-a1b']);
  } finally {
    t.done();
  }
});

// --- errors and wiring ------------------------------------------------------------------------

/** Run fn with process.stderr.write captured. */
async function withStderr<T>(fn: () => Promise<T>): Promise<{ value: T; err: string }> {
  const orig = process.stderr.write;
  let err = '';
  process.stderr.write = ((s: string | Uint8Array) => ((err += String(s)), true)) as typeof process.stderr.write;
  try {
    return { value: await fn(), err };
  } finally {
    process.stderr.write = orig;
  }
}

test('errors: a failing command is logged to stderr and the rest of the line still runs', async () => {
  const t = setup({ refs: ['ada/topic'], failLabel: true });
  try {
    t.bind({ bead: 'sub-a1b' });
    const r = await withStderr(() => bash(t.deps, 'but branch new ada/topic && strand none'));
    assert.deepEqual(r.value, {});
    assert.match(r.err, /bd is down/);
    assert.deepEqual(t.binding(), { none: true });
  } finally {
    t.done();
  }
});

test('other tools and non-command input do nothing', async () => {
  const t = setup();
  try {
    assert.deepEqual(await track(t.deps, 'Read', { file_path: 'a' }), {});
    assert.deepEqual(await track(t.deps, 'Bash', {}), {});
    assert.deepEqual(await bash(t.deps, 'ls -la'), {});
    assert.deepEqual(t.calls, []);
  } finally {
    t.done();
  }
});

// --- fix wave: canonical ids, order, label_pr, lastStage ---------------------------------------

test('track_claim: a short id binds the canonical id, and a later full id claim is the same bead', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    await bash(t.deps, 'bd update a1b --claim');
    assert.equal(t.binding().bead, 'sub-a1b');
    assert.ok(t.calls.includes('approve sub-a1b claim'), t.calls.join(','));
    await bash(t.deps, 'bd update sub-a1b --claim');
    assert.equal(t.binding().bead, 'sub-a1b');
  } finally {
    t.done();
  }
});

test('track_claim: flag values and bd global flags after update are not the bead id', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    await bash(t.deps, 'bd update --external-ref R149 sub-a1b --claim');
    assert.equal(t.binding().bead, 'sub-a1b');
    t.bind({});
    await bash(t.deps, 'bd update -C C:/dev/beads sub-a1b --claim');
    assert.equal(t.binding().bead, 'sub-a1b');
  } finally {
    t.done();
  }
});

test('track_claim: an id the loaded snapshot does not hold is not bound, and the context says so', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    t.bind({ bead: 'sub-a1b' });
    const r = await bash(t.deps, 'bd update sub-zzz --claim');
    assert.equal(t.binding().bead, 'sub-a1b');
    assert.match(r.additionalContext ?? '', /sub-zzz is not in the tracker/);
    assert.ok(!t.calls.some((c) => c.startsWith('approve')));
  } finally {
    t.done();
  }
});

test('track_claim: when the snapshot cannot load, the typed id is bound as before', async () => {
  const t = setup({ failSnapshot: true });
  try {
    await bash(t.deps, 'bd update sub-a1b --claim');
    assert.equal(t.binding().bead, 'sub-a1b');
  } finally {
    t.done();
  }
});

test('track_claim: a claim through PowerShell binds like Bash', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    await track(t.deps, 'PowerShell', { command: 'bd.exe update sub-a1b --claim; Write-Host ok' });
    assert.equal(t.binding().bead, 'sub-a1b');
  } finally {
    t.done();
  }
});

test('claim_approved: a short id in the plan claims and binds the canonical id', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    const r = await plan(t.deps, 'Bead: a1b');
    assert.equal(t.binding().bead, 'sub-a1b');
    assert.deepEqual(t.calls.filter((c) => c !== 'snapshot'), ['claim sub-a1b', 'approve sub-a1b plan']);
    assert.match(r.additionalContext!, /Claimed bead sub-a1b/);
  } finally {
    t.done();
  }
});

test('claim_approved: a closed bead is not claimed or bound, and the context says it is closed', async () => {
  const t = setup({ beads: [bead('sub-a1b', { status: 'closed' })] });
  try {
    const r = await plan(t.deps, 'Bead: sub-a1b');
    assert.deepEqual(t.binding(), {});
    assert.deepEqual(t.calls, ['snapshot']);
    assert.match(r.additionalContext!, /sub-a1b, which is closed/);
  } finally {
    t.done();
  }
});

test('claim_approved: the session is bound before the claim, so a failed claim still leaves it bound and approved', async () => {
  const t = setup({ beads: [bead('sub-a1b')], failClaim: true });
  try {
    const r = await withStderr(() => plan(t.deps, 'Bead: sub-a1b'));
    assert.equal(t.binding().bead, 'sub-a1b');
    assert.ok(t.calls.includes('approve sub-a1b plan'));
    assert.match(r.value.additionalContext!, /claim failed: bd update timed out/);
  } finally {
    t.done();
  }
});

test('track_plan: no Bead line in a bound session approves the bound bead', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    t.bind({ bead: 'sub-a1b' });
    const r = await plan(t.deps, '# Plan\n\nSteps only');
    assert.deepEqual(t.calls.filter((c) => c !== 'snapshot'), ['claim sub-a1b', 'approve sub-a1b plan']);
    assert.match(r.additionalContext!, /plan approved\. Claimed bead sub-a1b/);
    t.bind({ none: true });
    t.calls.length = 0;
    assert.deepEqual(await plan(t.deps, 'Steps only'), {});
    assert.deepEqual(t.calls, []);
  } finally {
    t.done();
  }
});

test('release: bd close matches canonical ids, short or full on either side', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    t.bind({ bead: 'sub-a1b' });
    await bash(t.deps, 'bd close a1b --reason done');
    assert.deepEqual(t.binding(), {});
    t.bind({ bead: 'a1b' });
    await bash(t.deps, 'bd close sub-a1b');
    assert.deepEqual(t.binding(), {});
    t.bind({ bead: 'sub-a1b' });
    await bash(t.deps, 'bd close sub-zzz --reason sub-a1b-ish');
    assert.equal(t.binding().bead, 'sub-a1b');
  } finally {
    t.done();
  }
});

const PR_REPLY = { stdout: '{"id":9,"number":7,"url":"https://git.example/api/v1/repos/acme/orders/pulls/7","html_url":"https://git.example/acme/orders/pulls/7"}', stderr: '' };

const API = 'https://gitea.example/api/v1/repos/o/r/pulls';
const ONE_PULL = { stdout: '{"id":3,"number":7,"url":"https://gitea.example/api/v1/repos/o/r/pulls/7","html_url":"https://gitea.example/o/r/pulls/7","state":"open"}', stderr: '' };
const PULL_LIST = {
  stdout:
    '[{"number":5,"html_url":"https://gitea.example/o/r/pulls/5","merged":true},{"number":4,"html_url":"https://gitea.example/o/r/pulls/4","merged":true}]',
  stderr: '',
};
const ERROR_BODY = { stdout: '{"message":"pull request already exists for these targets","url":"https://gitea.example/api/swagger"}', stderr: '' };

// [name, tool, command, response, label or undefined]
const LABEL_PR_ROWS: [string, string, string, unknown, string | undefined][] = [
  ['curl -G --data-urlencode lists pulls', 'Bash', `curl -s -G --data-urlencode state=closed "${API}"`, PULL_LIST, undefined],
  ['curl --get -d lists pulls', 'Bash', `curl --get -d state=all ${API}`, PULL_LIST, undefined],
  ['the word POST in a pipe is not a POST', 'Bash', `curl -s ${API} | grep -c POST`, PULL_LIST, undefined],
  ['a list reply to a POST adds nothing', 'Bash', `curl -X POST -d '{}' ${API}`, PULL_LIST, undefined],
  ['a real curl POST with one pull', 'Bash', `curl -X POST -H "Content-Type: application/json" -d '{"title":"t"}' ${API}`, ONE_PULL, 'pr:o/r#7'],
  ['--request=post, any case', 'Bash', `curl --request=post --json @pr.json ${API}/`, ONE_PULL, 'pr:o/r#7'],
  ['PowerShell -Method Post with -Body', 'PowerShell', `Invoke-RestMethod -Method Post -Uri '${API}' -Body $b | ConvertTo-Json`, ONE_PULL, 'pr:o/r#7'],
  ['PowerShell with no -Method is a GET', 'PowerShell', `Invoke-RestMethod -Uri '${API}' | ConvertTo-Json`, PULL_LIST, undefined],
  ['PowerShell irm -Method Get', 'PowerShell', `irm -Method Get -Uri '${API}' -Body $q`, ONE_PULL, undefined],
  ['a one-element list reply adds nothing', 'Bash', `curl -X POST -d '{}' ${API}`, { stdout: `[${ONE_PULL.stdout}]` }, undefined],
  ['a POST that answers with an error body', 'Bash', `curl -X POST -d '{}' ${API}`, ERROR_BODY, undefined],
  ['a POST to /pulls/7/reviews', 'Bash', `curl -X POST -d '{}' ${API}/7/reviews`, ONE_PULL, undefined],
  ['a POST to /issues', 'Bash', `curl -X POST -d '{}' https://gitea.example/api/v1/repos/o/r/issues`, ONE_PULL, undefined],
  ['a query string after /pulls', 'Bash', `curl -X POST -d '{}' "${API}?state=closed"`, ONE_PULL, undefined],
];

for (const [name, tool, command, response, label] of LABEL_PR_ROWS) {
  test(`label_pr: ${name}`, async () => {
    const t = setup();
    try {
      t.bind({ bead: 'sub-a1b' });
      await track(t.deps, tool, { command }, response);
      assert.deepEqual(t.calls, label ? [`addLabel sub-a1b ${label}`] : []);
    } finally {
      t.done();
    }
  });
}

test('label_pr: a POST to /pulls labels the bound bead from the html_url in the reply', async () => {
  const t = setup();
  try {
    t.bind({ bead: 'sub-a1b' });
    const cmd = 'curl -s -X POST -H "Content-Type: application/json" --data @pr.json "https://git.example/api/v1/repos/acme/orders/pulls"';
    await track(t.deps, 'Bash', { command: cmd }, PR_REPLY);
    assert.deepEqual(t.calls, ['addLabel sub-a1b pr:acme/orders#7']);
  } finally {
    t.done();
  }
});

test('label_pr: -d also counts, and PowerShell Invoke-RestMethod -Method Post works', async () => {
  const t = setup();
  try {
    t.bind({ bead: 'sub-a1b' });
    await track(t.deps, 'Bash', { command: "curl -d '{}' https://git.example/api/v1/repos/acme/orders/pulls" }, PR_REPLY);
    await track(
      t.deps,
      'PowerShell',
      { command: "Invoke-RestMethod -Method Post -Uri 'https://git.example/api/v1/repos/acme/orders/pulls' -Body $b" },
      PR_REPLY,
    );
    assert.deepEqual(t.calls, ['addLabel sub-a1b pr:acme/orders#7', 'addLabel sub-a1b pr:acme/orders#7']);
  } finally {
    t.done();
  }
});

test('label_pr: never on a GET, with no bound bead, or with only /api/v1/ links in the reply', async () => {
  const t = setup();
  try {
    t.bind({ bead: 'sub-a1b' });
    await track(t.deps, 'Bash', { command: 'curl -s https://git.example/api/v1/repos/acme/orders/pulls' }, PR_REPLY);
    await track(t.deps, 'Bash', { command: 'curl -X GET -d state=open https://git.example/api/v1/repos/acme/orders/pulls' }, PR_REPLY);
    await track(
      t.deps,
      'Bash',
      { command: 'curl -X POST --data @x https://git.example/api/v1/repos/acme/orders/pulls' },
      { stdout: '{"url":"https://git.example/api/v1/repos/acme/orders/pulls/7"}' },
    );
    t.bind({ none: true });
    await track(t.deps, 'Bash', { command: 'curl -X POST --data @x https://git.example/api/v1/repos/acme/orders/pulls' }, PR_REPLY);
    t.bind({});
    await track(t.deps, 'Bash', { command: 'curl -X POST --data @x https://git.example/api/v1/repos/acme/orders/pulls' }, PR_REPLY);
    assert.deepEqual(t.calls, []);
  } finally {
    t.done();
  }
});

test('lastStage: bind, bind none, release and unbind clear it', async () => {
  const t = setup({ beads: [bead('sub-a1b'), bead('sub-c2d')] });
  try {
    t.bind({ bead: 'sub-c2d', lastStage: 'build' });
    await bash(t.deps, 'bd update sub-a1b --claim');
    assert.equal(t.binding().lastStage, undefined);
    t.bind({ bead: 'sub-a1b', lastStage: 'build' });
    await bash(t.deps, 'strand none');
    assert.equal(t.binding().lastStage, undefined);
    t.bind({ bead: 'sub-a1b', lastStage: 'build' });
    await bash(t.deps, 'bd close sub-a1b');
    assert.equal(t.binding().lastStage, undefined);
    t.bind({ bead: 'sub-a1b', epic: 'sub-c2d', lastStage: 'build' });
    await bash(t.deps, 'bd close sub-a1b');
    assert.deepEqual(t.binding(), { bead: 'sub-c2d', epic: 'sub-c2d' });
  } finally {
    t.done();
  }
});

test('any tracked tool clears the waiting mark: the engineer answered or allowed, work goes on', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    const waiting = () => sessionsFor(t.trackerDir, 'sub-a1b')[0]?.needsYou;
    recordStart(t.trackerDir, { sessionId: 's1', beadId: 'sub-a1b' });
    for (const [tool, input] of [['AskUserQuestion', { questions: [] }], ['Bash', { command: 'ls' }], ['Edit', { file_path: 'a.ts' }], ['ExitPlanMode', { plan: 'Bead: none' }]] as const) {
      markNeedsYou(t.trackerDir, 's1');
      assert.ok(waiting(), tool);
      await track(t.deps, tool, input);
      assert.equal(waiting(), undefined, tool);
    }
    assert.deepEqual(await track(t.deps, 'AskUserQuestion', {}), {});
  } finally {
    t.done();
  }
});

test('a failed clear never stops the tracking', async () => {
  const t = setup({ beads: [bead('sub-a1b')] });
  try {
    t.bind({ bead: 'sub-a1b' });
    let reads = 0;
    const deps: TrackDeps = Object.create(t.deps, {
      trackerDir: {
        get() {
          // The clear reads it first.
          if (++reads === 1) throw new Error('config gone');
          return t.trackerDir;
        },
      },
    });
    await track(deps, 'Edit', { file_path: 'a.ts' });
    assert.equal(t.binding().dirty, true);
  } finally {
    t.done();
  }
});

test('hooks.json: PostToolUse is registered with the tools, entry file and timeout', () => {
  const h = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const entry = h.PostToolUse[0];
  assert.equal(entry.matcher, 'Edit|Write|NotebookEdit|Bash|PowerShell|ExitPlanMode|AskUserQuestion|mcp__ccd_session_mgmt__set_session_title');
  assert.equal(entry.hooks[0].timeout, 10);
  assert.match(entry.hooks[0].command, /src\/hooks\/post-tool-use\.ts/);
  assert.ok(h.PreToolUse && h.SessionEnd && h.SessionStart && h.UserPromptSubmit);
});
