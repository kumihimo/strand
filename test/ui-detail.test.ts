import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMNS,
  approveState,
  criteriaRows,
  prRef,
  requestChangesProblem,
  defaultPreview,
  formatSize,
  isDocType,
  newestFirst,
  openResultText,
  previewKind,
  relationGroups,
  clampText,
  RELATION_LIMIT,
  DESCRIPTION_LINES,
  DESIGN_LINES,
  draftChanges,
  draftProblems,
  editDraft,
  editableAcceptance,
  editableCriteria,
  hasProseLines,
  acceptResult,
  conflictSentence,
  freshnessOutcome,
  droppedCriteria,
  rebase,
  shouldRefetch,
  unionFields,
  resolveReason,
  saveAndApproveState,
  staleLines,
} from '../ui/src/lib/detail.ts';
import { columnsFor } from '../ui/src/lib/format.ts';
import { makePrimary, toggleRepo } from '../ui/src/lib/views.ts';
import { staleFrom } from '../ui/src/api.ts';
import type { ArtefactFile, BeadDetail, Relations } from '../src/cockpit/model.ts';
import type { Criterion } from '../src/core/facts.ts';

const file = (o: Partial<ArtefactFile>): ArtefactFile => ({ name: 'x', relPath: 'x', size: 1, kind: 'other', ...o });

test('COLUMNS match columnsFor keys, with WIP on Build and Review only', () => {
  assert.deepEqual(COLUMNS.map((c) => c.key), Object.keys(columnsFor([])));
  assert.deepEqual(COLUMNS.filter((c) => c.wip).map((c) => c.wip), ['build', 'review']);
});

test('isDocType marks document playbooks and ADRs, not code work', () => {
  assert.ok(isDocType('rfc') && isDocType('decision') && isDocType('dpia'));
  assert.ok(!isDocType('feature') && !isDocType('bug') && !isDocType('incident'));
});

const crit = (o: Partial<Criterion>): Criterion => ({ text: 't', ticked: false, ...o });

test('approveState: shown only in specify, disabled with every reason when the spec rules are not met', () => {
  assert.deepEqual(approveState({ stage: 'specify', specProblems: [] }), { show: true, disabled: false, reasons: [] });
  const problems = ['description must open "As <role>, I want ..., so that ..."', '2 acceptance lines are not in the form "- [ ] <text> (check: <command>)"'];
  assert.deepEqual(approveState({ stage: 'specify', specProblems: problems }), { show: true, disabled: true, reasons: problems });
  for (const stage of ['backlog', 'build', 'verify', 'review', 'done'] as const) {
    assert.equal(approveState({ stage, specProblems: [] }).show, false, stage);
  }
});

test('criteriaRows: verified needs a tick and evidence; a tick alone is flagged', () => {
  const rows = criteriaRows([
    crit({ text: 'a', ticked: true, check: 'npm test', evidence: 'passed' }),
    crit({ text: 'b', ticked: true }),
    crit({ text: 'c', check: 'make lint' }),
    crit({ text: 'd' }),
  ]);
  assert.deepEqual(rows.map((r) => [r.text, r.state]), [['a', 'verified'], ['b', 'unverified'], ['c', 'open'], ['d', 'open']]);
  assert.equal(rows[0].check, 'npm test');
  assert.equal(rows[0].evidence, 'passed');
  assert.equal(rows[3].check, undefined);
});

test('criteriaRows: empty evidence is not evidence', () => {
  const rows = criteriaRows([crit({ text: 'a', ticked: true, evidence: '' })]);
  assert.equal(rows[0].state, 'unverified');
  assert.equal(rows[0].evidence, undefined);
});

test('prRef: owner/repo#n, with the url when the server has one', () => {
  assert.deepEqual(prRef({ owner: 'me', repo: 'svc', number: 7 }), { text: 'me/svc#7' });
  assert.deepEqual(prRef({ owner: 'me', repo: 'svc', number: 7, url: 'https://g.example/me/svc/pulls/7' }), {
    text: 'me/svc#7',
    url: 'https://g.example/me/svc/pulls/7',
  });
});

