import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBinding, writeBinding } from '../src/core/binding.ts';
import type { Binding } from '../src/core/binding.ts';
import type { ListedBead } from '../src/core/bd.ts';
import { recordStart, sessionsFor } from '../src/core/sessions.ts';
import { onStop } from '../src/hooks/stop.ts';
import type { StopDeps } from '../src/hooks/stop.ts';

function bead(id: string, over: Partial<ListedBead> = {}): ListedBead {
  return { id, title: `title ${id}`, status: 'in_progress', priority: 2, issue_type: 'task', labels: [], dependencies: [], ...over };
}

const APPROVED = 'plan-approved 2026-11-20T10:00:00.000Z';
const VERIFIED = '- [x] It works (verified: make test passed)';

type World = { beads?: ListedBead[]; merged?: number[]; changeId?: string[]; failClose?: boolean; failSnapshot?: boolean; entrypoint?: string };

function setup(w: World = {}) {
  const trackerDir = mkdtempSync(join(tmpdir(), 'strand-stop-'));
  const calls: string[] = [];
  const list = w.beads ?? [];
  const deps: StopDeps = {
    trackerDir,
    entrypoint: w.entrypoint,
    async snapshot() {
      calls.push('snapshot');
      if (w.failSnapshot) throw new Error('bd did not answer');
      return { beads: new Map(list.map((b) => [b.id, b])), ids: new Set(list.map((b) => b.id)), prefixes: ['sub'] };
    },
    beads: {
      async close(id, reason, session) {
        if (w.failClose) throw new Error('bd is down');
        calls.push(`close ${id} ${reason} @${session}`);
      },
    },
    async remoteRepo() {
      return 'acme/svc';
    },
    async mergedPrNumbers(_dir, numbers) {
      return numbers.filter((n) => (w.merged ?? []).includes(n));
    },
    async mergedByChangeId(_dir, name) {
      return (w.changeId ?? []).includes(name);
    },
  };
  const bind = (b: Binding) => writeBinding(trackerDir, 's1', b);
  const binding = () => readBinding(trackerDir, 's1');
  const stop = (extra: { stop_hook_active?: boolean } = {}) => onStop({ session_id: 's1', cwd: 'C:\\dev\\svc', ...extra }, deps);
  const done = () => rmSync(trackerDir, { recursive: true, force: true });
  return { deps, calls, bind, binding, stop, done };
}

test('stop: does nothing while a Stop hook is already active, or with no bead bound', async () => {
  const t = setup({ beads: [bead('sub-a1')] });
  try {
    t.bind({ bead: 'sub-a1', dirty: true });
    assert.deepEqual(await t.stop({ stop_hook_active: true }), {});
    t.bind({ none: true });
    assert.deepEqual(await t.stop(), {});
    t.bind({});
    assert.deepEqual(await t.stop(), {});
    assert.deepEqual(t.calls, []);
  } finally {
    t.done();
  }
});

test('stop: a bead the loaded snapshot does not hold is released, and the message says so', async () => {
  const t = setup({ beads: [] });
  try {
    t.bind({ bead: 'sub-gone', dirty: true, lastStage: 'build', appTitle: 'x' });
    assert.deepEqual(await t.stop(), {
      systemMessage: 'Bead sub-gone is no longer in the tracker. This session is no longer bound to it.',
    });
    assert.deepEqual(t.binding(), { appTitle: 'x' });
  } finally {
    t.done();
  }
});

test('stop: a PR label with no branch label closes the bead when the PR merged', async () => {
  const t = setup({ beads: [bead('sub-a1', { labels: ['pr:acme/svc#7'] })], merged: [7] });
  try {
    t.bind({ bead: 'sub-a1', lastStage: 'verify' });
    assert.deepEqual(await t.stop(), { systemMessage: 'Closed bead sub-a1: its PR merged.' });
    assert.deepEqual(t.calls, ['snapshot', 'close sub-a1 Merged as acme/svc#7 @s1']);
    assert.deepEqual(t.binding(), {});
  } finally {
    t.done();
  }
});

test('stop: a failing bd read throws and never clears the binding', async () => {
  const t = setup({ failSnapshot: true });
  try {
    t.bind({ bead: 'sub-a1', epic: 'sub-e1' });
    await assert.rejects(t.stop(), /bd did not answer/);
    assert.deepEqual(t.binding(), { bead: 'sub-a1', epic: 'sub-e1' });
  } finally {
    t.done();
  }
});

