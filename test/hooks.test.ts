import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseEnv } from './fixtures/env.ts';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBinding, writeBinding } from '../src/core/binding.ts';
import type { Binding } from '../src/core/binding.ts';
import type { ListedBead } from '../src/core/bd.ts';
import { beadForSession, markNeedsYou, recordStart, sessionsFor } from '../src/core/sessions.ts';
import { onNotification } from '../src/hooks/needs-you.ts';
import { describeBead, runHook, sameFolder } from '../src/hooks/common.ts';
import type { HookDeps } from '../src/hooks/common.ts';
import { onUserPromptSubmit } from '../src/hooks/prompt.ts';
import { onSessionEnd, onSessionStart } from '../src/hooks/session.ts';
import { onStop } from '../src/hooks/stop.ts';

// --- fixtures ---------------------------------------------------------------------------------

function bead(id: string, over: Partial<ListedBead> = {}): ListedBead {
  return { id, title: `title ${id}`, status: 'open', priority: 2, issue_type: 'task', labels: [], dependencies: [], ...over };
}

const APPROVED = 'plan-approved 2026-11-20T10:00:00.000Z';

type World = {
  beads?: ListedBead[];
  merged?: number[];
  changeId?: string[];
  heads?: { stack: number; name: string }[];
  entrypoint?: string;
  branchPrefix?: string;
  mode?: 'warn' | 'refuse';
  limits?: { build: number; review: number };
  now?: Date;
  failClose?: boolean;
  failArchive?: boolean;
  workspaceRoot?: string;
};

function setup(w: World = {}) {
  const trackerDir = mkdtempSync(join(tmpdir(), 'strand-hooks-'));
  const calls: string[] = [];
  const list = w.beads ?? [];
  const deps: HookDeps = {
    trackerDir,
    workspaceRoot: w.workspaceRoot ?? 'C:\\dev',
    branchPrefix: w.branchPrefix,
    wip: { ...(w.limits ?? { build: 3, review: 3 }), mode: w.mode ?? 'warn' },
    entrypoint: w.entrypoint,
    async snapshot() {
      calls.push('snapshot');
      return { beads: new Map(list.map((b) => [b.id, b])), ids: new Set(list.map((b) => b.id)), prefixes: ['sub'] };
    },
    beads: {
      async claim(id) {
        calls.push(`claim ${id}`);
      },
      async close(id, reason, session) {
        if (w.failClose) throw new Error('bd is down');
        calls.push(`close ${id} ${reason} @${session}`);
      },
      async comment(id, text) {
        calls.push(`comment ${id} ${text}`);
      },
    },
    async remoteRepo() {
      return 'acme/svc';
    },
    async mergedPrNumbers(_dir, numbers) {
      calls.push(`merged? ${numbers.join(',')}`);
      return numbers.filter((n) => (w.merged ?? []).includes(n));
    },
    async mergedByChangeId(_dir, name) {
      return (w.changeId ?? []).includes(name);
    },
    async stackHeads() {
      return w.heads ?? [];
    },
    startArchive() {
      if (w.failArchive) throw new Error('boom');
      calls.push('archive');
    },
    now: () => w.now ?? new Date('2026-11-23T12:00:00.000Z'),
  };
  const bind = (b: Binding, sid = 's1') => writeBinding(trackerDir, sid, b);
  const binding = (sid = 's1') => readBinding(trackerDir, sid);
  const done = () => rmSync(trackerDir, { recursive: true, force: true });
  return { deps, calls, trackerDir, bind, binding, done };
}

const SVC = String.raw`C:\dev\svc`;

/** The per-folder handover file, worked out here rather than taken from the code under test. */
function handoverFile(trackerDir: string, cwd: string): string {
  const key = createHash('sha256').update(cwd.toLowerCase().replace(/\\/g, '/')).digest('hex').slice(0, 12);
  return join(trackerDir, '.strand', 'bindings', `handover-${key}.json`);
}

// --- describeBead -----------------------------------------------------------------------------

test('describeBead: lines from one snapshot, with the branch, criteria and spec', async () => {
  const t = setup({
    beads: [
      bead('sub-a1', {
        title: 'Add login page',
        issue_type: 'feature',
        status: 'in_progress',
        labels: ['branch:ada/login'],
        acceptance_criteria: '- [ ] Logs in (check: make test)',
        design: 'GIVEN a user\nWHEN they log in',
      }),
    ],
  });
  try {
    const s = await t.deps.snapshot();
    const { context, stage } = await describeBead('sub-a1', s, t.deps, {});
    assert.equal(stage, 'specify');
    assert.equal(
      context,
      [
        'Strand bead sub-a1: Add login page',
        'Type: feature; stage: specify; spec format: gwt',
        'WIP: Build 0/3, Review 0/3',
        'Commit with: but commit --branch ada/login -m "..." <files>',
        `Tracker: ${t.trackerDir} (run bd there: bd -C "${t.trackerDir}" <args>)`,
        "Run tests only via the Test command in this repo's CLAUDE.md (ADR 0008).",
        '',
        'Acceptance criteria:',
        '- [ ] Logs in (check: make test)',
        '',
        'Spec:',
        'GIVEN a user\nWHEN they log in',
      ].join('\n'),
    );
  } finally {
    t.done();
  }
});

test('describeBead: a line naming the context folders, only when there are any', async () => {
  const t = setup({ beads: [bead('sub-a1', { labels: ['repo:svc', 'context:docs', 'context:lib'] }), bead('sub-b2', { labels: ['repo:svc'] })] });
  try {
    const s = await t.deps.snapshot();
    const lines = (await describeBead('sub-a1', s, t.deps, {})).context.split('\n');
    assert.equal(lines[lines.indexOf(lines.find((l) => l.startsWith('Tracker: '))!) + 1], 'Context folders: docs, lib');
    assert.ok(!(await describeBead('sub-b2', s, t.deps, {})).context.includes('Context folders'));
  } finally {
    t.done();
  }
});

