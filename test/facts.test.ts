import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allVerified, beadIdsIn, branchesOf, captureProblems, contextOf, criteriaBaseline, parseCriteria, specProblems, specReady, planApprovedAt, prsOf, repoOf, unverifiedTicks,
} from '../src/core/facts.ts';
import { criteriaHash } from '../src/core/criteria-hash.ts';

test('parseCriteria reads ticked, unticked, check and evidence', () => {
  const c = parseCriteria('- [ ] Plan 404s (check: make test)\n* [x] A (verified: ok)\n[X] B (verified: ok)\nnot a criterion');
  assert.deepEqual(c, [
    { text: 'Plan 404s', ticked: false, check: 'make test' },
    { text: 'A', ticked: true, evidence: 'ok' },
    { text: 'B', ticked: true, evidence: 'ok' },
  ]);
});

test('parseCriteria handles CRLF and keeps check and evidence together', () => {
  const c = parseCriteria('- [x] A (check: t) (verified: passed)\r\n- [ ] B\r\n');
  assert.equal(c.length, 2);
  assert.deepEqual(c[0], { text: 'A', ticked: true, check: 't', evidence: 'passed' });
  assert.equal(c[1]!.text, 'B');
});

test('parseCriteria of nothing is empty', () => {
  assert.deepEqual(parseCriteria(undefined), []);
  assert.deepEqual(parseCriteria(''), []);
});

test('allVerified needs one criterion, all ticked, all with evidence', () => {
  assert.equal(allVerified(parseCriteria('- [x] A (verified: ok)')), true);
  assert.equal(allVerified(parseCriteria('- [x] A')), false);
  assert.equal(allVerified(parseCriteria('- [x] A (verified: ok)\n- [ ] B')), false);
  assert.equal(allVerified(parseCriteria('')), false);
});

test('empty evidence is not evidence: (verified: ) counts as unverified', () => {
  assert.equal(allVerified(parseCriteria('- [x] A (verified: )')), false);
  assert.equal(allVerified(parseCriteria('- [x] A (verified:)')), false);
  assert.equal(unverifiedTicks(parseCriteria('- [x] A (verified:   )\n- [x] B (verified: ok)')), 1);
});

test('unverifiedTicks counts ticked lines without evidence', () => {
  assert.equal(unverifiedTicks(parseCriteria('- [x] A')), 1);
  assert.equal(unverifiedTicks(parseCriteria('- [x] A (verified: ok)\n- [ ] B\n- [x] C')), 1);
});

test('branchesOf lists branch labels in order', () => {
  assert.deepEqual(branchesOf(['x', 'branch:a', 'repo:r', 'branch:b']), ['a', 'b']);
  assert.deepEqual(branchesOf([]), []);
});

test('prsOf parses pr labels', () => {
  assert.deepEqual(prsOf(['pr:team/orders#12', 'branch:a', 'pr:bad']), [{ owner: 'team', repo: 'orders', number: 12 }]);
});

test('repoOf reads the repo label', () => {
  assert.equal(repoOf({ labels: ['x', 'repo:orders-service'] }), 'orders-service');
  assert.equal(repoOf({ labels: ['x'] }), undefined);
});

test('planApprovedAt returns the last plan-approved timestamp', () => {
  const notes = 'plan-approved 2026-01-01T00:00:00Z\nother\nplan-approved 2026-02-02T10:00:00Z';
  assert.equal(planApprovedAt(notes), '2026-02-02T10:00:00Z');
  assert.equal(planApprovedAt('nothing'), undefined);
  assert.equal(planApprovedAt(undefined), undefined);
});

test('criteriaBaseline returns the last criteria hash', () => {
  assert.equal(criteriaBaseline('criteria aaa111\r\ncriteria bbb222'), 'bbb222');
  assert.equal(criteriaBaseline('criteria is prose now'), undefined);
  assert.equal(criteriaBaseline(undefined), undefined);
});

test('beadIdsIn keeps only known ids', () => {
  assert.deepEqual(beadIdsIn('fix sub-9ka.20 and sub-zzzz', ['sub'], new Set(['sub-9ka.20'])), ['sub-9ka.20']);
  assert.deepEqual(beadIdsIn('nothing here', ['sub'], new Set(['sub-abc'])), []);
});

test('criteriaHash ignores ticks and evidence, changes with text', () => {
  const a = criteriaHash('- [ ] A (check: x)\n- [ ] B (check: y)');
  const b = criteriaHash('- [x] A (check: x) (verified: ok)\n- [x] B (check: y) (verified: ok)');
  assert.equal(a, b);
  assert.equal(a.length, 12);
  assert.notEqual(a, criteriaHash('- [ ] A2 (check: x)\n- [ ] B (check: y)'));
  assert.equal(typeof criteriaHash(undefined), 'string');
});