test('requestChangesProblem: 1 to 2000 characters, blanks do not count', () => {
  assert.equal(requestChangesProblem('Add a scenario for empty files'), undefined);
  assert.equal(requestChangesProblem('x'.repeat(2000)), undefined);
  assert.match(requestChangesProblem('   ') ?? '', /Write what needs to change/);
  assert.match(requestChangesProblem('x'.repeat(2001)) ?? '', /2000/);
});

test('newestFirst sorts by created_at descending without mutating', () => {
  const cs = [
    { id: '1', author: 'a', text: 'old', created_at: '2026-11-01T10:00:00Z' },
    { id: '2', author: 'a', text: 'new', created_at: '2026-11-02T10:00:00Z' },
  ];
  assert.deepEqual(newestFirst(cs).map((c) => c.text), ['new', 'old']);
  assert.equal(cs[0].text, 'old');
});

test('formatSize', () => {
  assert.equal(formatSize(12), '12 B');
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB');
});

test('previewKind and defaultPreview', () => {
  assert.equal(previewKind({ kind: 'image' }), 'image');
  assert.equal(previewKind({ kind: 'svg' }), 'image');
  assert.equal(previewKind({ kind: 'html' }), 'html');
  assert.equal(previewKind({ kind: 'pdf' }), undefined);
  const a = { kept: [file({ name: 'a.pdf', kind: 'pdf' })], scratch: [file({ name: 'v1.html', kind: 'html' })], transcripts: [] };
  assert.equal(defaultPreview(a)?.name, 'v1.html');
  assert.equal(defaultPreview({ kept: [], scratch: [], transcripts: [] }), undefined);
});

test('openResultText reports a dry run with the target', () => {
  assert.equal(openResultText({ ok: true, dryRun: true, target: '/w/a.html' }, 'a.html'), 'Would open /w/a.html');
  assert.equal(openResultText({ ok: true }, 'a.html'), 'Opened a.html');
  assert.equal(openResultText(undefined, 'a.html'), 'Opened a.html');
});

const ACCEPT = '- [x] Plans list (check: npm test) (verified: 12 passed)\n- [ ] Unknown plan 404s (check: make test)\n- [ ] No check here';
const detail = (o: Partial<BeadDetail> = {}): BeadDetail =>
  ({
    id: 'b-1',
    title: 'Plans',
    type: 'feature',
    priority: 2,
    stage: 'specify',
    parent: 'e-1',
    description: 'As a dev, I want plans, so that I ship.',
    design: 'Use a list.',
    acceptance: ACCEPT,
    version: 'v1',
    editable: true,
    criteria: [],
    context: [],
    ...o,
  }) as unknown as BeadDetail;
const APPROVED_AT = '2026-11-01T10:00:00.000Z';

test('editableCriteria strips ticks and evidence and keeps checks', () => {
  assert.equal(
    editableCriteria(ACCEPT),
    '- [ ] Plans list (check: npm test)\n- [ ] Unknown plan 404s (check: make test)\n- [ ] No check here',
  );
  assert.equal(editableCriteria(undefined), '');
  assert.equal(editableCriteria('just prose'), '');
});

test('hasProseLines is true only when stored text has non-criterion lines', () => {
  assert.equal(hasProseLines(ACCEPT), false);
  assert.equal(hasProseLines(undefined), false);
  assert.equal(hasProseLines('Do the thing\n- [ ] a (check: b)'), true);
});

test('draftChanges is empty for an untouched draft, even with prose in the stored acceptance', () => {
  assert.deepEqual(draftChanges(detail(), editDraft(detail())), {});
  const old = detail({ acceptance: 'Old chore text\n- [ ] a (check: b)', planApprovedAt: APPROVED_AT });
  assert.deepEqual(draftChanges(old, editDraft(old)), {});
  const fresh = detail({ acceptance: 'Old chore text\n- [ ] a (check: b)' });
  assert.deepEqual(draftChanges(fresh, editDraft(fresh)), {});
});