test('describeBead: no branch yet names the prefix, or <username> when none is set', async () => {
  const t = setup({ beads: [bead('sub-a1')], branchPrefix: 'ada' });
  try {
    const s = await t.deps.snapshot();
    assert.ok((await describeBead('sub-a1', s, t.deps, {})).context.includes('Branch: none yet. Make one with but branch new ada/<topic>.'));
    t.deps.branchPrefix = undefined;
    assert.ok((await describeBead('sub-a1', s, t.deps, {})).context.includes('Branch: none yet. Make one with but branch new <username>/<topic>.'));
  } finally {
    t.done();
  }
});

test('describeBead: a build bead over a limit warns in warn mode and is blocked in refuse mode', async () => {
  const others = [bead('sub-r1', { notes: APPROVED, acceptance_criteria: '- [x] a (verified: ok)', labels: ['pr:acme/svc#1'] })];
  const building = bead('sub-a1', { status: 'in_progress', notes: APPROVED });
  const warn = setup({ beads: [building, ...others], limits: { build: 3, review: 1 } });
  const refuse = setup({ beads: [building, ...others], limits: { build: 3, review: 1 }, mode: 'refuse' });
  try {
    const w = (await describeBead('sub-a1', await warn.deps.snapshot(), warn.deps, {})).context;
    assert.ok(w.includes('WIP: Build 0/3, Review 1/1\nWIP warning: Review is at its WIP limit (1/1)'), w);
    const r = (await describeBead('sub-a1', await refuse.deps.snapshot(), refuse.deps, {})).context;
    assert.ok(r.includes('Build blocked: Review is at its WIP limit (1/1)'), r);
  } finally {
    warn.done();
    refuse.done();
  }
});

test('describeBead: WIP that cannot be worked out prints WIP: unknown', async () => {
  const broken = { ...bead('sub-x9'), labels: undefined } as unknown as ListedBead;
  const t = setup({ beads: [bead('sub-a1'), broken] });
  try {
    const c = (await describeBead('sub-a1', await t.deps.snapshot(), t.deps, {})).context;
    assert.ok(c.includes('\nWIP: unknown\n'), c);
  } finally {
    t.done();
  }
});

test('describeBead: STRAND_SPEC_FORMAT wins and a long spec is truncated', async () => {
  const t = setup({ beads: [bead('sub-a1', { design: 'x'.repeat(9000) })] });
  try {
    const c = (await describeBead('sub-a1', await t.deps.snapshot(), t.deps, { STRAND_SPEC_FORMAT: 'ears' })).context;
    assert.match(c, /spec format: ears/);
    assert.ok(c.length < 5000);
    assert.match(c, /\[spec truncated\]$/);
  } finally {
    t.done();
  }
});

test('describeBead: an unknown bead throws', async () => {
  const t = setup();
  try {
    await assert.rejects(describeBead('sub-zz', await t.deps.snapshot(), t.deps, {}), /bead sub-zz not found/);
  } finally {
    t.done();
  }
});

// --- UserPromptSubmit: on_prompt --------------------------------------------------------------

const prompt = (deps: HookDeps, text: string, cwd = 'C:\\dev\\svc') => onUserPromptSubmit({ session_id: 's1', prompt: text, cwd }, deps, {});

test('prompt: with no bead bound, explains how to bind one and reads no bead', async () => {
  const t = setup();
  try {
    assert.deepEqual(await prompt(t.deps, 'hello'), {
      additionalContext:
        "Bead workflow: no bead is bound to this session. Questions and read-only work need none. For new work, enter plan mode before the first file edit and put one line in the plan: 'Bead: <id>' for an existing bead (find it with bd search <words>, bd ready, bd list --status=in_progress), 'Bead: new' to file one with strand new once approved, or 'Bead: none'. Approving the plan claims the bead. For a large feature, name its epic and plan its child beads as the tasks. A one-line change may skip plan mode: confirm the bead with AskUserQuestion, then run 'bd update <id> --claim', or 'strand none' if the user says no bead is needed.",
    });
    assert.deepEqual(t.calls, []);
  } finally {
    t.done();
  }
});

test('prompt: Bead: none says nothing', async () => {
  const t = setup();
  try {
    t.bind({ none: true });
    assert.deepEqual(await prompt(t.deps, 'hello'), {});
  } finally {
    t.done();
  }
});

test('prompt: a bound bead gets the one-bead reminder and the chat title', async () => {
  const t = setup({ beads: [bead('sub-a1', { status: 'in_progress' })], branchPrefix: 'ada' });
  try {
    t.bind({ bead: 'sub-a1' });
    assert.deepEqual(await prompt(t.deps, 'go on'), {
      additionalContext:
        'Bead workflow: this session is bead sub-a1, and only that bead. Its branch is ada/<topic> with no bead id, made with but branch new, and every commit names it with but commit --branch <name>. Keep bead ids out of branch names, commit messages, PR titles and bodies. Unrelated work belongs in a new session. Stage: specify.',
      sessionTitle: 'WIP: sub-a1 title sub-a1',
    });
    assert.deepEqual(t.calls, ['snapshot']);
  } finally {
    t.done();
  }
});

test('prompt: an approved epic gets the walk-the-children reminder', async () => {
  const t = setup({ beads: [bead('sub-c1', { status: 'in_progress' })] });
  try {
    t.bind({ bead: 'sub-c1', epic: 'sub-e1' });
    assert.deepEqual(await prompt(t.deps, 'next'), {
      additionalContext:
        'Bead workflow: the user approved epic sub-e1 and this session is on sub-c1. Claim each ready child in turn (bd ready --parent sub-e1) without asking again. Each child gets its own branch, <username>/<topic> with no bead id, made with but branch new and committed to with but commit --branch <name>. Stage: specify.',
      sessionTitle: 'WIP: sub-c1 title sub-c1',
    });
  } finally {
    t.done();
  }
});

