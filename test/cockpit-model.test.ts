import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { baseEnv, runWith } from './fixtures/env.ts';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/core/exec.ts';
import { Beads } from '../src/core/bd.ts';
import { buildCtx, type Ctx } from '../src/cli/ctx.ts';
import { recordEnd, recordStart, writeEntry } from '../src/core/sessions.ts';
import { criteriaHash } from '../src/core/criteria-hash.ts';
import { beadVersion } from '../src/core/edit-bead.ts';
import { Model } from '../src/cockpit/model.ts';
import type { ListedBead } from '../src/core/bd.ts';
import type { Gitea } from '../src/cli/ctx.ts';
import type { Forge } from '../src/core/forge.ts';

const hasBd = await run('bd', ['--version']).then((r) => r.code === 0, () => false);
const skip = hasBd ? false : 'bd not on PATH';
const bdEnv = { ...baseEnv(), BD_NON_INTERACTIVE: '1' };

let ws = '';
let tracker = '';
let env: NodeJS.ProcessEnv = {};
let server: Server;
let giteaUrl = '';
let giteaHits = 0;
let failNextGitea = false;
const ids: Record<string, string> = {};
const STREAM_BRANCH = 'ada/stream-orders';
const OLD_BRANCH = 'ada/old-orders';
const STORY = 'As a user, I want orders streamed, so that I see them at once';
const VERIFIED = '- [x] Orders arrive in order (check: node --test) (verified: node --test passed)';
const UNVERIFIED = '- [ ] Orders arrive in order (check: node --test)';
const approved = (id: string) => new Beads(tracker).note(id, 'plan-approved 2026-11-01T10:00:00.000Z');

/** Counts every bd call the model makes through Beads. */
class CountingBeads extends Beads {
  calls: Record<string, number> = {};
  /** When set, listAll waits for it (to hold a refresh in flight). */
  hold?: Promise<void>;
  private bump(k: string) {
    this.calls[k] = (this.calls[k] ?? 0) + 1;
  }
  override async list() {
    this.bump('list');
    return super.list();
  }
  override async listAll() {
    this.bump('listAll');
    if (this.hold) await this.hold;
    return super.listAll();
  }
  override async show(id: string) {
    this.bump('show');
    return super.show(id);
  }
  override async ready() {
    this.bump('ready');
    return super.ready();
  }
  total(): number {
    return Object.values(this.calls).reduce((a, b) => a + b, 0);
  }
}