test('editDraft: before approval the acceptance text is free text with prose kept; after approval criteria only', () => {
  const text = 'Notes\n- [x] a (check: b) (verified: ok)\nit should be fast';
  assert.equal(editDraft(detail({ acceptance: text })).acceptance, 'Notes\n- [ ] a (check: b)\nit should be fast');
  assert.equal(editDraft(detail({ acceptance: text, planApprovedAt: APPROVED_AT })).acceptance, '- [ ] a (check: b)');
  assert.equal(editableAcceptance(detail({ acceptance: text })), 'Notes\n- [ ] a (check: b)\nit should be fast');
});

test('editDraft and draftChanges: repos are the primary then the context folders, sent as one set', () => {
  const d = detail({ repo: 'app', context: ['docs'] });
  assert.deepEqual(editDraft(d).repos, ['app', 'docs']);
  assert.deepEqual(draftChanges(d, editDraft(d)), {});
  assert.deepEqual(draftChanges(d, { ...editDraft(d), repos: ['app', 'docs', 'lib'] }), { repo: 'app', context: ['docs', 'lib'] });
  assert.deepEqual(draftChanges(d, { ...editDraft(d), repos: [] }), { repo: '', context: [] });
  assert.deepEqual(editDraft(detail()).repos, []);
});

test('draftChanges lists only the fields that differ', () => {
  const d = detail();
  const draft = { ...editDraft(d), title: 'Plans v2', priority: 1 };
  assert.deepEqual(draftChanges(d, draft), { title: 'Plans v2', priority: 1 });
  const crit = { ...editDraft(d), acceptance: '- [ ] Only one (check: x)' };
  assert.deepEqual(draftChanges(d, crit), { acceptance: '- [ ] Only one (check: x)' });
});

test('draftChanges sends a parent only when it is set and different', () => {
  const d = detail();
  assert.deepEqual(draftChanges(d, { ...editDraft(d), parent: 'e-2' }), { parent: 'e-2' });
  assert.deepEqual(draftChanges(detail({ parent: undefined }), { ...editDraft(detail({ parent: undefined })) }), {});
});

test('draftProblems after approval maps the spec rules to fields and flags stray criterion lines', () => {
  const d = detail({ acceptance: '- [ ] a (check: b)', planApprovedAt: APPROVED_AT });
  assert.deepEqual(draftProblems(d, editDraft(d)), {});
  assert.match(draftProblems(d, { ...editDraft(d), title: 'x'.repeat(61) }).title ?? '', /60/);
  assert.match(draftProblems(d, { ...editDraft(d), description: 'plans' }).description ?? '', /As <role>/);
  assert.match(draftProblems(d, { ...editDraft(d), acceptance: '- [ ] no check' }).acceptance ?? '', /check/);
  assert.match(draftProblems(d, { ...editDraft(d), acceptance: '- [] bad (check: x)' }).acceptance ?? '', /must start/);
  assert.match(draftProblems(d, { ...editDraft(d), acceptance: '' }).acceptance ?? '', /at least one/);
  assert.match(draftProblems(d, { ...editDraft(d), parent: '' }).parent ?? '', /parent/);
});

test('draftProblems before approval checks only the title and parent', () => {
  const d = detail({ acceptance: '- [ ] a (check: b)' });
  for (const o of [{ description: 'plans' }, { acceptance: '- [ ] no check' }, { acceptance: 'it is fast' }, { acceptance: '' }]) {
    assert.deepEqual(draftProblems(d, { ...editDraft(d), ...o }), {}, JSON.stringify(o));
  }
  assert.match(draftProblems(d, { ...editDraft(d), title: 'x'.repeat(61) }).title ?? '', /60/);
  assert.match(draftProblems(d, { ...editDraft(d), title: ' ' }).title ?? '', /required/);
  assert.match(draftProblems(d, { ...editDraft(d), parent: '' }).parent ?? '', /parent/);
});