test('prompt: in the desktop app a stale title adds the set-title ask', async () => {
  const t = setup({ beads: [bead('sub-a1', { status: 'in_progress' })], entrypoint: 'claude-desktop' });
  try {
    t.bind({ bead: 'sub-a1' });
    const r = await prompt(t.deps, 'go');
    assert.ok(
      r.additionalContext!.endsWith(
        ' Set this chat\'s title in the app: call mcp__ccd_session_mgmt__set_session_title with session_id "self" and title "WIP: sub-a1 title sub-a1".',
      ),
      String(r.additionalContext),
    );
    t.bind({ bead: 'sub-a1', appTitle: 'WIP: sub-a1 title sub-a1' });
    assert.ok((await prompt(t.deps, 'go')).additionalContext!.endsWith('Unrelated work belongs in a new session. Stage: specify.'));
  } finally {
    t.done();
  }
});

test('prompt: a bound bead bd does not list keeps the reminder without a title', async () => {
  const t = setup();
  try {
    t.bind({ bead: 'sub-gone' });
    const r = await prompt(t.deps, 'go');
    assert.match(r.additionalContext!, /this session is bead sub-gone/);
    assert.equal(r.sessionTitle, undefined);
  } finally {
    t.done();
  }
});

// --- UserPromptSubmit: /strand:work -------------------------------------------------------------

test('/strand:work records the session, binds, claims, and does not approve the plan', async () => {
  const t = setup({ beads: [bead('sub-a1', { title: 'Add login', labels: ['branch:ada/login'] })] });
  try {
    const r = await prompt(t.deps, '  /strand:work sub-a1 please');
    assert.deepEqual(t.calls, ['snapshot', 'claim sub-a1', 'comment sub-a1 session s1 started']);
    assert.equal(beadForSession(t.trackerDir, 's1'), 'sub-a1');
    assert.deepEqual(t.binding(), { bead: 'sub-a1', lastStage: 'specify' });
    assert.match(r.additionalContext!, /^Strand bead sub-a1: Add login\nType: task; stage: specify;/);
    assert.equal(r.sessionTitle, 'WIP: sub-a1 Add login');
  } finally {
    t.done();
  }
});

test('/strand:work on an epic binds the epic too; /work also matches', async () => {
  const t = setup({ beads: [bead('sub-e1', { issue_type: 'epic' })] });
  try {
    await prompt(t.deps, '/work sub-e1');
    assert.deepEqual(t.binding(), { bead: 'sub-e1', epic: 'sub-e1', lastStage: 'specify' });
  } finally {
    t.done();
  }
});

test('the legacy /sdlc:work still binds, while the plugin is registered under its old name', async () => {
  const t = setup({ beads: [bead('sub-a1')] });
  try {
    await prompt(t.deps, '/sdlc:work sub-a1');
    assert.equal(t.binding().bead, 'sub-a1');
  } finally {
    t.done();
  }
});

test('/strand:work never claims a bead already in progress or closed, and does not re-record a known session', async () => {
  const t = setup({ beads: [bead('sub-a1', { status: 'in_progress' }), bead('sub-c1', { status: 'closed' })] });
  try {
    await prompt(t.deps, '/strand:work sub-a1');
    await prompt(t.deps, '/strand:work sub-a1');
    assert.deepEqual(t.calls.filter((c) => c !== 'snapshot'), ['comment sub-a1 session s1 started']);
    await prompt(t.deps, '/strand:work sub-c1');
    assert.ok(!t.calls.includes('claim sub-c1'));
  } finally {
    t.done();
  }
});

test('/strand:work with an unknown bead throws and records nothing', async () => {
  const t = setup();
  try {
    await assert.rejects(prompt(t.deps, '/strand:work sub-typo'), /bead sub-typo not found/);
    assert.equal(beadForSession(t.trackerDir, 's1'), undefined);
    assert.deepEqual(t.binding(), {});
  } finally {
    t.done();
  }
});