test('stop: a closed bead releases the session, to the epic when there is one', async () => {
  const t = setup({ beads: [bead('sub-a1', { status: 'closed' })] });
  try {
    t.bind({ bead: 'sub-a1', epic: 'sub-e1', dirty: true, appTitle: 'x', lastStage: 'build' });
    assert.deepEqual(await t.stop(), {});
    assert.deepEqual(t.binding(), { bead: 'sub-e1', epic: 'sub-e1', appTitle: 'x' });
    t.bind({ bead: 'sub-a1', appTitle: 'x', lastStage: 'verify' });
    await t.stop();
    assert.deepEqual(t.binding(), { appTitle: 'x' });
  } finally {
    t.done();
  }
});

test('stop: a merged PR closes the bead and releases the session', async () => {
  const t = setup({ beads: [bead('sub-a1', { labels: ['branch:ada/x', 'pr:acme/svc#7'] })], merged: [7] });
  try {
    t.bind({ bead: 'sub-a1' });
    assert.deepEqual(await t.stop(), { systemMessage: 'Closed bead sub-a1: its PR merged.' });
    assert.deepEqual(t.calls, ['snapshot', 'close sub-a1 Merged as acme/svc#7 @s1']);
    assert.deepEqual(t.binding(), {});
  } finally {
    t.done();
  }
});

test('stop: a PR in another repo is not read as merged', async () => {
  const t = setup({ beads: [bead('sub-a1', { labels: ['pr:acme/other#7'] })], merged: [7] });
  try {
    t.bind({ bead: 'sub-a1' });
    assert.deepEqual(await t.stop(), {});
    assert.deepEqual(t.binding(), { bead: 'sub-a1' });
  } finally {
    t.done();
  }
});

test('stop: a branch merged by Change-Id closes a bead with no PR label', async () => {
  const t = setup({ beads: [bead('sub-a1', { labels: ['branch:ada/x'] })], changeId: ['ada/x'] });
  try {
    t.bind({ bead: 'sub-a1' });
    assert.deepEqual(await t.stop(), { systemMessage: 'Closed bead sub-a1: its branch merged.' });
    assert.deepEqual(t.calls, ['snapshot', 'close sub-a1 Merged by Change-Id from ada/x @s1']);
    assert.deepEqual(t.binding(), {});
  } finally {
    t.done();
  }
});

test('stop: a build-stage bead whose branch merged by Change-Id closes', async () => {
  const t = setup({ beads: [bead('sub-a1', { notes: APPROVED, acceptance_criteria: '- [ ] a (check: x)', labels: ['branch:ada/x'] })], changeId: ['ada/x'] });
  try {
    t.bind({ bead: 'sub-a1' });
    assert.deepEqual(await t.stop(), { systemMessage: 'Closed bead sub-a1: its branch merged.' });
  } finally {
    t.done();
  }
});

test('stop: a PR label for another repo falls back to the Change-Id check', async () => {
  const t = setup({ beads: [bead('sub-a1', { labels: ['branch:ada/x', 'pr:acme/other#7'] })], merged: [7], changeId: ['ada/x'] });
  try {
    t.bind({ bead: 'sub-a1' });
    assert.deepEqual(await t.stop(), { systemMessage: 'Closed bead sub-a1: its branch merged.' });
  } finally {
    t.done();
  }
});

test('stop: a failing close on merge throws and keeps the binding', async () => {
  const t = setup({ beads: [bead('sub-a1', { labels: ['branch:ada/x', 'pr:acme/svc#7'] })], merged: [7], failClose: true });
  try {
    t.bind({ bead: 'sub-a1' });
    await assert.rejects(t.stop(), /bd is down/);
    assert.deepEqual(t.binding(), { bead: 'sub-a1' });
  } finally {
    t.done();
  }
});

test('stop: in the desktop app a stale title is asked for once', async () => {
  const t = setup({ beads: [bead('sub-a1')], entrypoint: 'claude-desktop' });
  try {
    t.bind({ bead: 'sub-a1' });
    const ask = 'Set this chat\'s title in the app: call mcp__ccd_session_mgmt__set_session_title with session_id "self" and title "WIP: sub-a1 title sub-a1".';
    assert.deepEqual(await t.stop(), { block: ask });
    assert.deepEqual(await t.stop(), {});
    t.bind({ bead: 'sub-a1', appTitle: 'WIP: sub-a1 title sub-a1' });
    assert.deepEqual(await t.stop(), {});
  } finally {
    t.done();
  }
});