async function bd(args: string[]): Promise<string> {
  const r = await runWith('bd', args, { cwd: tracker, env: bdEnv });
  assert.equal(r.code, 0, `bd ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function ctxWith(extra: NodeJS.ProcessEnv = {}): Ctx & { beads: CountingBeads } {
  const ctx = buildCtx({ ...env, ...extra }, { out: () => {}, err: () => {} });
  const beads = new CountingBeads(ctx.config.trackerDir);
  return { ...ctx, beads };
}

before(async () => {
  if (!hasBd) return;
  ws = mkdtempSync(join(tmpdir(), 'strand-model-'));
  tracker = join(ws, 'tracker');
  const repoDir = join(ws, 'orders-service');
  const cfg = join(ws, 'config');
  for (const d of [tracker, repoDir, cfg]) mkdirSync(d);
  for (const d of [tracker, repoDir]) await run('git', ['init', '-q'], { cwd: d });
  const init = await runWith('bd', ['init', '--prefix', 't'], { cwd: tracker, env: bdEnv });
  assert.equal(init.code, 0, init.stderr);

  server = createServer((req, res) => {
    giteaHits++;
    if (failNextGitea) {
      failNextGitea = false;
      req.socket.destroy();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.includes('/actions/runs')) {
      return res.end(JSON.stringify({ workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success', workflow_id: 1 }] }));
    }
    if (req.url?.includes('/pulls')) {
      return res.end(
        JSON.stringify([
          { number: 7, state: 'open', merged: false, html_url: 'http://x/pr/7', head: { ref: STREAM_BRANCH, sha: 'abc' } },
          { number: 9, state: 'closed', merged: false, html_url: 'http://x/pr/9', head: { ref: OLD_BRANCH, sha: 'def' } },
        ]),
      );
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  giteaUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  await run('git', ['remote', 'add', 'origin', `${giteaUrl}/acme/orders-service.git`], { cwd: repoDir });

  env = { ...baseEnv(), STRAND_WORKSPACE: ws, XDG_CONFIG_HOME: cfg, APPDATA: cfg, HOME: cfg, USERPROFILE: cfg };
  delete env.STRAND_GITEA_URL;
  delete env.STRAND_GITEA_TOKEN;

  const beads = new Beads(tracker);
  const mk = async (key: string, i: Parameters<Beads['create']>[0]) => (ids[key] = (await beads.create(i)).id);
  await mk('E', { title: 'Orders epic', type: 'epic', priority: 1 });
  // E1: verified, has a PR (7) the forge reports as open with green CI.
  await mk('E1', {
    title: 'Stream orders',
    type: 'feature',
    priority: 1,
    parent: ids.E,
    description: STORY,
    acceptance: VERIFIED,
    labels: ['repo:orders-service', `branch:${STREAM_BRANCH}`, 'pr:acme/orders-service#7'],
  });
  // E4: verified, a PR (9) the forge reports as closed without a merge.
  await mk('E4', {
    title: 'Retire old orders',
    type: 'task',
    priority: 2,
    parent: ids.E,
    acceptance: VERIFIED,
    labels: ['repo:orders-service', `branch:${OLD_BRANCH}`, 'pr:acme/orders-service#9'],
  });
  await mk('E2', { title: 'Paginate orders', type: 'task', priority: 2, parent: ids.E, acceptance: UNVERIFIED });
  // E5: claimed, criteria written, not approved: the spec waits for you.
  await mk('E5', { title: 'Filter orders', type: 'task', priority: 2, parent: ids.E, description: STORY, acceptance: UNVERIFIED });
  // E8: claimed, free-text criteria, no parent: in Specify but not ready for approval.
  await mk('E8', { title: 'Loose spec', type: 'task', priority: 3, description: STORY, acceptance: 'orders feel fast', labels: ['repo:orders-service', 'context:docs', 'context:lib'] });
  // E6: approved, not verified: Build. E7: the same but blocked, so held.
  await mk('E6', { title: 'Sort orders', type: 'task', priority: 2, parent: ids.E, acceptance: UNVERIFIED, labels: ['area:api'] });
  await mk('E7', { title: 'Export orders', type: 'task', priority: 2, parent: ids.E, acceptance: UNVERIFIED });
  await mk('X', { title: 'Related thing', type: 'task', priority: 3 });
  await mk('Y', { title: 'Found while building', type: 'bug', priority: 2 });
  await mk('E3', { title: 'Old orders cleanup', type: 'chore', priority: 2, parent: ids.E });
  await beads.close(ids.E3, 'done');
  for (const k of ['E1', 'E4', 'E5', 'E6', 'E7', 'E8']) await beads.claim(ids[k]);
  for (const k of ['E1', 'E4', 'E6', 'E7']) await approved(ids[k]);
  await beads.note(ids.E1, `criteria ${criteriaHash(VERIFIED)}`);
  await beads.note(ids.E4, 'criteria deadbeef');
  await bd(['update', ids.E7, '--status', 'blocked']);
  await bd(['dep', 'add', ids.E2, ids.E1]);
  await bd(['dep', 'add', ids.E2, ids.E3]);
  await bd(['dep', 'add', ids.X, ids.E1, '--type', 'related']);
  await bd(['dep', 'add', ids.Y, ids.E1, '--type', 'discovered-from']);
});

after(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (ws) rmSync(ws, { recursive: true, force: true });
});

test('board: stages, readiness and blockers derive from labels, notes and criteria without Gitea', { skip }, async () => {
  const ctx = ctxWith();
  assert.equal(ctx.config.giteaUrl, undefined);
  const { cards, wip } = await new Model(ctx).board();
  const byId = new Map(cards.map((c) => [c.id, c]));
  assert.ok(!byId.has(ids.E), 'epic excluded');
  assert.ok(cards.every((c) => c.type !== 'gate' && c.type !== 'epic'));
  const e1 = byId.get(ids.E1)!;
  assert.equal(e1.stage, 'review', 'a pr: label means an open PR');
  assert.equal(e1.ciUnknown, true, 'no forge answer: CI unknown');
  assert.deepEqual(e1.pr, { owner: 'acme', repo: 'orders-service', number: 7 }, 'from the label, no url');
  assert.equal(e1.branch, STREAM_BRANCH);
  assert.equal(e1.repo, 'orders-service');
  assert.equal(e1.parent, ids.E);
  assert.equal(e1.live, false);
  assert.equal(e1.held, false);
  assert.equal(e1.awaitingApproval, false);
  assert.equal(e1.status, 'in_progress');
  assert.equal(e1.ready, false, 'in progress, not ready (bd ready semantics)');
  assert.ok(!('awaitingClose' in e1) && !('awaitingGate' in e1));
  const e5 = byId.get(ids.E5)!;
  assert.equal(e5.stage, 'specify');
  assert.equal(e5.awaitingApproval, true, 'specify, and the spec meets the approval rules');
  assert.equal(e5.pr, undefined);
  assert.equal(e5.branch, undefined);
  assert.deepEqual(e5.context, []);
  const e8 = byId.get(ids.E8)!;
  assert.equal(e8.stage, 'specify');
  assert.equal(e8.awaitingApproval, false, 'free-text criteria do not meet the approval rules');
  assert.equal(e8.repo, 'orders-service');
  assert.deepEqual(e8.context, ['docs', 'lib']);
  assert.deepEqual(e8.labels, [], 'context: labels show in their own field');
  assert.equal(byId.get(ids.E6)!.stage, 'build');
  assert.equal(byId.get(ids.E6)!.awaitingApproval, false);
  const e7 = byId.get(ids.E7)!;
  assert.equal(e7.stage, 'build');
  assert.equal(e7.held, true, 'blocked keeps its stage but is held');
  assert.equal(byId.get(ids.E3)!.stage, 'done');
  const e2 = byId.get(ids.E2)!;
  assert.equal(e2.ready, false);
  assert.deepEqual(e2.blockedBy, [ids.E1]);
  assert.equal(e2.stage, 'backlog');
  assert.equal(e2.awaitingApproval, false, 'backlog is not specify');
  assert.equal(byId.get(ids.X)!.ready, true);
  assert.deepEqual(wip, { build: 1, review: 2, limits: { build: 3, review: 3 }, mode: 'warn' }, 'held E7 does not count');
});

test('detail: relations, criteria, approval, comments, command', { skip }, async () => {
  const ctx = ctxWith();
  const m = new Model(ctx);
  await new Beads(tracker).comment(ids.E1, 'looks good');
  const d = await m.detail(ids.E1);
  assert.equal(d.relations.parent, ids.E);
  assert.deepEqual(d.relations.blocks, [ids.E2]);
  assert.deepEqual(d.relations.blockedBy, []);
  assert.deepEqual(d.relations.related, [ids.X]);
  assert.deepEqual(d.relations.spawned, [ids.Y]);
  assert.deepEqual(d.relations.children, []);
  assert.equal(d.specFormat, 'gwt', 'default for a feature');
  assert.ok(d.labels.includes('repo:orders-service'));
  assert.ok(!('gates' in d));
  assert.deepEqual(d.criteria, [{ text: 'Orders arrive in order', ticked: true, check: 'node --test', evidence: 'node --test passed' }]);
  assert.equal(d.planApprovedAt, '2026-11-01T10:00:00.000Z');
  assert.equal(d.criteriaChanged, false, 'baseline matches');
  assert.equal(d.description, STORY);
  assert.equal(d.wipWarning, undefined, 'already approved');
  assert.ok(d.comments.some((c) => c.text === 'looks good'));
  assert.equal(d.command, `strand work ${ids.E1}`);

  assert.equal((await m.detail(ids.E4)).criteriaChanged, true, 'baseline differs from the criteria text');
  const e5 = await m.detail(ids.E5);
  assert.equal(e5.planApprovedAt, undefined);
  assert.equal(e5.criteriaChanged, false, 'no baseline yet');
  assert.equal(e5.criteria.length, 1);
  assert.equal(e5.criteria[0].ticked, false);
  assert.deepEqual(e5.specProblems, []);
  const e8 = await m.detail(ids.E8);
  assert.deepEqual(e8.specProblems, ['1 acceptance line is not in the form "- [ ] <text> (check: <command>)"']);
  assert.deepEqual(e8.context, ['docs', 'lib']);
  assert.deepEqual((await m.detail(ids.E2)).specProblems, ['description must open "As a ..., I want ..., so that ..."']);

  const x = await m.detail(ids.X);
  assert.deepEqual(x.relations.related, [ids.E1]);
  const y = await m.detail(ids.Y);
  assert.deepEqual(y.relations.discoveredFrom, [ids.E1]);
  const e2 = await m.detail(ids.E2);
  assert.deepEqual(e2.relations.blockedBy, [ids.E1], 'closed blocker E3 left out, same rule as the card');
  assert.deepEqual(e2.blockedBy, [ids.E1]);
  const e = await m.detail(ids.E);
  assert.deepEqual(e.relations.children, [ids.E1, ids.E2, ids.E3, ids.E4, ids.E5, ids.E6, ids.E7].sort());
});

test('cards carry labels without repo:, branch: and pr:, and updatedAt; detail carries version, acceptance and editable', { skip }, async () => {
  const m = new Model(ctxWith());
  const { cards } = await m.board();
  const byId = new Map(cards.map((c) => [c.id, c]));
  assert.deepEqual(byId.get(ids.E1)!.labels, [], 'repo, branch and pr labels are left out');
  assert.deepEqual(byId.get(ids.E6)!.labels, ['area:api']);
  assert.deepEqual(byId.get(ids.E2)!.labels, []);
  for (const c of cards) assert.match(c.updatedAt ?? '', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, c.id);
  const d = await m.detail(ids.E6);
  assert.match(d.version, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ:[0-9a-f]{12}$/);
  assert.equal(d.version, beadVersion(await new Beads(tracker).show(ids.E6)));
  assert.ok(d.version.startsWith(`${byId.get(ids.E6)!.updatedAt}:`));
  assert.equal(d.acceptance, UNVERIFIED);
  assert.equal(d.editable, true);
  assert.deepEqual(d.labels, ['area:api'], 'the detail keeps every label');
  const dE1 = await m.detail(ids.E1);
  assert.ok(dE1.labels.includes('repo:orders-service'));
  assert.equal((await m.detail(ids.E3)).editable, false, 'a closed bead is not editable');
});

test('detail: wipWarning appears for an unapproved bead only when approval would hit a limit', { skip }, async () => {
  const base = ctxWith();
  const tight = { ...base, config: { ...base.config, wip: { build: 3, review: 2, mode: 'warn' as const } } };
  const m = new Model(tight);
  assert.equal((await m.detail(ids.E5)).wipWarning, 'Review is at its WIP limit (2/2)');
  assert.equal((await m.detail(ids.E1)).wipWarning, undefined, 'approved beads show no warning');
  assert.equal((await new Model(base).detail(ids.E5)).wipWarning, undefined, 'room under the default limits');
});

test('detail: unknown id rejects with NOT_FOUND', { skip }, async () => {
  const m = new Model(ctxWith());
  await assert.rejects(m.detail('t-nope'), (e: Error & { code?: string }) => {
    assert.equal(e.message, 'bead t-nope not found');
    assert.equal(e.code, 'NOT_FOUND');
    return true;
  });
});

test('detail: artefacts and sessions from a plain (non-git) artefacts folder', { skip }, async () => {
  const root = join(tracker, 'artefacts', ids.X);
  mkdirSync(join(root, 'scratch'), { recursive: true });
  mkdirSync(join(root, 'sessions'), { recursive: true });
  const files: Record<string, string> = {
    'report.html': '<p>hi</p>',
    'shot.PNG': 'png',
    'clip.mp4': 'mp4',
    'spec.pdf': 'pdf',
    'diagram.svg': '<svg/>',
    'notes.txt': 'txt',
    'scratch/try.webp': 'w',
    'scratch/run.mov': 'm',
    'sessions/abc.jsonl.gz': 'gz',
  };
  for (const [p, body] of Object.entries(files)) writeFileSync(join(root, p), body);
  recordStart(tracker, { sessionId: 's-1', beadId: ids.X });

  const d = await new Model(ctxWith()).detail(ids.X);
  const kinds = (l: { name: string; kind: string }[]) => Object.fromEntries(l.map((f) => [f.name, f.kind]));
  assert.deepEqual(kinds(d.artefacts.kept), {
    'clip.mp4': 'video',
    'diagram.svg': 'svg',
    'notes.txt': 'other',
    'report.html': 'html',
    'shot.PNG': 'image',
    'spec.pdf': 'pdf',
  });
  assert.deepEqual(kinds(d.artefacts.scratch), { 'run.mov': 'video', 'try.webp': 'image' });
  assert.deepEqual(kinds(d.artefacts.transcripts), { 'abc.jsonl.gz': 'transcript' });
  const html = d.artefacts.kept.find((f) => f.name === 'report.html')!;
  assert.equal(html.relPath, 'report.html');
  assert.equal(html.size, 9);
  assert.equal(d.artefacts.scratch.find((f) => f.name === 'try.webp')!.relPath, 'scratch/try.webp');
  assert.deepEqual(d.sessions.map((s) => s.sessionId), ['s-1']);
  assert.equal(d.live, true);

  const none = await new Model(ctxWith()).detail(ids.Y);
  assert.deepEqual(none.artefacts, { kept: [], scratch: [], transcripts: [] });
});

test('needsYou: an open bead with a live session that waits; not an ended session, not a closed bead', { skip }, async () => {
  const startedAt = '2026-11-25T10:00:00.000Z';
  const needsYou = '2026-11-25T10:05:00.000Z';
  writeEntry(tracker, { sessionId: 'n-wait', beadId: ids.Y, startedAt, needsYou });
  writeEntry(tracker, { sessionId: 'n-busy2', beadId: ids.Y, startedAt });
  writeEntry(tracker, { sessionId: 'n-busy', beadId: ids.E6, startedAt });
  writeEntry(tracker, { sessionId: 'n-closed', beadId: ids.E3, startedAt, needsYou });
  writeEntry(tracker, { sessionId: 'n-ended', beadId: ids.E2, startedAt, endedAt: '2026-11-25T10:06:00.000Z', needsYou });
  try {
    const ctx = ctxWith();
    const model = new Model(ctx);
    const byId = new Map((await model.board()).cards.map((c) => [c.id, c]));
    const flags = (id: string) => [byId.get(id)!.live, byId.get(id)!.needsYou];
    assert.deepEqual(flags(ids.Y), [true, true], 'one of its live sessions waits');
    assert.deepEqual(flags(ids.E6), [true, false], 'live and working');
    assert.deepEqual(flags(ids.E2), [false, false], 'the session ended');
    assert.equal(byId.get(ids.E1)!.needsYou, false, 'no session');
    assert.equal((await model.detail(ids.Y)).needsYou, true);
    const closed = await model.detail(ids.E3);
    assert.deepEqual([closed.live, closed.needsYou], [true, false], 'a closed bead never needs you');
    assert.equal(ctx.beads.calls.listAll, 1, 'from the one refresh');
  } finally {
    for (const sessionId of ['n-wait', 'n-busy2', 'n-busy', 'n-closed']) recordEnd(tracker, { sessionId });
  }
});

test('epics: counts and child cards', { skip }, async () => {
  const epics = await new Model(ctxWith()).epics();
  assert.equal(epics.length, 1);
  assert.equal(epics[0].id, ids.E);
  assert.equal(epics[0].title, 'Orders epic');
  assert.deepEqual(epics[0].counts, { closed: 1, inProgress: 4, ready: 0, blocked: 2 });
  assert.deepEqual(epics[0].children.map((c) => c.id).sort(), [ids.E1, ids.E2, ids.E3, ids.E4, ids.E5, ids.E6, ids.E7].sort());
});

test('Gitea configured: forge answers replace the label facts; a failed refresh does not disable Gitea', { skip }, async () => {
  const ctx = ctxWith({ STRAND_GITEA_URL: giteaUrl, STRAND_GITEA_TOKEN: 'test-token' });
  let t = 0;
  const m = new Model(ctx, { now: () => t });

  failNextGitea = true;
  const first = await m.board();
  const f1 = first.cards.find((c) => c.id === ids.E1)!;
  assert.equal(f1.stage, 'review', 'Gitea error: the pr: label still means an open PR');
  assert.equal(f1.ciUnknown, true);
  assert.equal(f1.pr?.url, undefined);

  m.invalidate();
  const second = await m.board();
  const e1 = second.cards.find((c) => c.id === ids.E1)!;
  assert.equal(e1.stage, 'review');
  assert.equal(e1.ciUnknown, false, 'the forge reported CI');
  assert.deepEqual(e1.pr, { owner: 'acme', repo: 'orders-service', number: 7, url: 'http://x/pr/7' });
  const e4 = second.cards.find((c) => c.id === ids.E4)!;
  assert.equal(e4.stage, 'verify', 'the forge says PR 9 was closed unmerged');
  assert.equal(e4.pr?.url, 'http://x/pr/9');
  assert.equal(second.cards.find((c) => c.id === ids.E6)!.pr, undefined, 'no pr: label, no forge call');
  assert.deepEqual(second.wip, { build: 1, review: 1, limits: { build: 3, review: 3 }, mode: 'warn' });
  assert.deepEqual((await m.reviewQueue()).map((c) => c.id), [ids.E1]);
  assert.deepEqual((await m.brief()).waiting.map((w) => [w.id, w.action]).sort(), [[ids.E1, 'review'], [ids.E5, 'approve spec']].sort());

  const hits = giteaHits;
  t += 1000;
  await m.board();
  assert.equal(giteaHits, hits, 'PR facts are cached within the TTL');
});

test('brief: shape computed from the cached data', { skip }, async () => {
  const ctx = ctxWith();
  const b = await new Model(ctx).brief();
  const byId = (a: { id: string }, c: { id: string }) => a.id.localeCompare(c.id);
  assert.deepEqual(
    [...b.waiting].sort(byId),
    [
      { id: ids.E1, title: 'Stream orders', action: 'review' },
      { id: ids.E4, title: 'Retire old orders', action: 'review' },
      { id: ids.E5, title: 'Filter orders', action: 'approve spec' },
    ].sort(byId),
  );
  assert.ok(b.waiting.every((w) => !('gate' in w)));
  assert.deepEqual(b.blocked.filter((x) => x.id === ids.E2), [{ id: ids.E2, title: 'Paginate orders', blockers: [ids.E1] }]);
  assert.ok(b.ready.some((r) => r.id === ids.X && r.priority === 3));
  assert.ok(!b.ready.some((r) => [ids.E, ids.E1, ids.E2, ids.E3].includes(r.id)));
  assert.deepEqual(b.wip, { build: { count: 1, limit: 3 }, review: { count: 2, limit: 3 } });
  assert.ok(b.sessions.some((s) => s.sessionId === 's-1' && s.beadId === ids.X));
  assert.equal(ctx.beads.calls.show ?? 0, 0, 'brief makes no per-bead bd show');
});

test('brief: a full WIP limit comes back as wip.warning', { skip }, async () => {
  const base = ctxWith();
  const tight = { ...base, config: { ...base.config, wip: { build: 1, review: 2, mode: 'warn' as const } } };
  const b = await new Model(tight).brief();
  assert.equal(b.wip.warning, 'Review is at its WIP limit (2/2)');
});

test('bd unavailable: board rejects with "Beads unavailable:"', { skip }, async () => {
  const empty = mkdtempSync(join(tmpdir(), 'strand-nobd-'));
  try {
    for (const dir of [join(empty, 'missing'), empty]) {
      const ctx = ctxWith();
      const m = new Model({ ...ctx, beads: new Beads(dir) });
      await assert.rejects(m.board(), (e: Error) => {
        assert.match(e.message, /^Beads unavailable: /);
        return true;
      });
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('performance: 300 beads cost one bd list per refresh, none within the TTL', { skip }, async () => {
  const md = Array.from({ length: 300 }, (_, i) => `## Bulk ${i}\n\n### Type\ntask\n`).join('\n');
  const file = join(ws, 'bulk.md');
  writeFileSync(file, md);
  await bd(['create', '-f', file]);

  const ctx = ctxWith();
  let t = 0;
  const m = new Model(ctx, { ttlMs: 15_000, now: () => t });
  const started = Date.now();
  const { cards } = await m.board();
  assert.ok(cards.length >= 305, `got ${cards.length} cards`);
  assert.deepEqual(ctx.beads.calls, { listAll: 1 });
  assert.ok(Date.now() - started < 5000, 'board over 300 beads is fast');

  t += 14_000;
  await m.board();
  await m.epics();
  await m.reviewQueue();
  await m.brief();
  assert.equal(ctx.beads.total(), 1, 'no bd calls within the TTL');

  t += 2_000;
  await m.board();
  assert.deepEqual(ctx.beads.calls, { listAll: 2 });

  m.invalidate();
  await Promise.all([m.board(), m.board()]);
  assert.deepEqual(ctx.beads.calls, { listAll: 3 }, 'concurrent refreshes coalesce');
});