test('/strand:work warns when the session folder is not the bead repo folder', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'strand-hook-cwd-'));
  const t = setup({ beads: [bead('sub-a1', { labels: ['repo:orders'] })], workspaceRoot: ws });
  try {
    mkdirSync(join(ws, 'orders'));
    mkdirSync(join(ws, 'other'));
    const away = await prompt(t.deps, '/strand:work sub-a1', join(ws, 'other'));
    assert.ok(away.additionalContext!.startsWith(`Warning: this session's folder is ${join(ws, 'other')}, but bead sub-a1 belongs to ${join(ws, 'orders')}\n`));
    const home = await prompt(t.deps, '/strand:work sub-a1', join(ws, 'orders'));
    assert.ok(!home.additionalContext!.includes('Warning:'));
  } finally {
    t.done();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('/strand:work with no id in a bound session works the bound bead, context included', async () => {
  const t = setup({ beads: [bead('sub-a1', { title: 'Add login', status: 'in_progress' })] });
  try {
    t.bind({ bead: 'sub-a1', lastStage: 'specify' });
    for (const typed of ['/strand:work', '  /work  ']) {
      const r = await prompt(t.deps, typed);
      assert.match(r.additionalContext!, /^Strand bead sub-a1: Add login\n/, typed);
      assert.equal(r.sessionTitle, 'WIP: sub-a1 Add login');
    }
    assert.equal(beadForSession(t.trackerDir, 's1'), 'sub-a1');
    // Not a /work command: the plain reminder.
    assert.match((await prompt(t.deps, '/workflow')).additionalContext!, /^Bead workflow: this session is bead sub-a1/);
  } finally {
    t.done();
  }
});

test('/strand:work with no id and no bound bead tells Claude to ask for one, and writes nothing', async () => {
  const t = setup({ beads: [bead('sub-a1')] });
  try {
    const r = await prompt(t.deps, '/strand:work');
    assert.match(r.additionalContext!, /^Strand: \/strand:work was typed with no bead id/);
    assert.match(r.additionalContext!, /Ask the engineer which bead to work/);
    t.bind({ none: true });
    assert.match((await prompt(t.deps, '/work')).additionalContext!, /Ask the engineer which bead to work/);
    assert.deepEqual(t.calls, []);
    assert.equal(beadForSession(t.trackerDir, 's1'), undefined);
  } finally {
    t.done();
  }
});

test('/strand:work rejects an unsafe id without side effects', async () => {
  const t = setup();
  try {
    await assert.rejects(prompt(t.deps, '/strand:work ../x'), /invalid bead id/);
    assert.deepEqual(t.calls, []);
  } finally {
    t.done();
  }
});

test('sameFolder compares case-insensitively on win32 only', () => {
  assert.equal(sameFolder('C:\\Dev\\Orders', 'c:\\dev\\orders', 'win32'), true);
  assert.equal(sameFolder('/dev/Orders', '/dev/orders', 'linux'), false);
  assert.equal(sameFolder('/dev/orders/', '/dev/orders', 'linux'), true);
});

// --- SessionStart -----------------------------------------------------------------------------

const start = (deps: HookDeps, source = 'startup', env: NodeJS.ProcessEnv = {}, sid = 's1', cwd = 'C:\\dev\\svc') =>
  onSessionStart({ session_id: sid, source, cwd }, deps, env);

test('start: sweep closes a bead whose PR merged and leaves an unmerged one', async () => {
  const t = setup({
    beads: [
      bead('sub-m1', { status: 'in_progress', labels: ['branch:ada/a', 'pr:acme/svc#4'] }),
      bead('sub-u1', { status: 'in_progress', labels: ['branch:ada/b', 'pr:acme/svc#5'] }),
      bead('sub-o1', { status: 'in_progress', labels: ['pr:acme/other#4'] }),
      bead('sub-c1', { status: 'closed', labels: ['pr:acme/svc#4'] }),
    ],
    merged: [4],
  });
  try {
    const r = await start(t.deps);
    assert.deepEqual(r, { systemMessage: 'Closed bead sub-m1: acme/svc#4 merged.' });
    assert.deepEqual(t.calls, ['archive', 'snapshot', 'merged? 4,5', 'close sub-m1 Merged as acme/svc#4 @s1']);
  } finally {
    t.done();
  }
});

test('start: sweep closes a verify bead whose branch merged by Change-Id', async () => {
  const verified = { notes: APPROVED, acceptance_criteria: '- [x] a (verified: ok)', status: 'in_progress' };
  const t = setup({
    beads: [bead('sub-g1', { ...verified, labels: ['branch:ada/g'] }), bead('sub-g2', { ...verified, labels: ['branch:ada/h'] })],
    changeId: ['ada/g'],
  });
  try {
    const r = await start(t.deps);
    assert.deepEqual(r, { systemMessage: 'Closed bead sub-g1: branch ada/g merged.' });
    assert.ok(t.calls.includes('close sub-g1 Merged by Change-Id from ada/g @s1'));
    assert.ok(!t.calls.some((c) => c.startsWith('close sub-g2')));
  } finally {
    t.done();
  }
});

test('start: a failing close does not stop the title, drift report or context', async () => {
  const t = setup({
    beads: [bead('sub-a1', { status: 'in_progress', labels: ['pr:acme/svc#4'] })],
    merged: [4],
    failClose: true,
    heads: [{ stack: 1, name: 'ada/orphan' }],
  });
  try {
    t.bind({ bead: 'sub-a1' });
    const r = await start(t.deps);
    assert.equal(r.sessionTitle, 'WIP: sub-a1 title sub-a1');
    assert.match(r.systemMessage!, /^Branches and beads: 1 with drift\./);
    assert.match(r.additionalContext!, /^Strand bead sub-a1:/);
  } finally {
    t.done();
  }
});

test('start: bound session gets title and context from one bd read; no drift prints nothing', async () => {
  const t = setup({ beads: [bead('sub-a1', { status: 'in_progress', labels: ['branch:ada/a'] })], heads: [{ stack: 1, name: 'ada/a' }] });
  try {
    t.bind({ bead: 'sub-a1' });
    const r = await start(t.deps, 'resume');
    assert.equal(r.sessionTitle, 'WIP: sub-a1 title sub-a1');
    assert.match(r.additionalContext!, /^Strand bead sub-a1: title sub-a1\n/);
    assert.equal(r.systemMessage, undefined);
    assert.equal(t.calls.filter((c) => c === 'snapshot').length, 1);
    assert.equal(beadForSession(t.trackerDir, 's1'), 'sub-a1', 'recorded in the session index');
  } finally {
    t.done();
  }
});

test('start: STRAND_BEAD_ID from strand work binds the new session and records it', async () => {
  const t = setup({ beads: [bead('sub-a1', { status: 'in_progress' })] });
  try {
    const r = await start(t.deps, 'startup', { STRAND_BEAD_ID: 'sub-a1' });
    assert.deepEqual(t.binding(), { bead: 'sub-a1', lastStage: 'specify' });
    assert.equal(beadForSession(t.trackerDir, 's1'), 'sub-a1');
    assert.match(r.additionalContext!, /^Strand bead sub-a1/);
  } finally {
    t.done();
  }
});

test('start: survives a startArchive failure', async () => {
  const t = setup({ failArchive: true });
  try {
    assert.deepEqual(await start(t.deps), {});
  } finally {
    t.done();
  }
});

test('handover: /clear in the same folder within 60 s adopts the bead and deletes the handover', async () => {
  const t = setup({ beads: [bead('sub-a1', { status: 'in_progress' })], now: new Date('2026-11-23T12:00:30.000Z') });
  try {
    t.bind({ bead: 'sub-a1', epic: 'sub-e1' }, 'old');
    await onSessionEnd({ session_id: 'old', reason: 'clear', cwd: 'C:\\dev\\svc' }, { ...t.deps, now: () => new Date('2026-11-23T12:00:00.000Z') });
    const file = handoverFile(t.trackerDir, SVC);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { cwd: 'C:\\dev\\svc', bead: 'sub-a1', epic: 'sub-e1', at: '2026-11-23T12:00:00.000Z', from: 'old' });
    const r = await start(t.deps, 'clear', {}, 'new', 'C:\\dev\\svc');
    assert.deepEqual(t.binding('new'), { bead: 'sub-a1', epic: 'sub-e1', handoverFrom: 'old', lastStage: 'specify' });
    assert.equal(r.sessionTitle, 'WIP: sub-a1 title sub-a1');
    assert.ok(!existsSync(file));
    // The index links the new session to the one it replaces, so a cockpit terminal can end both.
    assert.equal(sessionsFor(t.trackerDir, 'sub-a1').find((e) => e.sessionId === 'new')?.replaces, 'old');
  } finally {
    t.done();
  }
});

