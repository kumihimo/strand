import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BeadCard, Epic } from '../src/cockpit/model.ts';
import {
  activeCount,
  applyCards,
  applyEpics,
  boardColumns,
  compareCards,
  DEFAULT_VIEW,
  epicLabel,
  isFiltering,
  matches,
  NO_EPIC,
  optionsFrom,
  parseStoredView,
  pruneView,
  truncate,
  type SortKey,
  type ViewState,
} from '../ui/src/lib/filter.ts';
import { readStoredView, removeStoredView, writeStoredView, type ViewStorage } from '../ui/src/useStoredView.ts';

const card = (o: Partial<BeadCard>): BeadCard => ({
  id: 'b-1', title: 't', type: 'task', priority: 2, status: 'open', stage: 'backlog',
  ready: false, blockedBy: [], live: false, needsYou: false, held: false, awaitingApproval: false, ciUnknown: false, labels: [], context: [], ...o,
});
const view = (o: Partial<ViewState> = {}): ViewState => ({ ...DEFAULT_VIEW, ...o });
const ids = (cs: BeadCard[]) => cs.map((c) => c.id);

/* ---------- sorting ---------- */

test('default view sorts by priority, then id', () => {
  const cs = [card({ id: 'b-3', priority: 1 }), card({ id: 'b-2', priority: 2 }), card({ id: 'b-1', priority: 2 })];
  assert.deepEqual(ids(applyCards(cs, DEFAULT_VIEW)), ['b-3', 'b-1', 'b-2']);
});

const SORT_CASES: [SortKey, BeadCard[], string[]][] = [
  ['priority', [card({ id: 'a', priority: 3 }), card({ id: 'b', priority: 0 }), card({ id: 'c', priority: 1 })], ['b', 'c', 'a']],
  ['status', [card({ id: 'a', status: 'closed' }), card({ id: 'b', status: 'in_progress' }), card({ id: 'c', status: 'deferred' }), card({ id: 'd', status: 'open' }), card({ id: 'e', status: 'blocked' })], ['b', 'd', 'e', 'c', 'a']],
  ['stage', [card({ id: 'a', stage: 'done' }), card({ id: 'b', stage: 'build' }), card({ id: 'c', stage: 'backlog' }), card({ id: 'd', stage: 'review' }), card({ id: 'e', stage: 'specify' }), card({ id: 'f', stage: 'verify' })], ['c', 'e', 'b', 'f', 'd', 'a']],
  ['type', [card({ id: 'a', type: 'task' }), card({ id: 'b', type: 'bug' }), card({ id: 'c', type: 'feature' })], ['b', 'c', 'a']],
  ['updated', [card({ id: 'a', updatedAt: '2026-03-02T10:00:00Z' }), card({ id: 'b', updatedAt: '2026-01-01T10:00:00Z' }), card({ id: 'c', updatedAt: '2026-02-01T10:00:00Z' })], ['b', 'c', 'a']],
  ['title', [card({ id: 'a', title: 'Cherry' }), card({ id: 'b', title: 'apple' }), card({ id: 'c', title: 'Banana' })], ['b', 'c', 'a']],
];

for (const [sort, cs, asc] of SORT_CASES) {
  test(`sort by ${sort}, ascending`, () => {
    assert.deepEqual(ids(applyCards(cs, view({ sort, dir: 'asc', hideClosed: false }))), asc);
  });
  test(`sort by ${sort}, descending`, () => {
    assert.deepEqual(ids(applyCards(cs, view({ sort, dir: 'desc', hideClosed: false }))), [...asc].reverse());
  });
}

test('ties fall back to priority, then id, in both directions', () => {
  const cs = [
    card({ id: 'b-3', type: 'bug', priority: 2 }),
    card({ id: 'b-2', type: 'bug', priority: 1 }),
    card({ id: 'b-1', type: 'bug', priority: 1 }),
    card({ id: 'b-4', type: 'task', priority: 0 }),
  ];
  assert.deepEqual(ids(applyCards(cs, view({ sort: 'type', dir: 'asc' }))), ['b-1', 'b-2', 'b-3', 'b-4']);
  assert.deepEqual(ids(applyCards(cs, view({ sort: 'type', dir: 'desc' }))), ['b-4', 'b-1', 'b-2', 'b-3']);
});