const good = {
  title: 'Short title',
  type: 'task',
  description: 'As a dev, I want x, so that y',
  acceptance: '- [ ] It works (check: make test)',
  parent: 'p-1',
};

test('captureProblems: a title and a parent are all a bead needs', () => {
  assert.deepEqual(captureProblems({ title: 'Short title', type: 'task', parent: 'p-1' }), []);
  assert.deepEqual(captureProblems({ title: 'x'.repeat(60), type: 'feature', parent: 'p-1' }), []);
  assert.deepEqual(captureProblems({ title: 'x'.repeat(61), type: 'task', parent: 'p-1' }), ['title is over 60 characters']);
  assert.deepEqual(captureProblems({ title: 't', type: 'task' }), ['needs a parent epic']);
  assert.deepEqual(captureProblems({ title: 't', type: 'chore' }), ['needs a parent epic']);
  assert.deepEqual(captureProblems({ title: 't', type: 'epic' }), []);
});

test('specProblems accepts a good task, and ticked criteria', () => {
  assert.deepEqual(specProblems(good), []);
  // "As an engineer" is the same form as "As a buyer".
  assert.deepEqual(specProblems({ ...good, description: 'As an engineer, I want x, so that y.' }), []);
  assert.equal(specProblems({ ...good, description: 'As any engineer, I want x, so that y.' }).length, 1);
  assert.deepEqual(specProblems({ ...good, acceptance: '- [x] It works (check: t) (verified: ok)\n\n- [ ] B (check: u)' }), []);
});

test('specProblems accepts the skill tick format, where the evidence replaces the check', () => {
  assert.deepEqual(specProblems({ ...good, acceptance: '- [x] It works (verified: npm test passed)\n- [X] B (verified: ok)' }), []);
  // An open line still needs its check; a ticked line needs a check or evidence.
  assert.equal(specProblems({ ...good, acceptance: '- [ ] It works (verified: npm test passed)' }).length, 1);
  assert.equal(specProblems({ ...good, acceptance: '- [x] It works' }).length, 1);
});

test('specProblems: the story line, except for a chore or an epic', () => {
  assert.deepEqual(specProblems({ ...good, description: 'do the thing' }), ['description must open "As a ..., I want ..., so that ..."']);
  assert.equal(specProblems({ ...good, description: undefined }).length, 1);
  assert.deepEqual(specProblems({ type: 'epic', acceptance: good.acceptance }), []);
});

test('specProblems: at least one criterion, except for a chore', () => {
  for (const type of ['task', 'feature', 'bug', 'decision']) {
    assert.deepEqual(specProblems({ ...good, type, acceptance: undefined }), ['needs at least one acceptance criterion'], type);
  }
  assert.deepEqual(specProblems({ type: 'epic' }), ['needs at least one acceptance criterion']);
  assert.deepEqual(specProblems({ type: 'chore' }), [], 'a chore needs neither story nor criteria');
});

test('specProblems: every acceptance line must be a criterion with a check, counted in one message', () => {
  const form = 'not in the form "- [ ] <text> (check: <command>)"';
  assert.deepEqual(specProblems({ ...good, acceptance: '- [ ] It works' }), [`1 acceptance line is ${form}`]);
  assert.deepEqual(specProblems({ ...good, acceptance: '- [ ] A (check: t)\nplain line\n- B\n* [ ] C (check: t)' }), [`3 acceptance lines are ${form}`]);
  assert.deepEqual(specProblems({ type: 'chore', acceptance: 'free text' }), [`1 acceptance line is ${form}`]);
  assert.deepEqual(specProblems({ type: 'task', description: 'x', acceptance: 'prose' }).length, 2);
});

test('specReady: acceptance text that meets the approval rules', () => {
  assert.equal(specReady(good), true);
  assert.equal(specReady({ type: 'chore' }), false, 'nothing written yet is not waiting');
  assert.equal(specReady({ type: 'chore', acceptance: '- [ ] Tidy (check: lint)' }), true);
  assert.equal(specReady({ ...good, acceptance: 'free text' }), false);
});

test('contextOf: context folders in label order, without duplicates', () => {
  assert.deepEqual(contextOf(['repo:a', 'context:b', 'branch:x', 'context:c', 'context:b', 'context:']), ['b', 'c']);
  assert.deepEqual(contextOf([]), []);
});