test('stop: outside the desktop app the title is never asked for', async () => {
  const t = setup({ beads: [bead('sub-a1')] });
  try {
    t.bind({ bead: 'sub-a1' });
    assert.deepEqual(await t.stop(), {});
  } finally {
    t.done();
  }
});

test('stop: the first stop in review asks the learn question once and never blocks after', async () => {
  const t = setup({ beads: [bead('sub-a1', { notes: APPROVED, acceptance_criteria: VERIFIED, labels: ['branch:ada/x', 'pr:acme/svc#7'] })] });
  try {
    t.bind({ bead: 'sub-a1', dirty: true });
    assert.deepEqual(await t.stop(), {
      block:
        'Bead sub-a1 is in review. Ask the engineer once: "What did you correct?" For each answer propose a CLAUDE.md rule, a test or a skill change, and apply only what they accept. Do not wait on this to finish.',
    });
    assert.equal(t.binding().learnAsked, true);
    assert.deepEqual(await t.stop(), {});
    assert.deepEqual(t.calls.filter((c) => c.startsWith('close')), []);
  } finally {
    t.done();
  }
});

test('stop: a verified bead with no branch or PR closes and releases', async () => {
  const t = setup({ beads: [bead('sub-a1', { notes: APPROVED, acceptance_criteria: VERIFIED })] });
  try {
    t.bind({ bead: 'sub-a1', epic: 'sub-e1' });
    assert.deepEqual(await t.stop(), { systemMessage: 'Closed bead sub-a1: every acceptance criterion is verified.' });
    assert.deepEqual(t.calls, ['snapshot', 'close sub-a1 All acceptance criteria verified @s1']);
    assert.deepEqual(t.binding(), { bead: 'sub-e1', epic: 'sub-e1' });
  } finally {
    t.done();
  }
});

const OPEN_PR =
  'Bead sub-a1: every criterion is verified. Open the PR with strand pr; if one is already open, run strand pr anyway: it adds the label. The bead closes when its PR merges.';

test('stop: a verified bead with a branch and no PR label stays open and says to run strand pr, once', async () => {
  const t = setup({ beads: [bead('sub-a1', { notes: APPROVED, acceptance_criteria: VERIFIED, labels: ['branch:ada/x'] })] });
  try {
    t.bind({ bead: 'sub-a1' });
    const msg = { systemMessage: OPEN_PR };
    assert.deepEqual(await t.stop(), msg);
    assert.deepEqual(await t.stop(), {});
    assert.deepEqual(t.calls.filter((c) => c.startsWith('close')), []);
    assert.equal(t.binding().bead, 'sub-a1');
  } finally {
    t.done();
  }
});

test('stop: a verified bead with a branch under an approved epic moves the session back to the epic', async () => {
  const t = setup({ beads: [bead('sub-a1', { notes: APPROVED, acceptance_criteria: VERIFIED, labels: ['branch:ada/x'] })] });
  try {
    t.bind({ bead: 'sub-a1', epic: 'sub-e1' });
    assert.deepEqual(await t.stop(), { systemMessage: OPEN_PR });
    assert.deepEqual(t.binding(), { bead: 'sub-e1', epic: 'sub-e1' });
  } finally {
    t.done();
  }
});

test('stop: ticks without evidence are asked about once per criteria text', async () => {
  const crit = '- [x] It works\n- [x] It fails safely (verified: make test passed)';
  const t = setup({ beads: [bead('sub-a1', { notes: APPROVED, acceptance_criteria: crit })] });
  try {
    t.bind({ bead: 'sub-a1', dirty: true });
    assert.deepEqual(await t.stop(), {
      block:
        "Every criterion of bead sub-a1 is ticked, but 1 have no '(verified: ...)' evidence. Run the check each one names, then add the evidence (bd update sub-a1 --acceptance '<full list>'), or untick it. If you cannot run a check, say which and why.",
    });
    assert.deepEqual(await t.stop(), {});
  } finally {
    t.done();
  }
});