test('invalidate during an in-flight refresh: the stale result is not cached and later callers re-read', { skip }, async () => {
  const ctx = ctxWith();
  const m = new Model(ctx, { now: () => 0 });
  let release!: () => void;
  ctx.beads.hold = new Promise<void>((r) => (release = r));
  const first = m.board();
  while (!ctx.beads.calls.listAll) await new Promise((r) => setTimeout(r, 5));
  m.invalidate(); // a write lands while the first refresh is still reading
  const second = m.board();
  ctx.beads.hold = undefined;
  release();
  await Promise.all([first, second]);
  assert.equal(ctx.beads.calls.listAll, 2, 'the caller after invalidate started its own refresh');
  await m.board();
  assert.equal(ctx.beads.calls.listAll, 2, 'the post-invalidate snapshot is cached');
});

test('detail: repeated unknown ids within 1 s make no bd calls; an older snapshot is re-read once', { skip }, async () => {
  const ctx = ctxWith();
  let t = 0;
  const m = new Model(ctx, { now: () => t });
  await m.board();
  assert.equal(ctx.beads.total(), 1);
  t = 500;
  for (let i = 0; i < 3; i++) await assert.rejects(m.detail(`t-junk${i}`), { code: 'NOT_FOUND' });
  assert.equal(ctx.beads.total(), 1, 'fresh snapshot: no re-read');
  t = 2_000;
  await assert.rejects(m.detail('t-junk'), { code: 'NOT_FOUND' });
  assert.deepEqual(ctx.beads.calls, { listAll: 2 }, 'older snapshot: one re-read');
  t = 2_500;
  await assert.rejects(m.detail('t-junk'), { code: 'NOT_FOUND' });
  await m.board();
  assert.deepEqual(ctx.beads.calls, { listAll: 2 }, 're-read snapshot kept for everyone');
});