test('a missing updatedAt sorts last in both directions', () => {
  const cs = [card({ id: 'a' }), card({ id: 'b', updatedAt: '2026-01-01T00:00:00Z' }), card({ id: 'c', updatedAt: '2026-02-01T00:00:00Z' })];
  assert.deepEqual(ids(applyCards(cs, view({ sort: 'updated', dir: 'asc' }))), ['b', 'c', 'a']);
  assert.deepEqual(ids(applyCards(cs, view({ sort: 'updated', dir: 'desc' }))), ['c', 'b', 'a']);
});

test('an unknown status or stage value sorts after the known ones', () => {
  const cs = [card({ id: 'a', status: 'weird' }), card({ id: 'b', status: 'closed' })];
  assert.deepEqual(ids(applyCards(cs, view({ sort: 'status', hideClosed: false }))), ['b', 'a']);
});

test('applyCards returns a new array and leaves the input order alone', () => {
  const cs = [card({ id: 'b' }), card({ id: 'a' })];
  const out = applyCards(cs, DEFAULT_VIEW);
  assert.deepEqual(ids(cs), ['b', 'a']);
  assert.deepEqual(ids(out), ['a', 'b']);
  assert.notEqual(out, cs);
});

test('compareCards is a consistent order: sign flips when the arguments swap', () => {
  const a = card({ id: 'a', priority: 1 });
  const b = card({ id: 'b', priority: 2 });
  for (const dir of ['asc', 'desc'] as const) {
    const cmp = compareCards(view({ dir }));
    assert.equal(Math.sign(cmp(a, b)), -Math.sign(cmp(b, a)));
    assert.equal(cmp(a, a), 0);
  }
});

/* ---------- filtering ---------- */

const POOL = [
  card({ id: 'a-1', title: 'Login page', type: 'feature', status: 'in_progress', stage: 'build', repo: 'web', labels: ['ui', 'urgent'], parent: 'e-1', ready: true }),
  card({ id: 'a-2', title: 'Fix crash', type: 'bug', status: 'open', stage: 'backlog', repo: 'api', labels: ['urgent'], parent: 'e-2', blockedBy: ['a-1'] }),
  card({ id: 'a-3', title: 'Cleanup', type: 'chore', status: 'open', stage: 'specify', repo: 'web', labels: [] }),
  card({ id: 'a-4', title: 'Docs', type: 'feature', status: 'blocked', stage: 'build', labels: ['ui'], parent: 'e-1', held: true }),
];
const only = (v: Partial<ViewState>) => ids(POOL.filter((c) => matches(c, view(v))));

test('each filter alone', () => {
  assert.deepEqual(only({ status: ['open'] }), ['a-2', 'a-3']);
  assert.deepEqual(only({ status: ['open', 'blocked'] }), ['a-2', 'a-3', 'a-4']);
  assert.deepEqual(only({ stage: ['build'] }), ['a-1', 'a-4']);
  assert.deepEqual(only({ type: ['feature'] }), ['a-1', 'a-4']);
  assert.deepEqual(only({ repo: ['web'] }), ['a-1', 'a-3']);
  assert.deepEqual(only({ epic: 'e-1' }), ['a-1', 'a-4']);
  assert.deepEqual(only({ epic: NO_EPIC }), ['a-3']);
  assert.deepEqual(only({ ready: true }), ['a-1']);
  assert.deepEqual(only({ blocked: true }), ['a-2', 'a-4']);
  assert.deepEqual(only({ text: 'crash' }), ['a-2']);
});

test('labels combine with AND', () => {
  assert.deepEqual(only({ label: ['ui'] }), ['a-1', 'a-4']);
  assert.deepEqual(only({ label: ['ui', 'urgent'] }), ['a-1']);
});