test('stop: edits this turn ask Claude to check the criteria, once per dirty turn', async () => {
  const t = setup({ beads: [bead('sub-a1', { notes: APPROVED, acceptance_criteria: '- [ ] It works (check: make test)' })] });
  try {
    t.bind({ bead: 'sub-a1', dirty: true });
    const r = await t.stop();
    assert.equal(
      r.block,
      "Bead sub-a1 is in progress and files changed this turn. Check its acceptance criteria (bd show sub-a1). A criterion is met only when the check it names passes: run it, then tick the line with the evidence, as '- [x] <criterion> (verified: <command> passed)', using bd update sub-a1 --acceptance '<full list>'. If no command can check a criterion, ask the user and write '(verified: user confirmed)'. If the bead has no criteria, ask the user whether it is done. Otherwise say which criteria remain.",
    );
    assert.equal(t.binding().dirty, undefined);
    assert.deepEqual(await t.stop(), {});
  } finally {
    t.done();
  }
});

// --- needs you --------------------------------------------------------------------------------

const waitingSince = (trackerDir: string, beadId = 'sub-a1') => sessionsFor(trackerDir, beadId)[0]?.needsYou;

test('stop: a blocked stop does not mark the session as waiting; the stop that is let through does', async () => {
  const t = setup({ beads: [bead('sub-a1', { notes: APPROVED, acceptance_criteria: '- [ ] It works (check: make test)' })] });
  try {
    recordStart(t.deps.trackerDir, { sessionId: 's1', beadId: 'sub-a1' });
    t.bind({ bead: 'sub-a1', dirty: true });
    assert.ok((await t.stop()).block);
    assert.equal(waitingSince(t.deps.trackerDir), undefined);
    assert.deepEqual(await t.stop({ stop_hook_active: true }), {});
    assert.match(waitingSince(t.deps.trackerDir) ?? '', /^\d{4}-/);
  } finally {
    t.done();
  }
});

test('stop: the learn question and the evidence question do not mark; a system message does', async () => {
  const review = setup({ beads: [bead('sub-a1', { notes: APPROVED, acceptance_criteria: VERIFIED, labels: ['branch:ada/x', 'pr:acme/svc#7'] })] });
  try {
    recordStart(review.deps.trackerDir, { sessionId: 's1', beadId: 'sub-a1' });
    review.bind({ bead: 'sub-a1' });
    assert.ok((await review.stop()).block);
    assert.equal(waitingSince(review.deps.trackerDir), undefined);
  } finally {
    review.done();
  }
  const verified = setup({ beads: [bead('sub-a1', { notes: APPROVED, acceptance_criteria: VERIFIED, labels: ['branch:ada/x'] })] });
  try {
    recordStart(verified.deps.trackerDir, { sessionId: 's1', beadId: 'sub-a1' });
    verified.bind({ bead: 'sub-a1' });
    assert.ok((await verified.stop()).systemMessage);
    assert.ok(waitingSince(verified.deps.trackerDir));
  } finally {
    verified.done();
  }
});

test('stop: an indexed session with no bound bead is marked; one with no index entry gets none', async () => {
  const t = setup();
  try {
    t.bind({});
    assert.deepEqual(await t.stop(), {});
    assert.deepEqual(sessionsFor(t.deps.trackerDir, 'sub-a1'), []);
    recordStart(t.deps.trackerDir, { sessionId: 's1', beadId: 'sub-a1' });
    assert.deepEqual(await t.stop(), {});
    assert.ok(waitingSince(t.deps.trackerDir));
  } finally {
    t.done();
  }
});

test('stop: a failing bd read still marks, since the hook fails open and the turn ends', async () => {
  const t = setup({ failSnapshot: true });
  try {
    recordStart(t.deps.trackerDir, { sessionId: 's1', beadId: 'sub-a1' });
    t.bind({ bead: 'sub-a1' });
    await assert.rejects(t.stop(), /bd did not answer/);
    assert.ok(waitingSince(t.deps.trackerDir));
  } finally {
    t.done();
  }
});

test('stop: a tracker folder that cannot be read never fails the stop', async () => {
  const t = setup();
  try {
    let reads = 0;
    const deps: StopDeps = {
      ...t.deps,
      get trackerDir(): string {
        // The handler reads it first; the marking reads it last.
        if (++reads > 1) throw new Error('config gone');
        return t.deps.trackerDir;
      },
    };
    assert.deepEqual(await onStop({ session_id: 's1', cwd: 'C:\\dev\\svc' }, deps), {});
  } finally {
    t.done();
  }
});

test('stop: one bd read per run', async () => {
  const t = setup({ beads: [bead('sub-a1', { notes: APPROVED, acceptance_criteria: VERIFIED })] });
  try {
    t.bind({ bead: 'sub-a1' });
    await t.stop();
    assert.equal(t.calls.filter((c) => c === 'snapshot').length, 1);
  } finally {
    t.done();
  }
});