/** Beads that returns canned rows without running bd. */
class FakeBeads extends Beads {
  rows: ListedBead[];
  constructor(dir: string, rows: ListedBead[]) {
    super(dir);
    this.rows = rows;
  }
  override async listAll() {
    return this.rows;
  }
}

const row = (id: string, extra: Partial<ListedBead> = {}): ListedBead => ({
  id,
  title: id,
  status: 'open',
  priority: 2,
  issue_type: 'task',
  labels: [],
  dependencies: [],
  ...extra,
});

test('resilient refresh: a malformed bead falls back to backlog with one warning; bad session index is empty', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'strand-fake-'));
  try {
    mkdirSync(join(dir, '.strand'));
    writeFileSync(join(dir, '.strand', 'sessions'), 'not a directory');
    const errs: string[] = [];
    const base = ctxWith();
    const rows = [
      row('f-good', { status: 'in_progress' }),
      row('f-bad', { notes: 42 as unknown as string }),
      row('f-odd', { labels: 'repo:x' as unknown as string[], dependencies: 'nope' as unknown as ListedBead['dependencies'] }),
    ];
    const ctx: Ctx = {
      ...base,
      config: { ...base.config, trackerDir: dir },
      beads: new FakeBeads(dir, rows),
      err: (l) => errs.push(l),
    };
    const { cards } = await new Model(ctx).board();
    const stage = Object.fromEntries(cards.map((c) => [c.id, c.stage]));
    assert.deepEqual(stage, { 'f-bad': 'backlog', 'f-good': 'specify', 'f-odd': 'backlog' });
    assert.equal(errs.filter((e) => e.includes('f-bad')).length, 1);
    assert.equal(errs.filter((e) => e.includes('session index')).length, 1);
    assert.ok(cards.every((c) => c.live === false));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gitea lookups run at most 4 at a time and only for beads with a pr: label', { skip }, async () => {
  const base = ctxWith();
  const rows: ListedBead[] = [];
  for (let i = 0; i < 10; i++) {
    rows.push(
      row(`p-${i}`, {
        labels: ['repo:orders-service', `branch:ada/p-${i}`, `pr:acme/orders-service#${i + 1}`],
        notes: 'plan-approved 2026-11-01T10:00:00.000Z',
        acceptance_criteria: UNVERIFIED,
      }),
    );
  }
  rows.push(row('p-nopr', { labels: ['repo:orders-service', 'branch:ada/nopr'], notes: 'plan-approved 2026-11-01T10:00:00.000Z' }));
  let inFlight = 0;
  let maxInFlight = 0;
  let lookups = 0;
  const gitea = {
    async findPullForBranch() {
      lookups++;
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return undefined;
    },
  } as unknown as Gitea;
  const ctx: Ctx = { ...base, gitea, beads: new FakeBeads(base.config.trackerDir, rows) };
  delete ctx.config.giteaUrl;
  const { cards } = await new Model(ctx).board();
  assert.equal(lookups, 10, 'only beads with a pr: label ask the forge');
  assert.ok(maxInFlight <= 4, `max in flight ${maxInFlight}`);
  assert.ok(maxInFlight > 1, 'lookups do run in parallel');
  assert.ok(cards.every((c) => c.stage === 'build'), 'no PR found: the label facts stand, criteria unverified');
});