test('handover: another folder, a late start or a non-clear start does not adopt it', async () => {
  const t = setup({ now: new Date('2026-11-23T12:00:30.000Z') });
  try {
    const file = handoverFile(t.trackerDir, SVC);
    mkdirSync(join(t.trackerDir, '.strand', 'bindings'), { recursive: true });
    const leave = (at: string) => writeFileSync(file, JSON.stringify({ cwd: 'C:\\dev\\svc', bead: 'sub-a1', at, from: 'old' }));
    leave('2026-11-23T12:00:00.000Z');
    await start(t.deps, 'clear', {}, 'n1', 'C:\\dev\\other');
    assert.deepEqual(t.binding('n1'), {});
    await start(t.deps, 'startup', {}, 'n2');
    assert.deepEqual(t.binding('n2'), {});
    assert.ok(existsSync(file), 'kept for the right session');
    leave('2026-11-23T11:59:00.000Z');
    await start(t.deps, 'clear', {}, 'n3');
    assert.deepEqual(t.binding('n3'), {});
    assert.ok(!existsSync(file), 'a stale handover is removed');
  } finally {
    t.done();
  }
});

test('handover: two /clears in different folders within 60 s each keep their own bead', async () => {
  const t = setup({ beads: [bead('sub-a1', { status: 'in_progress' }), bead('sub-b2', { status: 'in_progress' })] });
  try {
    const other = String.raw`C:\dev\other`;
    t.bind({ bead: 'sub-a1' }, 'oa');
    t.bind({ bead: 'sub-b2' }, 'ob');
    await onSessionEnd({ session_id: 'oa', reason: 'clear', cwd: SVC }, t.deps);
    await onSessionEnd({ session_id: 'ob', reason: 'clear', cwd: other }, t.deps);
    assert.ok(existsSync(handoverFile(t.trackerDir, SVC)));
    assert.ok(existsSync(handoverFile(t.trackerDir, other)));
    await start(t.deps, 'clear', {}, 'na', SVC);
    await start(t.deps, 'clear', {}, 'nb', other);
    assert.equal(t.binding('na').bead, 'sub-a1');
    assert.equal(t.binding('nb').bead, 'sub-b2');
  } finally {
    t.done();
  }
});

test('start: STRAND_BEAD_ID is not adopted for a closed bead or a session that has a binding', async () => {
  const t = setup({ beads: [bead('sub-c1', { status: 'closed' }), bead('sub-a1', { status: 'in_progress' })] });
  try {
    await start(t.deps, 'resume', { STRAND_BEAD_ID: 'sub-c1' });
    assert.deepEqual(t.binding(), {});
    assert.equal(beadForSession(t.trackerDir, 's1'), undefined);
    t.bind({ none: true }, 's2');
    await start(t.deps, 'compact', { STRAND_BEAD_ID: 'sub-a1' }, 's2');
    assert.deepEqual(t.binding('s2'), { none: true });
  } finally {
    t.done();
  }
});

test('start: sweep closes a build-stage bead whose branch merged by Change-Id', async () => {
  const t = setup({ beads: [bead('sub-b1', { status: 'in_progress', notes: APPROVED, labels: ['branch:ada/b'] })], changeId: ['ada/b'] });
  try {
    const r = await start(t.deps);
    assert.deepEqual(r, { systemMessage: 'Closed bead sub-b1: branch ada/b merged.' });
    assert.ok(t.calls.includes('close sub-b1 Merged by Change-Id from ada/b @s1'));
  } finally {
    t.done();
  }
});

test('session start between an approval and the next prompt still says the spec is approved, once', async () => {
  const b = bead('sub-a1', { status: 'in_progress' });
  const t = setup({ beads: [b] });
  try {
    t.bind({ bead: 'sub-a1', lastStage: 'specify' });
    b.notes = APPROVED; // the engineer approved the spec in the cockpit
    const r = await onSessionStart({ session_id: 's1', source: 'resume', cwd: 'C:\\dev\\svc' }, t.deps, {}, { budgetMs: 50 });
    const line = 'Stage changed: specify -> build. The spec is approved. Start Build.';
    assert.ok(r.additionalContext!.endsWith(`\n${line}`), String(r.additionalContext));
    assert.equal(t.binding().lastStage, 'build');
    const next = (await prompt(t.deps, 'go')).additionalContext!;
    assert.ok(!next.includes('Stage changed'), next);
    // A start with no change of stage says nothing more.
    const again = await onSessionStart({ session_id: 's1', source: 'resume', cwd: 'C:\\dev\\svc' }, t.deps, {}, { budgetMs: 50 });
    assert.ok(!again.additionalContext!.includes('Stage changed'), String(again.additionalContext));
  } finally {
    t.done();
  }
});

test('prompt: a stage change is said once, and approval is cached on the binding', async () => {
  const b = bead('sub-a1', { status: 'in_progress' });
  const t = setup({ beads: [b] });
  try {
    t.bind({ bead: 'sub-a1' });
    const first = await prompt(t.deps, 'go');
    assert.ok(first.additionalContext!.endsWith(' Stage: specify.'), String(first.additionalContext));
    assert.equal(t.binding().lastStage, 'specify');
    b.notes = APPROVED; // the engineer approved the spec in the cockpit
    const second = (await prompt(t.deps, 'go')).additionalContext!;
    assert.ok(second.endsWith(' Stage: build.\nStage changed: specify -> build. The spec is approved. Start Build.'), second);
    assert.equal(t.binding().lastStage, 'build');
    assert.equal(t.binding().approved, true);
    const third = (await prompt(t.deps, 'go')).additionalContext!;
    assert.ok(third.endsWith(' Stage: build.'), third);
  } finally {
    t.done();
  }
});