test('a bead with context folders and no primary: no primary in the draft, and a repo change needs one', () => {
  const d = detail({ repo: undefined, context: ['docs', 'lib'] });
  assert.deepEqual(editDraft(d).repos, ['', 'docs', 'lib']);
  assert.deepEqual(draftProblems(d, editDraft(d)), {}, 'unchanged is fine');
  const ticked = { ...editDraft(d), repos: toggleRepo(editDraft(d).repos, 'web') };
  assert.equal(draftProblems(d, ticked).repos, 'Make one repo the primary before saving: context folders need a primary repo.');
  const fixed = { ...ticked, repos: makePrimary(ticked.repos, 'web') };
  assert.deepEqual(fixed.repos, ['web', 'docs', 'lib']);
  assert.deepEqual(draftProblems(d, fixed), {});
  assert.deepEqual(draftChanges(d, fixed), { repo: 'web', context: ['docs', 'lib'] });
  assert.deepEqual(toggleRepo(toggleRepo(['', 'docs'], 'docs'), 'x'), ['x'], 'unticking the last context folder leaves no marker');
});

test('draftProblems: a primary repo change on a bead with a branch is refused; context changes are fine', () => {
  const d = detail({ repo: 'app', context: [], branch: 'ada/x' });
  assert.equal(draftProblems(d, { ...editDraft(d), repos: ['web'] }).repos, 'This bead has a branch in app, so its primary repo cannot change.');
  assert.equal(draftProblems(d, { ...editDraft(d), repos: [] }).repos, 'This bead has a branch in app, so its primary repo cannot change.');
  assert.deepEqual(draftProblems(d, { ...editDraft(d), repos: ['app', 'docs'] }), {});
  assert.deepEqual(draftProblems(detail({ repo: 'app', context: [] }), { ...editDraft(d), repos: ['web'] }), {});
});

test('draftProblems on an approved bead ticked in the skill format: other edits pass; the spec rules run on spec fields only', () => {
  const ticked = '- [x] One (verified: npm test passed)\n- [x] Two (verified: make lint passed)';
  const d = detail({ acceptance: ticked, planApprovedAt: APPROVED_AT, description: 'As a dev, I want x, so that y' });
  assert.deepEqual(draftProblems(d, editDraft(d)), {});
  assert.deepEqual(draftProblems(d, { ...editDraft(d), priority: 0 }), {});
  assert.deepEqual(draftProblems(d, { ...editDraft(d), title: 'Renamed', design: 'More' }), {});
  assert.deepEqual(draftProblems(d, { ...editDraft(d), description: 'As a dev, I want z, so that y' }), {});
  // A bad story is still caught when the description is edited.
  assert.match(draftProblems(d, { ...editDraft(d), description: 'plans' }).description ?? '', /As <role>/);
  // An older spec that breaks a rule does not hold back a priority edit.
  const old = detail({ acceptance: '- [ ] a (check: b)', planApprovedAt: APPROVED_AT, description: 'no story' });
  assert.deepEqual(draftProblems(old, { ...editDraft(old), priority: 0 }), {});
});

test('draftProblems judges edited criteria as the server merges them: old ticked lines keep their evidence', () => {
  const ticked = '- [x] One (verified: npm test passed)\n- [x] Two (verified: make lint passed)';
  const d = detail({ acceptance: ticked, planApprovedAt: APPROVED_AT, description: 'As a dev, I want x, so that y' });
  // The form shows `- [ ] One` and `- [ ] Two`; the user adds a third line with a check.
  const added = { ...editDraft(d), acceptance: `${editDraft(d).acceptance}\n- [ ] Three (check: npm test)` };
  assert.deepEqual(draftProblems(d, added), {});
  // A new line still needs a check, and so does a reworded old one.
  assert.match(draftProblems(d, { ...editDraft(d), acceptance: '- [ ] One\n- [ ] Two\n- [ ] Three' }).acceptance ?? '', /check/);
  assert.match(draftProblems(d, { ...editDraft(d), acceptance: '- [ ] One reworded\n- [ ] Two' }).acceptance ?? '', /check/);
});

test('draftProblems does not judge an untouched acceptance field with prose in the stored text', () => {
  const old = detail({ type: 'chore', acceptance: 'Old chore text', description: '', parent: 'e-1', planApprovedAt: APPROVED_AT });
  assert.deepEqual(draftProblems(old, editDraft(old)), {});
});