test('a closed bead with a pr: label makes no forge call and keeps its label PR', { skip }, async () => {
  const base = ctxWith();
  const rows = [
    row('c-1', { status: 'closed', labels: ['repo:orders-service', 'branch:ada/c-1', 'pr:acme/orders-service#41'], notes: PR_DONE }),
    row('o-1', { labels: ['repo:orders-service', 'branch:ada/o-1', 'pr:acme/orders-service#42'], notes: PR_DONE }),
  ];
  const asked: string[] = [];
  const gitea = {
    async findPullForBranch(_o: string, _r: string, branch: string) {
      asked.push(branch);
      return undefined;
    },
  } as unknown as Gitea;
  const ctx: Ctx = { ...base, gitea, beads: new FakeBeads(base.config.trackerDir, rows) };
  delete ctx.config.giteaUrl;
  const { cards } = await new Model(ctx).board();
  assert.deepEqual(asked, ['ada/o-1']);
  const closed = cards.find((c) => c.id === 'c-1')!;
  assert.equal(closed.stage, 'done');
  assert.deepEqual(closed.pr, { owner: 'acme', repo: 'orders-service', number: 41 });
});

test('ready: children (and grandchildren) of a blocked epic are not ready, matching bd ready', { skip }, async () => {
  const ws2 = mkdtempSync(join(tmpdir(), 'strand-ready-'));
  try {
    const tr = join(ws2, 'tracker');
    mkdirSync(tr);
    await run('git', ['init', '-q'], { cwd: tr });
    const init = await runWith('bd', ['init', '--prefix', 'r'], { cwd: tr, env: bdEnv });
    assert.equal(init.code, 0, init.stderr);
    const beads = new Beads(tr);
    const a = (await beads.create({ title: 'Blocked epic', type: 'epic' })).id;
    const b = (await beads.create({ title: 'Blocking epic', type: 'epic' })).id;
    const a1 = (await beads.create({ title: 'Child of blocked', type: 'task', parent: a })).id;
    const a11 = (await beads.create({ title: 'Grandchild of blocked', type: 'task', parent: a1 })).id;
    const b1 = (await beads.create({ title: 'Child of blocking', type: 'task', parent: b })).id;
    const dep = await runWith('bd', ['dep', 'add', a, b], { cwd: tr, env: bdEnv });
    assert.equal(dep.code, 0, dep.stderr);

    const ctx = buildCtx({ ...env, STRAND_WORKSPACE: ws2 }, { out: () => {}, err: () => {} });
    const model = new Model({ ...ctx, beads: new Beads(tr) });
    const { cards } = await model.board();
    const byId = new Map(cards.map((c) => [c.id, c]));
    assert.equal(byId.get(a1)!.ready, false);
    assert.equal(byId.get(a11)!.ready, false);
    assert.equal(byId.get(b1)!.ready, true);

    const r = await runWith('bd', ['ready', '--limit', '0', '--json'], { cwd: tr, env: bdEnv });
    const bdReady = (JSON.parse(r.stdout) as { id: string; issue_type: string }[])
      .filter((x) => x.issue_type !== 'epic')
      .map((x) => x.id)
      .sort();
    assert.deepEqual(cards.filter((c) => c.ready).map((c) => c.id).sort(), bdReady);
    const epic = (await model.epics()).find((e) => e.id === a)!;
    assert.equal(epic.counts.ready, 0);
  } finally {
    rmSync(ws2, { recursive: true, force: true });
  }
});