test('prompt: a cockpit spec edit is said once, then the field is cleared', async () => {
  const t = setup({ beads: [bead('sub-a1', { status: 'in_progress' })] });
  try {
    t.bind({ bead: 'sub-a1', lastStage: 'specify', specEditedAt: '2026-11-23T10:00:00.000Z' });
    const line = `The engineer edited the spec of sub-a1 in the cockpit. Re-read it before you continue: bd -C "${t.trackerDir}" show sub-a1.`;
    const first = (await prompt(t.deps, 'go')).additionalContext!;
    assert.ok(first.endsWith(`\n${line}`), first);
    assert.equal(t.binding().specEditedAt, undefined);
    assert.equal(t.binding().lastStage, 'specify');
    const second = (await prompt(t.deps, 'go')).additionalContext!;
    assert.ok(!second.includes('edited the spec'), second);
  } finally {
    t.done();
  }
});

test('prompt: the spec-edited line also goes out when the binding has no lastStage yet', async () => {
  const t = setup({ beads: [bead('sub-a1', { status: 'in_progress' })] });
  try {
    t.bind({ bead: 'sub-a1', specEditedAt: '2026-11-23T10:00:00.000Z' });
    const line = `The engineer edited the spec of sub-a1 in the cockpit. Re-read it before you continue: bd -C "${t.trackerDir}" show sub-a1.`;
    const first = (await prompt(t.deps, 'go')).additionalContext!;
    assert.ok(first.endsWith(`Stage: specify.\n${line}`), first);
    assert.equal(t.binding().specEditedAt, undefined);
    assert.equal(t.binding().lastStage, 'specify');
  } finally {
    t.done();
  }
});

test('/strand:work, then a cockpit approval: the next prompt says the stage changed', async () => {
  const b = bead('sub-a1');
  const t = setup({ beads: [b] });
  try {
    await prompt(t.deps, '/strand:work sub-a1');
    assert.equal(t.binding().lastStage, 'specify');
    b.status = 'in_progress'; // the claim landed
    b.notes = APPROVED; // the engineer approved the spec in the cockpit
    const next = (await prompt(t.deps, 'go on')).additionalContext!;
    assert.ok(next.endsWith('Stage changed: specify -> build. The spec is approved. Start Build.'), next);
  } finally {
    t.done();
  }
});

test('start: title and context are set before the sweep, and a slow sweep stops at its budget', async () => {
  const t = setup({ beads: [bead('sub-a1', { status: 'in_progress', labels: ['branch:ada/a', 'pr:acme/svc#4'] })] });
  try {
    t.bind({ bead: 'sub-a1' });
    t.deps.mergedPrNumbers = () => new Promise((resolve) => setTimeout(() => resolve([]), 3000).unref());
    const began = Date.now();
    const r = await onSessionStart({ session_id: 's1', source: 'resume', cwd: 'C:\\dev\\svc' }, t.deps, {}, { budgetMs: 50 });
    assert.ok(Date.now() - began < 1500, `took ${Date.now() - began} ms`);
    assert.equal(r.sessionTitle, 'WIP: sub-a1 title sub-a1');
    assert.match(r.additionalContext!, /^Strand bead sub-a1:/);
    assert.equal(t.binding().lastStage, 'specify');
  } finally {
    t.done();
  }
});

test('start: sweep checks only beads whose repo label is the session folder, or that have none', async () => {
  const t = setup({
    beads: [
      bead('sub-h1', { status: 'in_progress', labels: ['branch:ada/a', 'pr:acme/svc#4', 'repo:svc'] }),
      bead('sub-n1', { status: 'in_progress', labels: ['branch:ada/b', 'pr:acme/svc#5'] }),
      bead('sub-o1', { status: 'in_progress', labels: ['branch:ada/c', 'pr:acme/svc#6', 'repo:other'] }),
    ],
    merged: [4, 5, 6],
  });
  try {
    await start(t.deps, 'startup', {}, 's1', 'C:\\dev\\svc');
    const closes = t.calls.filter((c) => c.startsWith('close'));
    assert.deepEqual(closes, ['close sub-h1 Merged as acme/svc#4 @s1', 'close sub-n1 Merged as acme/svc#5 @s1']);
  } finally {
    t.done();
  }
});

test('start: sweep sees a PR label without a branch label', async () => {
  const t = setup({ beads: [bead('sub-p1', { status: 'in_progress', labels: ['pr:acme/svc#4'] })], merged: [4] });
  try {
    const r = await start(t.deps);
    assert.deepEqual(r, { systemMessage: 'Closed bead sub-p1: acme/svc#4 merged.' });
  } finally {
    t.done();
  }
});

test('/strand:work on a child of the approved epic keeps the epic; another bead clears it', async () => {
  const t = setup({
    beads: [
      bead('sub-e1', { issue_type: 'epic' }),
      bead('sub-c1', { parent: 'sub-e1' }),
      bead('sub-c2', { dependencies: [{ issue_id: 'sub-c2', depends_on_id: 'sub-e1', type: 'parent-child' }] }),
      bead('sub-x1'),
    ],
  });
  try {
    t.bind({ bead: 'sub-e1', epic: 'sub-e1' });
    await prompt(t.deps, '/strand:work sub-c1');
    assert.equal(t.binding().epic, 'sub-e1');
    await prompt(t.deps, '/strand:work sub-c2');
    assert.equal(t.binding().epic, 'sub-e1');
    await prompt(t.deps, '/strand:work sub-x1');
    assert.equal(t.binding().epic, undefined);
  } finally {
    t.done();
  }
});

// --- budgets (RFC 0003 section 7) -------------------------------------------------------------

function fiveHundred(): ListedBead[] {
  const out: ListedBead[] = [];
  for (let i = 0; i < 500; i++) {
    const n = String(i).padStart(3, '0');
    out.push(
      bead(`sub-b${n}`, {
        status: i % 3 === 0 ? 'closed' : i % 3 === 1 ? 'in_progress' : 'open',
        notes: i % 2 ? APPROVED : undefined,
        acceptance_criteria: `- [${i % 4 ? 'x' : ' '}] criterion ${n} (check: make test)${i % 4 ? ' (verified: ok)' : ''}`,
        labels: i % 5 === 0 ? [`branch:ada/b${n}`, `pr:acme/svc#${i}`] : i % 7 === 0 ? [`branch:ada/b${n}`] : [],
        design: 'x'.repeat(200),
      }),
    );
  }
  return out;
}

