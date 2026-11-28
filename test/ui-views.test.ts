import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Brief } from '../src/cli/commands/brief.ts';
import type { BeadCard, Epic } from '../src/cockpit/model.ts';
import { createBead } from '../src/core/create-bead.ts';
import { captureProblems, specProblems } from '../src/core/facts.ts';
import type { Stage } from '../src/core/stage.ts';
import {
  ACCEPTANCE_PLACEHOLDER,
  ALL_TYPES,
  BEAD_DRAG_TYPE,
  DESCRIPTION_PLACEHOLDER,
  NO_PARENT_OPTION,
  NO_REPO_NOTE,
  dropVerdict,
  hasBeadDrag,
  emptyForm,
  epicSegments,
  fieldOf,
  filterRepos,
  TITLE_MAX,
  formTouched,
  greeting,
  headerCounts,
  makePrimary,
  reviewRows,
  selectedEpic,
  toggleRepo,
  validateNewBead,
  waitingOnYou,
  wipBanners,
  wipBars,
  HEADER_TABS,
} from '../ui/src/lib/views.ts';

const card = (o: Partial<BeadCard>): BeadCard => ({
  id: 'b-1', title: 't', type: 'task', priority: 2, status: 'open', stage: 'backlog',
  ready: false, blockedBy: [], live: false, needsYou: false, held: false, awaitingApproval: false, ciUnknown: false, labels: [], context: [], ...o,
});
const wip = (b: number, r: number, lb = 3, lr = 3): Brief['wip'] => ({ build: { count: b, limit: lb }, review: { count: r, limit: lr } });

test('waitingOnYou splits approve spec and review, in server order, with board priority', () => {
  const brief = {
    waiting: [
      { id: 'b-1', title: 'one', action: 'approve spec' as const },
      { id: 'b-2', title: 'two', action: 'review' as const },
      { id: 'b-9', title: 'gone', action: 'review' as const },
    ],
  };
  const cards = [card({ id: 'b-1', priority: 1 }), card({ id: 'b-2', priority: 0 })];
  const w = waitingOnYou(brief, cards);
  assert.deepEqual(w.approve, [{ id: 'b-1', title: 'one', priority: 1 }]);
  assert.deepEqual(w.review, [{ id: 'b-2', title: 'two', priority: 0 }, { id: 'b-9', title: 'gone' }]);
  assert.equal(w.total, 3);
  assert.deepEqual(waitingOnYou({ waiting: [] }, cards), { approve: [], review: [], total: 0 });
});

test('headerCounts: cards in stage review, and cards awaiting approval', () => {
  assert.deepEqual(headerCounts([]), { review: 0, approve: 0 });
  const cards = [
    card({ id: 'r1', stage: 'review' }),
    card({ id: 'r2', stage: 'review' }),
    card({ id: 'r3', stage: 'review', held: true, status: 'blocked' }),
    card({ id: 's1', stage: 'specify', awaitingApproval: true }),
    card({ id: 's2', stage: 'specify', awaitingApproval: true }),
    card({ id: 'b1', stage: 'build' }),
  ];
  assert.deepEqual(headerCounts(cards), { review: 3, approve: 2 });
});

test('wipBars: percentage capped at 100, full at or over the limit', () => {
  const [build, review] = wipBars(wip(1, 4));
  assert.deepEqual(build, { key: 'build', label: 'Build', count: 1, limit: 3, pct: 33, full: false });
  assert.deepEqual(review, { key: 'review', label: 'Review', count: 4, limit: 3, pct: 100, full: true });
  assert.equal(wipBars(wip(0, 0, 0, 3))[0].pct, 100);
});

test('wipBanners: none under the limits, review banner first when both are full (refuse mode)', () => {
  assert.deepEqual(wipBanners(wip(2, 2), 'refuse'), []);
  assert.deepEqual(wipBanners(wip(0, 3), 'refuse'), ['Review is at its WIP limit (3/3) - new Build work is paused']);
  const both = wipBanners(wip(3, 3), 'refuse');
  assert.equal(both.length, 2);
  assert.match(both[0], /^Review is at its WIP limit/);
  assert.match(both[1], /^Build is at its WIP limit \(3\/3\)/);
});