test('a hung bd: the model rejects within its timeout with "Beads unavailable" and the next call retries', { skip }, async () => {
  const ctx = ctxWith();
  let hang = true;
  const slow = new (class extends CountingBeads {
    override async listAll() {
      if (hang) return new Promise<never>(() => {});
      return super.listAll();
    }
  })(ctx.config.trackerDir);
  const model = new Model({ ...ctx, beads: slow }, { bdTimeoutMs: 200 });
  const started = Date.now();
  await assert.rejects(model.board(), (e: Error) => {
    assert.equal(e.message, 'Beads unavailable: bd did not answer within 0.2 s');
    return true;
  });
  assert.ok(Date.now() - started < 3000);
  hang = false;
  // a real bd call takes 300 to 500 ms on Windows, longer than the 200 ms used to provoke the timeout
  (model as unknown as { bdTimeoutMs: number }).bdTimeoutMs = 10000;
  const { cards } = await model.board();
  assert.ok(cards.length > 0);
});

const PR_DONE = 'plan-approved 2026-11-01T10:00:00.000Z';

test('origin lookups: one per repo folder per refresh, however many PR beads', { skip }, async () => {
  const base = ctxWith();
  for (const r of ['repo-a', 'repo-b']) mkdirSync(join(base.config.workspaceRoot, r), { recursive: true });
  const rows: ListedBead[] = [];
  for (const r of ['repo-a', 'repo-b']) {
    for (let i = 0; i < 4; i++) {
      rows.push(row(`${r}-${i}`, { labels: [`repo:${r}`, `branch:ada/${r}-${i}`, `pr:acme/${r}#${i + 1}`], notes: PR_DONE }));
    }
  }
  const asked: string[] = [];
  const gitea = { async findPullForBranch() { return undefined; } } as unknown as Gitea;
  const ctx: Ctx = { ...base, gitea, beads: new FakeBeads(base.config.trackerDir, rows) };
  delete ctx.config.giteaUrl;
  const m = new Model(ctx, {
    now: () => 0,
    originOf: async (dir) => {
      asked.push(dir);
      return { owner: 'acme', repo: 'x' };
    },
  });
  await m.board();
  assert.equal(asked.length, 2, `asked ${asked.join(', ')}`);
  assert.equal(new Set(asked).size, 2);
  m.invalidate();
  await m.board();
  assert.equal(asked.length, 4, 'a new refresh asks again');
});