test('budget: prompt, start and stop each finish under 2 s with 500 beads and one bd read', async () => {
  const t = setup({ beads: fiveHundred(), merged: [5, 10, 15] });
  try {
    const timed = async (fn: () => Promise<unknown>) => {
      const before = t.calls.filter((c) => c === 'snapshot').length;
      const t0 = performance.now();
      await fn();
      const ms = performance.now() - t0;
      assert.equal(t.calls.filter((c) => c === 'snapshot').length - before, 1);
      return ms;
    };
    t.bind({ bead: 'sub-b001', dirty: true });
    assert.ok((await timed(() => prompt(t.deps, 'go'))) < 2000);
    assert.ok((await timed(() => start(t.deps, 'resume'))) < 2000);
    assert.ok((await timed(() => onStop({ session_id: 's1', cwd: SVC }, t.deps))) < 2000);
  } finally {
    t.done();
  }
});

// --- SessionEnd -------------------------------------------------------------------------------

// --- needs you --------------------------------------------------------------------------------

test('prompt: any prompt clears the waiting mark', async () => {
  const t = setup({ beads: [bead('sub-a1', { status: 'in_progress' })] });
  try {
    const waiting = () => sessionsFor(t.trackerDir, 'sub-a1')[0]?.needsYou;
    recordStart(t.trackerDir, { sessionId: 's1', beadId: 'sub-a1' });
    t.bind({ bead: 'sub-a1' });
    markNeedsYou(t.trackerDir, 's1');
    await prompt(t.deps, 'go on');
    assert.equal(waiting(), undefined);
    // Bound to no bead any more, still indexed: the mark goes all the same.
    t.bind({});
    markNeedsYou(t.trackerDir, 's1');
    await prompt(t.deps, 'hello');
    assert.equal(waiting(), undefined);
    markNeedsYou(t.trackerDir, 's1');
    await prompt(t.deps, '/strand:work sub-a1');
    assert.equal(waiting(), undefined);
  } finally {
    t.done();
  }
});

test('notification: a permission or idle notice marks the session as waiting; a sign-in notice does not', async () => {
  const t = setup();
  try {
    const waiting = () => sessionsFor(t.trackerDir, 'sub-a1')[0]?.needsYou;
    // No index entry: nothing is written.
    await onNotification({ session_id: 's1', notification_type: 'permission_prompt' }, t.deps);
    assert.deepEqual(sessionsFor(t.trackerDir, 'sub-a1'), []);
    recordStart(t.trackerDir, { sessionId: 's1', beadId: 'sub-a1' });
    for (const type of ['auth_success', 'agent_completed', 'elicitation_response', 'quota_auto_resume_fired', 'plugin_notification']) {
      await onNotification({ session_id: 's1', notification_type: type }, t.deps);
      assert.equal(waiting(), undefined, type);
    }
    await onNotification({ session_id: 's1', notification_type: 'permission_prompt' }, t.deps);
    const since = waiting();
    assert.match(since ?? '', /^\d{4}-/);
    await onNotification({ session_id: 's1', notification_type: 'idle_prompt' }, t.deps);
    await onNotification({ session_id: 's1' }, t.deps);
    assert.equal(waiting(), since);
  } finally {
    t.done();
  }
});

test('notification: a bad session id or an unreadable tracker folder never throws', async () => {
  const t = setup();
  try {
    await onNotification({ session_id: '../x', notification_type: 'permission_prompt' }, t.deps);
    await onNotification({} as { session_id: string }, t.deps);
    const broken = {
      get trackerDir(): string {
        throw new Error('config gone');
      },
    };
    await onNotification({ session_id: 's1' }, broken);
  } finally {
    t.done();
  }
});