test('saveAndApproveState: enabled in specify when the draft meets the spec rules, else says why', () => {
  const d = detail();
  assert.equal(saveAndApproveState(d, editDraft(d)).enabled, false, 'ACCEPT has a criterion without a check');
  const good = { ...editDraft(d), acceptance: '- [ ] a (check: b)' };
  assert.deepEqual(saveAndApproveState(d, good), { enabled: true });
  assert.equal(saveAndApproveState(d, { ...editDraft(d), acceptance: '' }).enabled, false);
  assert.match(saveAndApproveState(d, { ...editDraft(d), acceptance: '' }).reason ?? '', /criterion/);
  assert.match(saveAndApproveState(d, { ...good, acceptance: 'it is fast' }).reason ?? '', /1 acceptance line is not in the form/);
  const build = saveAndApproveState(detail({ stage: 'build' }), editDraft(detail()));
  assert.equal(build.enabled, false);
  assert.match(build.reason ?? '', /Specify/);
});

const A = { title: 'A', description: 'D1', acceptance: '- [ ] one (check: c1)\n- [ ] two (check: c2)', design: 'S' };
const at = (o: Partial<BeadDetail>) => detail({ ...A, version: 'v1', ...o });

test('rebase: server-only change is taken, both-sides change is a conflict, user draft kept', () => {
  const base = at({});
  const draft = { ...editDraft(base), description: 'D2' };
  const current = at({ title: 'B', description: 'D3', version: 'v2' });
  const r = rebase(base, current, draft);
  assert.deepEqual(r.taken, ['title']);
  assert.deepEqual(r.conflicts, [{ field: 'description', mine: 'D2', theirs: 'D3' }]);
  assert.equal(r.draft.title, 'B');
  assert.equal(r.draft.description, 'D2');
  assert.equal(r.base, current);
  // The next save sends only what still differs from the new base.
  assert.deepEqual(draftChanges(r.base, r.draft), { description: 'D2' });
});

test('rebase: a field the user touched and the server did not change keeps the user value, no conflict', () => {
  const base = at({});
  const r = rebase(base, at({ version: 'v2' }), { ...editDraft(base), design: 'S2' });
  assert.deepEqual(r.taken, []);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.draft.design, 'S2');
});

test('rebase: criteria reworded by the user and extended and ticked by the server is one conflict holding all lines', () => {
  const base = at({});
  const draft = { ...editDraft(base), acceptance: '- [ ] one reworded (check: c1)\n- [ ] two (check: c2)' };
  const current = at({
    acceptance: '- [ ] one (check: c1)\n- [x] two (check: c2) (verified: ok)\n- [ ] three (check: c3)',
    version: 'v2',
  });
  const r = rebase(base, current, draft);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].field, 'acceptance');
  assert.equal(r.conflicts[0].theirs, '- [ ] one (check: c1)\n- [ ] two (check: c2)\n- [ ] three (check: c3)');
  assert.equal(r.conflicts[0].mine, draft.acceptance);
});

test('rebase: ticks alone changing is not a change to the criteria text', () => {
  const base = at({});
  const r = rebase(base, at({ acceptance: '- [x] one (check: c1) (verified: y)\n- [ ] two (check: c2)', version: 'v2' }), editDraft(base));
  assert.deepEqual(r.taken, []);
  assert.deepEqual(r.conflicts, []);
});

test('rebase: both sides making the same change is not a conflict', () => {
  const base = at({});
  const r = rebase(base, at({ title: 'Same', version: 'v2' }), { ...editDraft(base), title: 'Same' });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.taken, []);
  assert.deepEqual(draftChanges(r.base, r.draft), {});
});