test('wipBanners in warn mode only warn: they do not say work is paused', () => {
  assert.deepEqual(wipBanners(wip(0, 3), 'warn'), ['Review is at its WIP limit (3/3)']);
  assert.deepEqual(wipBanners(wip(3, 0)), ['Build is at its WIP limit (3/3)']);
});

test('greeting follows the time of day', () => {
  assert.match(greeting(new Date(2026, 10, 22, 9)), /^Good morning · Sunday 22 November$/);
  assert.match(greeting(new Date(2026, 10, 22, 14)), /^Good afternoon/);
  assert.match(greeting(new Date(2026, 10, 22, 20)), /^Good evening/);
});

const epic = (counts: Epic['counts'], n: number, id = 'e-1'): Epic => ({
  id, title: 'E', priority: 1, counts, children: Array.from({ length: n }, (_, i) => card({ id: `c-${i}` })),
});

test('epicSegments: proportional segments in order, zeros dropped', () => {
  const s = epicSegments(epic({ closed: 1, inProgress: 1, ready: 2, blocked: 0 }, 4));
  assert.deepEqual(s.map((x) => [x.key, x.n, x.pct]), [['closed', 1, 25], ['inProgress', 1, 25], ['ready', 2, 50]]);
});

test('epicSegments: children the counts miss show as other, so the bar sums to 100', () => {
  const s = epicSegments(epic({ closed: 1, inProgress: 0, ready: 1, blocked: 0 }, 4));
  assert.deepEqual(s.at(-1), { key: 'other', label: 'other', n: 2, pct: 50 });
  assert.equal(s.reduce((a, x) => a + x.pct, 0), 100);
});

test('epicSegments: no children gives no segments; counts beyond children never overflow', () => {
  assert.deepEqual(epicSegments(epic({ closed: 0, inProgress: 0, ready: 0, blocked: 0 }, 0)), []);
  const s = epicSegments(epic({ closed: 2, inProgress: 0, ready: 0, blocked: 0 }, 1));
  assert.equal(s.reduce((a, x) => a + x.pct, 0), 100);
});

test('selectedEpic: route id when known, else the first epic', () => {
  const list = [epic({ closed: 0, inProgress: 0, ready: 0, blocked: 0 }, 0, 'e-1'), epic({ closed: 0, inProgress: 0, ready: 0, blocked: 0 }, 0, 'e-2')];
  assert.equal(selectedEpic(list, 'e-2')?.id, 'e-2');
  assert.equal(selectedEpic(list, 'nope')?.id, 'e-1');
  assert.equal(selectedEpic(list, undefined)?.id, 'e-1');
  assert.equal(selectedEpic([], 'e-1'), undefined);
});