test('two filters combine with AND', () => {
  assert.deepEqual(only({ type: ['feature'], repo: ['web'] }), ['a-1']);
  assert.deepEqual(only({ stage: ['build'], blocked: true }), ['a-4']);
});

test('text matches id and title, case-insensitively', () => {
  assert.deepEqual(only({ text: 'LOGIN' }), ['a-1']);
  assert.deepEqual(only({ text: 'A-3' }), ['a-3']);
  assert.deepEqual(only({ text: '  clean ' }), ['a-3']);
});

test('ready and blocked together match nothing', () => {
  assert.deepEqual(only({ ready: true, blocked: true }), []);
});

test('isFiltering', () => {
  assert.equal(isFiltering(DEFAULT_VIEW), false);
  assert.equal(isFiltering(view({ sort: 'title', dir: 'desc', hideEmptyEpics: false })), false);
  assert.equal(isFiltering(view({ text: '   ' })), false);
  for (const v of [{ status: ['open'] }, { stage: ['build'] }, { type: ['bug'] }, { repo: ['x'] }, { label: ['x'] }, { epic: NO_EPIC }, { ready: true }, { blocked: true }, { text: 'x' }]) {
    assert.equal(isFiltering(view(v)), true, JSON.stringify(v));
  }
});

/* ---------- board columns ---------- */

test('boardColumns: seven columns in board order with totals and shown counts', () => {
  const cols = boardColumns(POOL, view({ type: ['feature'] }));
  assert.deepEqual(cols.map((c) => c.stage), ['backlog', 'queued', 'specify', 'build', 'verify', 'review', 'done']);
  const by = Object.fromEntries(cols.map((c) => [c.stage, [c.shown.length, c.total]]));
  assert.deepEqual(by, { backlog: [0, 1], queued: [0, 0], specify: [0, 1], build: [2, 2], verify: [0, 0], review: [0, 0], done: [0, 0] });
});

test('boardColumns sorts inside each column', () => {
  const cols = boardColumns(POOL, view({ sort: 'title', dir: 'desc' }));
  assert.deepEqual(ids(cols.find((c) => c.stage === 'build')!.shown), ['a-1', 'a-4']);
});

test('boardColumns with the default view is every card, by priority then id', () => {
  const cols = boardColumns(POOL, DEFAULT_VIEW);
  assert.equal(cols.reduce((n, c) => n + c.shown.length, 0), POOL.length);
  assert.ok(cols.every((c) => c.shown.length === c.total));
});

/* ---------- epics ---------- */

const epic = (id: string, children: BeadCard[]): Epic => ({
  id, title: id, priority: 1, counts: { closed: 0, inProgress: 0, ready: 0, blocked: 0 }, children,
});
const EPICS = [epic('e-1', [POOL[0]!, POOL[3]!]), epic('e-2', [POOL[1]!]), epic('e-3', [])];

test('applyEpics filters and sorts the children', () => {
  const out = applyEpics(EPICS, view({ type: ['feature'], sort: 'title', dir: 'desc' }));
  assert.deepEqual(out.map((e) => e.id), ['e-1']);
  assert.deepEqual(ids(out[0]!.children), ['a-1', 'a-4']);
});

test('applyEpics hides empty epics only while filtering', () => {
  assert.deepEqual(applyEpics(EPICS, DEFAULT_VIEW).map((e) => e.id), ['e-1', 'e-2', 'e-3']);
  assert.deepEqual(applyEpics(EPICS, view({ text: 'zzz' })).map((e) => e.id), []);
});

test('applyEpics keeps empty epics when the toggle is off', () => {
  const out = applyEpics(EPICS, view({ text: 'crash', hideEmptyEpics: false }));
  assert.deepEqual(out.map((e) => e.id), ['e-1', 'e-2', 'e-3']);
  assert.deepEqual(ids(out[0]!.children), []);
  assert.deepEqual(ids(out[1]!.children), ['a-2']);
});