test('rebase: a second 409 keeps open conflicts and resolved choices that still apply', () => {
  const base = at({});
  const draft = { ...editDraft(base), description: 'D2', design: 'S2' };
  const c1 = at({ description: 'D3', design: 'S3', version: 'v2' });
  const r1 = rebase(base, c1, draft);
  assert.deepEqual(r1.conflicts.map((c) => c.field), ['description', 'design']);
  // The user resolves design by keeping their text; description stays open. Then the server moves again (title only).
  const open = r1.conflicts.filter((c) => c.field === 'description');
  const c2 = at({ description: 'D3', design: 'S3', title: 'T2', version: 'v3' });
  const r2 = rebase(r1.base, c2, r1.draft, open);
  assert.deepEqual(r2.conflicts, [{ field: 'description', mine: 'D2', theirs: 'D3' }]);
  assert.deepEqual(r2.taken, ['title']);
  assert.equal(r2.draft.design, 'S2');
  assert.equal(r2.draft.title, 'T2');
  // The server changing the open field again updates what "theirs" shows.
  const r3 = rebase(r2.base, at({ description: 'D4', design: 'S3', title: 'T2', version: 'v4' }), r2.draft, r2.conflicts);
  assert.deepEqual(r3.conflicts, [{ field: 'description', mine: 'D2', theirs: 'D4' }]);
  // If the server now matches the user, the open conflict goes away.
  const r4 = rebase(r3.base, at({ description: 'D2', design: 'S3', title: 'T2', version: 'v5' }), r3.draft, r3.conflicts);
  assert.deepEqual(r4.conflicts, []);
});

test('staleLines and resolveReason', () => {
  assert.deepEqual(staleLines([]), ['This bead changed since you opened it.']);
  assert.deepEqual(staleLines(['title', 'acceptance']), [
    'This bead changed since you opened it.',
    'Updated from the newer version: title, acceptance criteria.',
  ]);
  assert.equal(resolveReason([]), undefined);
  assert.equal(resolveReason([{ field: 'title', mine: 'a', theirs: 'b' }]), 'Resolve 1 conflict first.');
  assert.equal(
    resolveReason([{ field: 'title', mine: 'a', theirs: 'b' }, { field: 'design', mine: 'a', theirs: 'b' }]),
    'Resolve 2 conflicts first.',
  );
});

test('staleFrom reads a 409 with the current bead, and nothing else', () => {
  const body = JSON.stringify({ error: 'This bead changed since you opened it.', current: { id: 'b-1', version: 'v9' } });
  const e = staleFrom(409, body);
  assert.equal(e?.current.version, 'v9');
  assert.equal(e?.status, 409);
  assert.equal(staleFrom(409, JSON.stringify({ error: 'bead b-1 is closed' })), undefined);
  assert.equal(staleFrom(409, 'not json'), undefined);
  assert.equal(staleFrom(400, body), undefined);
});

test('shouldRefetch: only a different polled version, and never while busy', () => {
  assert.equal(shouldRefetch('v1', 'v1', false), false);
  assert.equal(shouldRefetch('v1', 'v2', false), true);
  assert.equal(shouldRefetch('v1', 'v2', true), false);
});

test('droppedCriteria lists criteria the newer text has and mine lacks, whitespace collapsed', () => {
  const mine = '- [ ] one reworded (check: c1)\n- [ ] two  (check:  c2)';
  const theirs = '- [ ] one (check: c1)\n- [ ] two (check: c2)\n- [ ] three (check: c3)';
  assert.deepEqual(droppedCriteria(mine, theirs), ['one (check: c1)', 'three (check: c3)']);
  assert.deepEqual(droppedCriteria(theirs, theirs), []);
  assert.deepEqual(droppedCriteria('', ''), []);
});

test('conflictSentence is plural for the acceptance criteria', () => {
  assert.equal(conflictSentence('acceptance'), 'The acceptance criteria were changed on both sides.');
  assert.equal(conflictSentence('description'), 'The description was changed on both sides.');
  assert.equal(conflictSentence('design'), 'The spec body was changed on both sides.');
});

test('unionFields keeps order and drops repeats', () => {
  assert.deepEqual(unionFields(['title'], ['design', 'title']), ['title', 'design']);
  assert.deepEqual(unionFields([], []), []);
});