test('real process: notification marks an indexed session, prints nothing and makes no bd call', () => {
  const ws = mkdtempSync(join(tmpdir(), 'strand-hook-ws-'));
  try {
    recordStart(join(ws, 'tracker'), { sessionId: 's1', beadId: 'bd-1' });
    const r = spawnSync(process.execPath, [join(HOOKS, 'notification.ts')], {
      input: JSON.stringify({ session_id: 's1', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }),
      encoding: 'utf8',
      env: hookEnv({ PATH: '', Path: '', STRAND_WORKSPACE: ws }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.ok(sessionsFor(join(ws, 'tracker'), 'bd-1')[0]?.needsYou);
    const bad = spawnSync(process.execPath, [join(HOOKS, 'notification.ts')], { input: 'garbage', encoding: 'utf8', env: hookEnv() });
    assert.equal(bad.status, 0);
    assert.match(bad.stderr, /strand hook Notification/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('end: records the end and comments; ignores an unknown session', async () => {
  const t = setup();
  try {
    recordStart(t.trackerDir, { sessionId: 's1', beadId: 'sub-a1' });
    await onSessionEnd({ session_id: 's1', transcript_path: '/tx.jsonl', reason: 'other', cwd: '' }, t.deps);
    const entry = JSON.parse(readFileSync(join(t.trackerDir, '.strand', 'sessions', 's1.json'), 'utf8'));
    assert.ok(entry.endedAt);
    assert.equal(entry.transcriptPath, '/tx.jsonl');
    assert.deepEqual(t.calls, ['comment sub-a1 session s1 ended (other)']);
    await onSessionEnd({ session_id: 'ghost', reason: 'other', cwd: '' }, t.deps);
    assert.equal(t.calls.length, 1);
    assert.ok(!existsSync(handoverFile(t.trackerDir, SVC)));
  } finally {
    t.done();
  }
});

test('end: a session bound by a plan but not yet indexed is indexed so its transcript is archived', async () => {
  const t = setup();
  try {
    t.bind({ bead: 'sub-a1' });
    await onSessionEnd({ session_id: 's1', transcript_path: '/tx.jsonl', reason: 'other', cwd: '' }, t.deps);
    const entry = JSON.parse(readFileSync(join(t.trackerDir, '.strand', 'sessions', 's1.json'), 'utf8'));
    assert.equal(entry.beadId, 'sub-a1');
    assert.ok(entry.endedAt);
  } finally {
    t.done();
  }
});

test('end: /clear on an unbound or Bead: none session leaves no handover', async () => {
  const t = setup();
  try {
    t.bind({ none: true });
    await onSessionEnd({ session_id: 's1', reason: 'clear', cwd: 'C:\\dev\\svc' }, t.deps);
    assert.ok(!existsSync(handoverFile(t.trackerDir, SVC)));
  } finally {
    t.done();
  }
});

// --- runHook ----------------------------------------------------------------------------------

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

test('runHook prints hookSpecificOutput only when there is something to say', async () => {
  const a = io('{"x":1}');
  await runHook(async () => ({ additionalContext: 'hi', sessionTitle: 'WIP: x' }), 'SessionStart', a.io);
  assert.deepEqual(JSON.parse(a.o.out), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hi', sessionTitle: 'WIP: x' } });
  assert.equal(a.o.code, 0);
  const b = io('{}');
  await runHook(async () => ({}), 'UserPromptSubmit', b.io);
  assert.equal(b.o.out, '');
  const c = io('{}');
  await runHook(async () => ({ block: 'check it' }), 'Stop', c.io);
  assert.deepEqual(JSON.parse(c.o.out), { decision: 'block', reason: 'check it' });
});

test('runHook logs and exits 0 on invalid JSON, a throwing handler or a timeout', async () => {
  const a = io('not json');
  await runHook(async () => ({}), 'SessionEnd', a.io);
  assert.match(a.o.err, /^strand hook SessionEnd: /);
  assert.equal(a.o.code, 0);
  const b = io('{}');
  await runHook(async () => {
    throw new Error('kaput');
  }, 'SessionStart', b.io);
  assert.match(b.o.err, /strand hook SessionStart: kaput/);
  assert.equal(b.o.code, 0);
  const c = io('{}');
  await runHook(() => new Promise(() => {}), 'SessionEnd', c.io, { deadlineMs: 20 });
  assert.match(c.o.err, /strand hook SessionEnd: timed out after 20 ms/);
  assert.equal(c.o.code, 0);
});

// --- real process -----------------------------------------------------------------------------

const HOOKS = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'hooks');

/** Env for a real hook process: every config location points into a temp dir, never the real config. */
function hookEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), 'strand-hook-home-'));
  const env: NodeJS.ProcessEnv = {
    ...baseEnv(),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData'),
    XDG_CONFIG_HOME: join(home, 'cfg'),
    STRAND_WORKSPACE: join(home, 'ws'),
    STRAND_GITEA_URL: '',
    ...extra,
  };
  delete env.BEADS_DIR;
  delete env.BEADS_ACTOR;
  return env;
}

test('real process: session-end with invalid stdin exits 0', () => {
  const r = spawnSync(process.execPath, [join(HOOKS, 'session-end.ts')], { input: 'garbage', encoding: 'utf8', env: hookEnv() });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /strand hook SessionEnd/);
});

test('real process: session-end with bd missing from PATH exits 0 with a stderr message', () => {
  const ws = mkdtempSync(join(tmpdir(), 'strand-hook-ws-'));
  try {
    recordStart(join(ws, 'tracker'), { sessionId: 's1', beadId: 'bd-1' });
    const r = spawnSync(process.execPath, [join(HOOKS, 'session-end.ts')], {
      input: JSON.stringify({ session_id: 's1', reason: 'other', cwd: '/', hook_event_name: 'SessionEnd' }),
      encoding: 'utf8',
      env: hookEnv({ PATH: '', Path: '', STRAND_WORKSPACE: ws }),
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /strand hook SessionEnd: /);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('real process: user-prompt-submit with no binding prints the reminder without calling bd', () => {
  const ws = mkdtempSync(join(tmpdir(), 'strand-hook-ws-'));
  try {
    const r = spawnSync(process.execPath, [join(HOOKS, 'user-prompt-submit.ts')], {
      input: JSON.stringify({ session_id: 's1', prompt: 'hi', cwd: ws }),
      encoding: 'utf8',
      env: hookEnv({ PATH: '', Path: '', STRAND_WORKSPACE: ws }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /^Bead workflow: no bead is bound/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('real process: stop with no binding exits 0 and prints nothing', () => {
  const ws = mkdtempSync(join(tmpdir(), 'strand-hook-ws-'));
  try {
    const r = spawnSync(process.execPath, [join(HOOKS, 'stop-entry.ts')], {
      input: JSON.stringify({ session_id: 's1', cwd: ws }),
      encoding: 'utf8',
      env: hookEnv({ PATH: '', Path: '', STRAND_WORKSPACE: ws }),
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('real process: session-start with bd missing from PATH exits 0', () => {
  const ws = mkdtempSync(join(tmpdir(), 'strand-hook-ws-'));
  try {
    const r = spawnSync(process.execPath, [join(HOOKS, 'session-start.ts')], {
      input: JSON.stringify({ session_id: 's1', source: 'startup', cwd: ws }),
      encoding: 'utf8',
      env: hookEnv({ PATH: '', Path: '', STRAND_WORKSPACE: ws }),
    });
    assert.equal(r.status, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('real process budget: user-prompt-submit and stop with no binding, median under 2 s', () => {
  const ws = mkdtempSync(join(tmpdir(), 'strand-hook-ws-'));
  try {
    const env = hookEnv({ PATH: '', Path: '', STRAND_WORKSPACE: ws });
    for (const [file, input] of [
      ['user-prompt-submit.ts', { session_id: 's1', prompt: 'hi', cwd: ws }],
      ['stop-entry.ts', { session_id: 's1', cwd: ws }],
    ] as const) {
      const once = () => {
        const t0 = performance.now();
        const r = spawnSync(process.execPath, [join(HOOKS, file)], { input: JSON.stringify(input), encoding: 'utf8', env });
        assert.equal(r.status, 0, r.stderr);
        return performance.now() - t0;
      };
      once(); // warm-up
      const runs = [once(), once(), once()].sort((a, b) => a - b);
      assert.ok(runs[1]! < 2000, `${file}: median ${Math.round(runs[1]!)} ms`);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