test('reviewRows: stage review only, by priority then id', () => {
  const rows = reviewRows([
    card({ id: 'b-3', stage: 'review', priority: 2 }),
    card({ id: 'b-2', stage: 'review', priority: 2 }),
    card({ id: 'b-1', stage: 'verify', priority: 0 }),
    card({ id: 'b-4', stage: 'review', priority: 0 }),
    card({ id: 'b-5', stage: 'done', priority: 0 }),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['b-4', 'b-2', 'b-3']);
});

test('type list matches the brief: code, playbooks and epic', () => {
  assert.deepEqual(ALL_TYPES, [
    'feature', 'bug', 'task', 'chore', 'spike',
    'supplier-spec', 'security-review', 'eula-review', 'dpia', 'deck', 'rfc', 'decision', 'incident', 'retro',
    'epic',
  ]);
});

const STORY = 'As a buyer, I want a CSV, so that I can sort it';
const CRITERION = '- [ ] Export downloads (check: npm test)';
type Form = ReturnType<typeof emptyForm>;
const filled = (o: Partial<Form> = {}): Form => ({
  ...emptyForm(), title: 'Do it', description: STORY, acceptance: CRITERION, parent: 'e-1', ...o,
});
const errs = (f: Form) => {
  const v = validateNewBead(f);
  return 'errors' in v ? v.errors : {};
};

test('the form starts empty, with the story and criterion forms as placeholders', () => {
  assert.equal(emptyForm().acceptance, '');
  assert.equal(emptyForm().description, '');
  assert.deepEqual(emptyForm().repos, []);
  assert.equal(ACCEPTANCE_PLACEHOLDER, '- [ ] <text> (check: <command>)');
  assert.equal(DESCRIPTION_PLACEHOLDER, 'As <role>, I want ..., so that ...');
  assert.equal(emptyForm().priority, 2);
});

test('validateNewBead: trims, defaults to P2, sends description, acceptance, parent, the primary repo and context folders', () => {
  assert.deepEqual(validateNewBead(filled({ title: '  Do it ', repos: ['orders-service', 'docs'], description: `  ${STORY} ` })), {
    ok: { title: 'Do it', type: 'feature', priority: 2, repo: 'orders-service', context: ['docs'], description: STORY, acceptance: CRITERION, parent: 'e-1' },
  });
});

test('validateNewBead: a title, a type and a parent are enough; text fields are free', () => {
  assert.deepEqual(validateNewBead({ ...emptyForm(), title: 'Just a title', parent: 'e-1' }), {
    ok: { title: 'Just a title', type: 'feature', priority: 2, parent: 'e-1' },
  });
  for (const o of [{ description: 'build a thing' }, { acceptance: 'it should be fast' }, { acceptance: '- [ ] no check here' }, { acceptance: '' }]) {
    assert.ok('ok' in validateNewBead(filled(o)), JSON.stringify(o));
  }
});

test('validateNewBead: the capture rules name the field that is wrong', () => {
  assert.deepEqual(Object.keys(errs(filled({ title: '   ' }))), ['title']);
  assert.match(errs(filled({ title: 'x'.repeat(61) })).title ?? '', /60/);
  assert.deepEqual(Object.keys(errs(filled({ parent: '' }))), ['parent']);
});

test('fieldOf routes each capture and spec message to its field', () => {
  assert.equal(fieldOf(captureProblems({ title: 'x'.repeat(TITLE_MAX + 1), type: 'task', parent: 'e' })[0]!), 'title');
  assert.equal(fieldOf(captureProblems({ title: 'ok', type: 'task' })[0]!), 'parent');
  assert.equal(fieldOf(specProblems({ type: 'task', description: 'nope', acceptance: CRITERION })[0]!), 'description');
  assert.equal(fieldOf(specProblems({ type: 'task', description: STORY, acceptance: '' })[0]!), 'acceptance');
  assert.equal(fieldOf(specProblems({ type: 'task', description: STORY, acceptance: 'plain' })[0]!), 'acceptance');
});

test('the title limit is the server limit', () => {
  assert.deepEqual(captureProblems({ type: 'chore', title: 'x'.repeat(TITLE_MAX), parent: 'e' }), []);
  assert.equal(captureProblems({ type: 'chore', title: 'x'.repeat(TITLE_MAX + 1), parent: 'e' }).length, 1);
});

test('validateNewBead: epics need no parent; with no repo it is a non-code bead', () => {
  assert.ok('ok' in validateNewBead(filled({ type: 'epic', parent: '' })));
  const chore = validateNewBead(filled({ type: 'chore', description: '', acceptance: '' }));
  assert.deepEqual(chore, { ok: { title: 'Do it', type: 'chore', priority: 2, parent: 'e-1' } });
  assert.equal(NO_REPO_NOTE, 'No repo: this bead cannot start a session until one is set.');
});

test('validateNewBead: unknown types, bad priority and repo names', () => {
  assert.deepEqual(Object.keys(errs(filled({ type: 'Feature' }))), ['type']);
  assert.deepEqual(Object.keys(errs(filled({ priority: 5 }))), ['priority']);
  assert.deepEqual(Object.keys(errs(filled({ priority: 1.5 }))), ['priority']);
  for (const repo of ['a/b', 'a\\b', 'a,b', '..', 'a..b', '.']) {
    assert.deepEqual(Object.keys(errs(filled({ repos: [repo] }))), ['repos'], repo);
    assert.deepEqual(Object.keys(errs(filled({ repos: ['ok', repo] }))), ['repos'], repo);
  }
});

/* ---------- repos control ---------- */

test('toggleRepo: the first ticked is the primary; unticking it makes the next ticked primary', () => {
  let r = toggleRepo([], 'web');
  r = toggleRepo(r, 'api');
  r = toggleRepo(r, 'docs');
  assert.deepEqual(r, ['web', 'api', 'docs']);
  assert.deepEqual(toggleRepo(r, 'web'), ['api', 'docs']);
  assert.deepEqual(toggleRepo(r, 'api'), ['web', 'docs']);
});

test('makePrimary moves a ticked repo to the front and keeps the order of the rest', () => {
  assert.deepEqual(makePrimary(['web', 'api', 'docs'], 'docs'), ['docs', 'web', 'api']);
  assert.deepEqual(makePrimary(['web', 'api'], 'web'), ['web', 'api']);
  assert.deepEqual(makePrimary(['web'], 'nope'), ['web'], 'an unticked repo is not made primary');
});

test('the empty Parent option reads (none), and the bead forms hold no em dash', () => {
  assert.equal(NO_PARENT_OPTION, '(none)');
  for (const f of ['NewBead.tsx', 'EditBead.tsx']) {
    const src = readFileSync(join(import.meta.dirname, '..', 'ui', 'src', 'components', f), 'utf8');
    assert.ok(!src.includes('—'), f);
  }
});

test('filterRepos: case-insensitive match anywhere in the name; an empty filter keeps all', () => {
  const all = ['Billing', 'orders-service', 'web-orders'];
  assert.deepEqual(filterRepos(all, 'ORDER'), ['orders-service', 'web-orders']);
  assert.deepEqual(filterRepos(all, '  '), all);
  assert.deepEqual(filterRepos(all, 'zzz'), []);
});

test('validateNewBead agrees with the server rules in createBead', async () => {
  const beads = { create: async (x: unknown) => x };
  const server = async (input: object) => {
    try {
      await createBead({ beads } as never, input as never);
      return true;
    } catch {
      return false;
    }
  };
  const cases: Partial<Form>[] = [
    {}, { title: '   ' }, { title: 'x'.repeat(TITLE_MAX + 1) }, { title: 'x'.repeat(TITLE_MAX) },
    { repos: ['svc'] }, { repos: ['svc', 'docs', 'lib'] }, { repos: ['a/b'] }, { repos: ['a,b'] }, { repos: ['..'] }, { repos: ['svc', '..'] },
    { priority: 4 }, { priority: 5 },
    { description: 'nope' }, { acceptance: '- [ ] a' }, { acceptance: 'a (check: b)' }, { parent: '' },
    { type: 'epic', parent: '' }, { type: 'chore', description: '', acceptance: '' }, { type: 'decision', acceptance: '' },
  ];
  for (const c of cases) {
    const f = filled(c);
    const v = validateNewBead(f);
    const sent = 'ok' in v ? v.ok : { ...f, repo: f.repos[0], context: f.repos.slice(1), parent: f.parent || undefined };
    assert.equal('ok' in v, await server(sent), JSON.stringify(c));
  }
  for (const type of ALL_TYPES) {
    const v = validateNewBead(filled({ type }));
    assert.ok('ok' in v, type);
    assert.equal(await server(v.ok), true, type);
  }
});

test('formTouched: false for the empty form, true after any field changes', () => {
  assert.equal(formTouched(emptyForm()), false);
  assert.equal(formTouched({ ...emptyForm(), title: 'x' }), true);
  assert.equal(formTouched({ ...emptyForm(), type: 'bug' }), true);
  assert.equal(formTouched({ ...emptyForm(), priority: 1 }), true);
  assert.equal(formTouched({ ...emptyForm(), repos: ['a'] }), true);
  assert.equal(formTouched({ ...emptyForm(), parent: 'e-1' }), true);
  assert.equal(formTouched({ ...emptyForm(), description: 'a' }), true);
  assert.equal(formTouched({ ...emptyForm(), acceptance: '- [ ] x (check: y)' }), true);
});

/* ---------- drag to Specify ---------- */

const STAGES: Stage[] = ['backlog', 'specify', 'build', 'verify', 'review', 'done'];
const REFUSED: Partial<Record<Stage, string>> = {
  build: 'Build starts when you approve the spec.',
  verify: 'Verify starts when every criterion is verified.',
  review: 'Review starts when the PR is open and CI is green.',
  done: 'A bead closes when its PR merges.',
};

test('dropVerdict: Backlog to Specify starts, Specify to Backlog releases when no session is live', () => {
  assert.deepEqual(dropVerdict(card({ stage: 'backlog' }), 'specify', false), { ok: true, action: 'specify' });
  assert.deepEqual(dropVerdict(card({ stage: 'specify' }), 'backlog', false), { ok: true, action: 'release' });
});

test('dropVerdict: Specify to Backlog with a live session says to stop it first', () => {
  assert.deepEqual(dropVerdict(card({ stage: 'specify' }), 'backlog', true), { ok: false, reason: 'Stop the session first.' });
});

test('dropVerdict: every other pair is refused with the reason of its target column', () => {
  for (const from of STAGES) {
    for (const to of STAGES) {
      const pair = `${from} -> ${to}`;
      const v = dropVerdict(card({ stage: from }), to, false);
      if (from === to) {
        assert.deepEqual(v, { ok: false, reason: '' }, pair);
      } else if ((from === 'backlog' && to === 'specify') || (from === 'specify' && to === 'backlog')) {
        assert.equal(v.ok, true, pair);
      } else if (to === 'backlog' || to === 'specify') {
        // Nothing moves into Backlog or Specify by hand except the two allowed pairs.
        const reason = to === 'backlog' ? 'Only a Specify bead can go back to Backlog.' : 'Only a Backlog bead can start specifying.';
        assert.deepEqual(v, { ok: false, reason }, pair);
      } else {
        assert.deepEqual(v, { ok: false, reason: REFUSED[to]! }, pair);
      }
    }
  }
});

test('dropVerdict: a held card is refused with its own reason, except on its own column', () => {
  const held = card({ stage: 'backlog', held: true, status: 'blocked' });
  assert.deepEqual(dropVerdict(held, 'specify', false), { ok: false, reason: 'This bead is on hold.' });
  assert.deepEqual(dropVerdict(held, 'build', false), { ok: false, reason: 'This bead is on hold.' });
  assert.deepEqual(dropVerdict(held, 'backlog', false), { ok: false, reason: '' });
  const heldSpecify = card({ stage: 'specify', held: true, status: 'blocked' });
  assert.deepEqual(dropVerdict(heldSpecify, 'backlog', false), { ok: false, reason: 'This bead is on hold.' });
});

test('dropVerdict: a refusal into Backlog or Specify from another stage has a reason', () => {
  for (const from of ['build', 'verify', 'review', 'done'] as const) {
    for (const to of ['backlog', 'specify'] as const) {
      const v = dropVerdict(card({ stage: from }), to, false);
      assert.equal(v.ok, false);
      assert.ok(!v.ok && v.reason.length > 0, `${from} -> ${to}`);
    }
  }
});

test('hasBeadDrag accepts only a drag that carries the cockpit type', () => {
  assert.equal(hasBeadDrag([BEAD_DRAG_TYPE, 'text/plain']), true);
  assert.equal(hasBeadDrag(['text/plain']), false);
  assert.equal(hasBeadDrag(['Files']), false);
  assert.equal(hasBeadDrag([]), false);
});

test('AT-7 the header has the four views and no Settings or Setup tab (Settings is in File, Setup inside it)', () => {
  assert.deepEqual(HEADER_TABS, [
    ['brief', 'Brief'],
    ['board', 'Board'],
    ['epics', 'Epics'],
    ['review', 'Review queue'],
  ]);
});