test('acceptResult: a result is applied only if no later one was applied; 1, 3, 2 refuses 2', () => {
  let last = 0;
  const applied: number[] = [];
  for (const seq of [1, 3, 2]) {
    if (acceptResult(seq, last)) {
      applied.push(seq);
      last = seq;
    }
  }
  assert.deepEqual(applied, [1, 3]);
  assert.equal(acceptResult(1, 0), true);
  assert.equal(acceptResult(2, 2), false);
});

test('shouldRefetch: a pending refetch counts as in flight, so a poll delivery during it starts nothing', () => {
  const fetching = true;
  const busy = false;
  assert.equal(shouldRefetch('v1', 'v2', busy || fetching), false);
});

test('freshnessOutcome: approve only a mounted form whose version still matches', () => {
  assert.equal(freshnessOutcome(true, 'v1', 'v1'), 'approve');
  assert.equal(freshnessOutcome(true, 'v2', 'v1'), 'rebase');
  assert.equal(freshnessOutcome(false, 'v1', 'v1'), 'gone');
  assert.equal(freshnessOutcome(false, 'v2', 'v1'), 'gone');
});

const none: Relations = { children: [], blockedBy: [], blocks: [], related: [], discoveredFrom: [], spawned: [] };

test('relationGroups: nothing for a bead without relations', () => {
  assert.deepEqual(relationGroups(none), []);
});

test('relationGroups: only filled groups, in the fixed order', () => {
  const r: Relations = { parent: 'e', children: ['c'], blockedBy: ['bb'], blocks: ['b'], related: ['r'], discoveredFrom: ['f'], spawned: ['s'] };
  assert.deepEqual(relationGroups(r).map((g) => g.label), ['Parent', 'Children', 'Blocked by', 'Blocks', 'Related', 'Discovered from', 'Spawned']);
  const some = relationGroups({ ...none, related: ['r'], parent: 'e', spawned: ['s'] });
  assert.deepEqual(some.map((g) => g.label), ['Parent', 'Related', 'Spawned']);
  assert.deepEqual(some[0], { label: 'Parent', ids: ['e'], hidden: 0 });
});

test('relationGroups: a long group shows the first six and counts the rest, until expanded', () => {
  const kids = Array.from({ length: 9 }, (_, i) => `k${i}`);
  const g = relationGroups({ ...none, children: kids })[0];
  assert.equal(RELATION_LIMIT, 6);
  assert.deepEqual(g.ids, kids.slice(0, 6));
  assert.equal(g.hidden, 3);
  const open = relationGroups({ ...none, children: kids }, ['Children'])[0];
  assert.deepEqual(open.ids, kids);
  assert.equal(open.hidden, 0);
  const six = relationGroups({ ...none, children: kids.slice(0, 6) })[0];
  assert.equal(six.hidden, 0);
});

test('clampText: short text is untouched', () => {
  assert.deepEqual(clampText('a\nb', 8, 100), { text: 'a\nb', cut: false });
  assert.deepEqual(clampText('', 8, 100), { text: '', cut: false });
});

test('clampText: cuts at the line limit', () => {
  const t = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n');
  const c = clampText(t, DESCRIPTION_LINES, 1000);
  assert.equal(DESCRIPTION_LINES, 8);
  assert.equal(DESIGN_LINES, 12);
  assert.equal(c.cut, true);
  assert.equal(c.text, 'l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7');
  assert.equal(clampText(t, 12, 1000).cut, false);
  assert.equal(clampText('a\r\nb\r\nc', 2, 100).text, 'a\r\nb');
});

test('clampText: a long single line is cut at the character limit, never inside a surrogate pair', () => {
  const emoji = '\u{1F600}';
  const t = 'ab' + emoji.repeat(5);
  const c = clampText(t, 8, 3); // limit lands between the two halves of the first emoji
  assert.equal(c.cut, true);
  assert.equal(c.text, 'ab');
  const d = clampText(t, 8, 4);
  assert.equal(d.text, 'ab' + emoji);
  for (let n = 0; n < t.length; n++) {
    const x = clampText(t, 8, n).text;
    const last = x.charCodeAt(x.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `high surrogate at end for ${n}`);
  }
});