test('partial forge failure: pull found but CI lookup throws keeps the label fact', { skip }, async () => {
  const base = ctxWith();
  mkdirSync(join(base.config.workspaceRoot, 'repo-a'), { recursive: true });
  const rows = [row('pf-1', { labels: ['repo:repo-a', 'branch:ada/pf', 'pr:acme/repo-a#5'], notes: PR_DONE })];
  const gitea = {
    async findPullForBranch() {
      return { number: 5, state: 'open', merged: false, headSha: 'abc', headRef: 'ada/pf', url: 'http://x/pr/5' };
    },
    async ciState() {
      throw new Error('ci down');
    },
  } as unknown as Gitea;
  const errs: string[] = [];
  const ctx: Ctx = { ...base, gitea, beads: new FakeBeads(base.config.trackerDir, rows), err: (l) => errs.push(l) };
  delete ctx.config.giteaUrl;
  const { cards } = await new Model(ctx, { originOf: async () => ({ owner: 'acme', repo: 'repo-a' }) }).board();
  const c = cards[0];
  assert.equal(c.ciUnknown, true);
  assert.equal(c.pr?.url, undefined);
  assert.deepEqual(c.pr, { owner: 'acme', repo: 'repo-a', number: 5 });
  assert.equal(c.stage, 'build', 'label fact: open PR, criteria unverified');
  assert.equal(errs.filter((e) => e.includes('Gitea unavailable')).length, 1);
});

/** Rows from memory, and a record of every close. */
class ClosingBeads extends FakeBeads {
  closed: { id: string; reason: string }[] = [];
  failClose = false;
  override async close(id: string, reason: string) {
    if (this.failClose) throw new Error('bd is down');
    this.closed.push({ id, reason });
  }
}

function mergedSetup(label: string, pull: { number: number; merged: boolean }, origin = { owner: 'acme', repo: 'repo-a' }) {
  const base = ctxWith();
  mkdirSync(join(base.config.workspaceRoot, 'repo-a'), { recursive: true });
  const rows = [row('mg-1', { status: 'in_progress', labels: ['repo:repo-a', 'branch:ada/mg', label], notes: PR_DONE, acceptance_criteria: VERIFIED })];
  const gitea = {
    async findPullForBranch() {
      return { ...pull, state: pull.merged ? 'closed' : 'open', headSha: 'abc', headRef: 'ada/mg', url: 'http://x/pr' };
    },
    async ciState() {
      return 'success';
    },
  } as unknown as Gitea;
  const beads = new ClosingBeads(base.config.trackerDir, rows);
  const errs: string[] = [];
  const ctx: Ctx = { ...base, gitea, beads, err: (l) => errs.push(l) };
  delete ctx.config.giteaUrl;
  const asked = { n: 0 };
  const m = new Model(ctx, { now: () => 0, originOf: async () => origin });
  const listAll = beads.listAll.bind(beads);
  beads.listAll = async () => {
    asked.n++;
    return listAll();
  };
  return { m, beads, errs, asked };
}

test('close on merge: the PR of the bead label merged on the forge closes the bead', { skip }, async () => {
  const { m, beads, asked } = mergedSetup('pr:acme/repo-a#5', { number: 5, merged: true });
  const { cards } = await m.board();
  assert.deepEqual(beads.closed, [{ id: 'mg-1', reason: 'Merged as acme/repo-a#5' }]);
  assert.equal(cards[0].stage, 'done');
  assert.equal(cards[0].status, 'closed');
  assert.equal(cards[0].needsYou, false);
  const before = asked.n;
  await m.board();
  assert.equal(asked.n, before + 1, 'the snapshot of a refresh that closed a bead is not cached');
});

test('close on merge: an open PR closes nothing', { skip }, async () => {
  const { m, beads } = mergedSetup('pr:acme/repo-a#5', { number: 5, merged: false });
  const { cards } = await m.board();
  assert.deepEqual(beads.closed, []);
  assert.equal(cards[0].stage, 'review');
});

test('close on merge: a merged PR with another number than the label closes nothing', { skip }, async () => {
  const { m, beads } = mergedSetup('pr:acme/repo-a#5', { number: 4, merged: true });
  const { cards } = await m.board();
  assert.deepEqual(beads.closed, [], 'an older PR from a reused branch name is not this bead');
  assert.notEqual(cards[0].stage, 'done');
});