test('applyEpics does not change the input', () => {
  applyEpics(EPICS, view({ text: 'crash' }));
  assert.equal(EPICS[0]!.children.length, 2);
});

/* ---------- options and stored views ---------- */

test('optionsFrom lists values from the cards, sorted, without repeats', () => {
  assert.deepEqual(optionsFrom(POOL), {
    types: ['bug', 'chore', 'feature'],
    repos: ['api', 'web'],
    labels: ['ui', 'urgent'],
    epics: ['e-1', 'e-2'],
    epicTitles: {},
  });
  assert.deepEqual(optionsFrom([]), { types: [], repos: [], labels: [], epics: [], epicTitles: {} });
});

test('parseStoredView: null, bad JSON and wrong shapes give defaults', () => {
  assert.deepEqual(parseStoredView(null), DEFAULT_VIEW);
  assert.deepEqual(parseStoredView('{not json'), DEFAULT_VIEW);
  assert.deepEqual(parseStoredView('42'), DEFAULT_VIEW);
  assert.deepEqual(parseStoredView('[1,2]'), DEFAULT_VIEW);
  assert.deepEqual(parseStoredView('null'), DEFAULT_VIEW);
});

test('parseStoredView: unknown sort key or direction falls back, the rest is kept', () => {
  const v = parseStoredView(JSON.stringify({ sort: 'colour', dir: 'sideways', type: ['bug'], ready: true }));
  assert.equal(v.sort, 'priority');
  assert.equal(v.dir, 'asc');
  assert.deepEqual(v.type, ['bug']);
  assert.equal(v.ready, true);
});

test('parseStoredView: wrong field types fall back per field', () => {
  const v = parseStoredView(JSON.stringify({ type: 'bug', repo: [1, 'web'], text: 5, ready: 'yes', hideEmptyEpics: false }));
  assert.deepEqual(v.type, []);
  assert.deepEqual(v.repo, ['web']);
  assert.equal(v.text, '');
  assert.equal(v.ready, false);
  assert.equal(v.hideEmptyEpics, false);
});

test('parseStoredView: a round trip keeps a full view', () => {
  const full = view({ sort: 'updated', dir: 'desc', status: ['open'], stage: ['build'], type: ['bug'], repo: ['web'], label: ['ui'], epic: 'e-1', ready: true, blocked: false, text: 'x', hideEmptyEpics: false });
  assert.deepEqual(parseStoredView(JSON.stringify(full)), full);
});

test('parseStoredView: values missing from the options are dropped', () => {
  const raw = JSON.stringify({ repo: ['web', 'gone'], label: ['ui', 'old'], type: ['bug', 'dead'], epic: 'e-9', status: ['open', 'nope'], stage: ['build', 'nope'] });
  const v = parseStoredView(raw, optionsFrom(POOL));
  assert.deepEqual(v.repo, ['web']);
  assert.deepEqual(v.label, ['ui']);
  assert.deepEqual(v.type, ['bug']);
  assert.equal(v.epic, undefined);
  assert.deepEqual(v.status, ['open']);
  assert.deepEqual(v.stage, ['build']);
});

test('pruneView keeps a live epic and the none value, and returns the same object when nothing is dead', () => {
  const o = optionsFrom(POOL);
  assert.equal(pruneView(view({ epic: 'e-1' }), o).epic, 'e-1');
  assert.equal(pruneView(view({ epic: NO_EPIC }), o).epic, NO_EPIC);
  const clean = view({ repo: ['web'] });
  assert.equal(pruneView(clean, o), clean);
});

/* ---------- speed ---------- */