test('close on merge: a label for another repo than the origin closes nothing', { skip }, async () => {
  const { m, beads } = mergedSetup('pr:acme/other#5', { number: 5, merged: true });
  await m.board();
  assert.deepEqual(beads.closed, []);
});

test('close on merge: a failed close warns once and leaves the bead in review', { skip }, async () => {
  const { m, beads, errs } = mergedSetup('pr:acme/repo-a#5', { number: 5, merged: true });
  beads.failClose = true;
  const { cards } = await m.board();
  assert.equal(cards[0].stage, 'review');
  assert.equal(cards[0].status, 'in_progress');
  assert.equal(errs.filter((e) => e.includes('cannot close mg-1')).length, 1);
});

/** A model whose beads sit in a repo on `host`, with fake Gitea and GitHub forges that record every call. */
function forgeSetup(
  labels: string[][],
  o: { host: string; github: Partial<Forge>; status?: string; giteaUrl?: string },
) {
  const base = ctxWith();
  mkdirSync(join(base.config.workspaceRoot, 'app'), { recursive: true });
  const rows = labels.map((l, i) =>
    row(`gh-${i + 1}`, { status: o.status ?? 'in_progress', labels: ['repo:app', `branch:ada/gh-${i + 1}`, ...l], notes: PR_DONE, acceptance_criteria: VERIFIED }),
  );
  const calls = { gitea: 0, github: 0 };
  const count = (k: 'gitea' | 'github', f: Partial<Forge>): Forge =>
    Object.fromEntries(
      Object.entries(f).map(([name, fn]) => [name, typeof fn === 'function' ? (...a: unknown[]) => (calls[k]++, (fn as (...x: unknown[]) => unknown)(...a)) : fn]),
    ) as unknown as Forge;
  const gitea = count('gitea', {
    name: 'Gitea',
    async findPullForBranch() {
      return undefined;
    },
    async ciState() {
      return 'none';
    },
  });
  const github = count('github', { name: 'GitHub', ...o.github });
  const beads = new ClosingBeads(base.config.trackerDir, rows);
  const errs: string[] = [];
  const ctx: Ctx = { ...base, gitea: gitea as unknown as Gitea, beads, err: (l) => errs.push(l) };
  delete ctx.config.giteaUrl;
  if (o.giteaUrl) {
    // A configured Gitea on another host. The model makes its own client from the token, never the keychain.
    ctx.config.giteaUrl = o.giteaUrl;
    ctx.env = { ...ctx.env, STRAND_GITEA_TOKEN: 'tok' };
  }
  const m = new Model(ctx, { now: () => 0, originOf: async () => ({ owner: 'acme', repo: 'app', host: o.host }), github: () => github });
  return { m, beads, errs, calls };
}

const ghPull = (number: number, merged: boolean) => ({
  number,
  state: merged ? ('closed' as const) : ('open' as const),
  merged,
  headSha: 'abc',
  headRef: 'ada/gh-1',
  url: `https://github.com/acme/app/pull/${number}`,
});

test("a GitHub PR's state and CI reach the card", { skip }, async () => {
  const { m, calls } = forgeSetup([['pr:acme/app#4']], {
    host: 'github.com',
    github: { findPullForBranch: async () => ghPull(4, false), ciState: async () => 'failure' },
  });
  const { cards } = await m.board();
  assert.equal(cards[0].pr?.url, 'https://github.com/acme/app/pull/4');
  assert.equal(cards[0].ciUnknown, false);
  assert.equal(cards[0].stage, 'verify', 'an open PR with failing CI stays in verify');
  assert.equal(calls.gitea, 0, 'Gitea is not asked about a github.com repo');
  assert.ok(calls.github >= 2, 'GitHub was asked for the PR and its CI');
});

test('a bead whose GitHub PR merged is closed', { skip }, async () => {
  const { m, beads } = forgeSetup([['pr:acme/app#4']], { host: 'github.com', github: { findPullForBranch: async () => ghPull(4, true), ciState: async () => 'success' } });
  const { cards } = await m.board();
  assert.deepEqual(beads.closed, [{ id: 'gh-1', reason: 'Merged as acme/app#4' }]);
  assert.equal(cards[0].stage, 'done');
});

test('a merged GitHub PR with another number does not close the bead', { skip }, async () => {
  const { m, beads } = forgeSetup([['pr:acme/app#4']], { host: 'github.com', github: { findPullForBranch: async () => ghPull(2, true), ciState: async () => 'success' } });
  await m.board();
  assert.deepEqual(beads.closed, []);
});

test('a GitHub outage warns once and keeps local facts', { skip }, async () => {
  const down = async () => {
    throw new Error('gh is not signed in: run gh auth login');
  };
  const { m, errs } = forgeSetup([['pr:acme/app#4'], ['pr:acme/app#5']], { host: 'github.com', github: { findPullForBranch: down, ciState: down } });
  const { cards } = await m.board();
  assert.equal(errs.length, 1, errs.join('\n'));
  assert.match(errs[0]!, /^strand cockpit: GitHub unavailable: gh is not signed in: run gh auth login$/);
  for (const c of cards) assert.equal(c.ciUnknown, true);
});

test('a bead on an unsupported host makes no forge call', { skip }, async () => {
  const { m, calls, errs } = forgeSetup([['pr:acme/app#4']], { host: 'review.example.org', giteaUrl: 'http://127.0.0.1:9', github: { findPullForBranch: async () => ghPull(4, false), ciState: async () => 'success' } });
  const { cards } = await m.board();
  assert.deepEqual(calls, { gitea: 0, github: 0 });
  assert.deepEqual(errs, [], 'the configured Gitea was not asked either');
  assert.deepEqual(cards[0].pr, { owner: 'acme', repo: 'app', number: 4 });
});