test('500 cards with a sort and three filters finish well under a second (budget 250 ms)', () => {
  const types = ['bug', 'task', 'feature', 'chore'];
  const many = Array.from({ length: 500 }, (_, i) =>
    card({
      id: `x-${i}`, title: `Card number ${i}`, type: types[i % 4]!, priority: i % 5, status: i % 3 ? 'open' : 'in_progress',
      stage: (['backlog', 'specify', 'build', 'verify', 'review', 'done'] as const)[i % 6]!, repo: i % 2 ? 'web' : 'api',
      labels: i % 7 ? ['a'] : ['a', 'b'], updatedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    }),
  );
  const v = view({ sort: 'updated', dir: 'desc', type: ['bug', 'task'], repo: ['web'], label: ['a'] });
  applyCards(many, v); // warm up
  const t0 = performance.now();
  const out = applyCards(many, v);
  boardColumns(many, v);
  const ms = performance.now() - t0;
  assert.ok(out.length > 0);
  assert.ok(ms < 250, `took ${ms.toFixed(1)} ms`);
});

/* ---------- active count, epic labels, board order ---------- */

test('activeCount: one per filter group, sort and the epics toggle do not count', () => {
  assert.equal(activeCount(DEFAULT_VIEW), 0);
  assert.equal(activeCount(view({ sort: 'title', dir: 'desc', hideEmptyEpics: false })), 0);
  assert.equal(activeCount(view({ status: ['open', 'blocked', 'closed'] })), 1);
  assert.equal(activeCount(view({ type: ['bug'], repo: ['web'], label: ['ui'] })), 3);
  assert.equal(activeCount(view({ epic: NO_EPIC, ready: true, blocked: true, text: 'x' })), 4);
  assert.equal(activeCount(view({ text: '   ' })), 0);
});

test('truncate cuts at the limit with an ellipsis and leaves short text alone', () => {
  assert.equal(truncate('short'), 'short');
  assert.equal(truncate('x'.repeat(40)), 'x'.repeat(40));
  const cut = truncate('y'.repeat(60));
  assert.equal(cut.length, 40);
  assert.ok(cut.endsWith('…'));
});

test('optionsFrom gives epic titles from the epic cards, and epicLabel uses them', () => {
  const cards = [card({ id: 'e-1', title: 'Auth rework', type: 'epic' }), card({ id: 'a-1', parent: 'e-1' }), card({ id: 'a-2', parent: 'e-9' })];
  const o = optionsFrom(cards);
  assert.deepEqual(o.epics, ['e-1', 'e-9']);
  assert.deepEqual(o.epicTitles, { 'e-1': 'Auth rework' });
  assert.equal(epicLabel('e-1', o.epicTitles), 'e-1 Auth rework');
  assert.equal(epicLabel('e-9', o.epicTitles), 'e-9');
  assert.equal(epicLabel('constructor', o.epicTitles), 'constructor');
});

test('boardColumns with the default view keeps the order columnsFor gives, and desc priority reverses it', () => {
  const cs = [card({ id: 'b-2', priority: 1 }), card({ id: 'b-1', priority: 1 }), card({ id: 'b-3', priority: 0 })];
  assert.deepEqual(ids(boardColumns(cs, DEFAULT_VIEW)[0]!.shown), ['b-3', 'b-1', 'b-2']);
  assert.deepEqual(ids(boardColumns(cs, view({ dir: 'desc' }))[0]!.shown), ['b-1', 'b-2', 'b-3']);
});

/* ---------- storage that fails ---------- */

const throwing: ViewStorage = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
  removeItem: () => { throw new Error('blocked'); },
};

function memory(): ViewStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

test('storage that throws on get gives the default view', () => {
  assert.deepEqual(readStoredView('k', throwing), DEFAULT_VIEW);
});

test('storage that throws on set or remove does not throw', () => {
  assert.doesNotThrow(() => writeStoredView('k', view({ ready: true }), throwing));
  assert.doesNotThrow(() => removeStoredView('k', throwing));
});

test('with no localStorage at all, reads give defaults and writes do nothing', (t) => {
  // A Node with a global localStorage gets it hidden for this test, so the test does not depend on the Node version.
  const g = globalThis as { localStorage?: unknown };
  const had = Object.getOwnPropertyDescriptor(g, 'localStorage');
  Object.defineProperty(g, 'localStorage', { value: undefined, configurable: true, writable: true });
  t.after(() => (had ? Object.defineProperty(g, 'localStorage', had) : delete g.localStorage));
  assert.equal(typeof g.localStorage, 'undefined');
  assert.deepEqual(readStoredView('k'), DEFAULT_VIEW);
  assert.doesNotThrow(() => writeStoredView('k', view({ ready: true })));
  assert.doesNotThrow(() => removeStoredView('k'));
});

test('storage round trip: write, read, remove', () => {
  const s = memory();
  const v = view({ sort: 'title', repo: ['web'] });
  writeStoredView('k', v, s);
  assert.deepEqual(readStoredView('k', s), v);
  removeStoredView('k', s);
  assert.deepEqual(readStoredView('k', s), DEFAULT_VIEW);
});

test('a stored value that is not JSON gives the default view', () => {
  const s = memory();
  s.setItem('k', '{broken');
  assert.deepEqual(readStoredView('k', s), DEFAULT_VIEW);
});

/* ---------- hide closed ---------- */

const OPEN = card({ id: 'o-1', status: 'open', stage: 'build' });
const CLOSED = card({ id: 'c-1', status: 'closed', stage: 'done' });
const DONE_ONLY = card({ id: 'c-2', status: 'in_progress', stage: 'done' });

test('AT-1: a missing or old stored view hides closed beads', () => {
  assert.equal(DEFAULT_VIEW.hideClosed, true);
  assert.equal(parseStoredView(null).hideClosed, true);
  assert.equal(parseStoredView(JSON.stringify({ sort: 'title' })).hideClosed, true);
  assert.equal(parseStoredView(JSON.stringify({ hideClosed: 'no' })).hideClosed, true);
  assert.deepEqual(ids(applyCards([OPEN, CLOSED, DONE_ONLY], parseStoredView(null))), ['o-1']);
});

test('AT-1: a stored hideClosed false is kept', () => {
  assert.equal(parseStoredView(JSON.stringify({ hideClosed: false })).hideClosed, false);
});

test('AT-2: with hideClosed off, closed cards match', () => {
  assert.deepEqual(ids(applyCards([OPEN, CLOSED, DONE_ONLY], view({ hideClosed: false }))), ['c-1', 'c-2', 'o-1']);
});

test('AT-3: hideClosed is not a filter, on or off', () => {
  for (const hideClosed of [true, false]) {
    assert.equal(isFiltering(view({ hideClosed })), false);
    assert.equal(activeCount(view({ hideClosed })), 0);
  }
});

test('AT-4: Status closed or Stage Done ticked shows closed cards while hideClosed is on', () => {
  assert.deepEqual(ids(applyCards([OPEN, CLOSED, DONE_ONLY], view({ status: ['closed'] }))), ['c-1']);
  assert.deepEqual(ids(applyCards([OPEN, CLOSED, DONE_ONLY], view({ stage: ['done'] }))), ['c-1', 'c-2']);
  assert.deepEqual(ids(applyCards([OPEN, CLOSED], view({ status: ['open', 'closed'] }))), ['c-1', 'o-1']);
  // The other filters still apply.
  assert.deepEqual(ids(applyCards([CLOSED, card({ id: 'c-3', status: 'closed', stage: 'done', type: 'bug' })], view({ status: ['closed'], type: ['bug'] }))), ['c-3']);
});

test('boardColumns with hideClosed: Done shows nothing, its total counts every closed card', () => {
  const done = boardColumns([OPEN, CLOSED], DEFAULT_VIEW).find((c) => c.stage === 'done')!;
  assert.deepEqual([done.shown.length, done.total], [0, 1]);
});

test('applyEpics with hideClosed drops closed children and keeps the counts', () => {
  const e: Epic = { id: 'e-9', title: 'E', priority: 1, children: [OPEN, CLOSED], counts: { closed: 1, inProgress: 0, ready: 0, blocked: 0 } };
  const [out] = applyEpics([e], DEFAULT_VIEW);
  assert.deepEqual(ids(out!.children), ['o-1']);
  assert.deepEqual(out!.counts, e.counts);
});
