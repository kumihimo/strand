import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_ID, TERMINAL_MODES, beadBranch, isRepoLabelName, isSafeRepoName, repoOf, slugify, validCols, validRows } from '../src/core/naming.ts';

test('isRepoLabelName: a safe folder name with no comma (labels are comma-separated in bd)', () => {
  assert.equal(isRepoLabelName('my app'), true);
  for (const bad of ['a,b', '..', 'a/b', 'a\\b', '', ' ']) assert.equal(isRepoLabelName(bad), false, bad);
});

test('the terminal rules: session id, modes and size ranges', () => {
  assert.match('0123abcd-0123-4abc-8def-0123456789ab', SESSION_ID);
  for (const bad of ['-'.repeat(36), 'a'.repeat(36), '0123ABCD-0123-4abc-8def-0123456789ab']) assert.doesNotMatch(bad, SESSION_ID);
  assert.deepEqual(TERMINAL_MODES, ['work', 'specify', 'resume']);
  assert.deepEqual([validCols(2), validCols(500), validCols(1), validCols(501), validCols(80.5)], [true, true, false, false, false]);
  assert.deepEqual([validRows(1), validRows(300), validRows(0), validRows(301), validRows('24')], [true, true, false, false, false]);
});

test('slugify lowercases and dashes punctuation', () => {
  assert.equal(slugify('Stream orders as CSV!'), 'stream-orders-as-csv');
});

test('slugify strips accents and symbols', () => {
  assert.equal(slugify('Ünïcode — tïtle'), 'unicode-title');
});

test('slugify falls back to untitled for empty or symbol-only titles', () => {
  assert.equal(slugify(''), 'untitled');
  assert.equal(slugify('!!! ---'), 'untitled');
});

test('slugify trims on a dash boundary and never ends with a dash', () => {
  const s = slugify('alpha beta gamma delta', 12);
  assert.equal(s, 'alpha-beta');
  assert.ok(!s.endsWith('-'));
  assert.ok(s.length <= 12);
});

test('slugify default max is 40 characters', () => {
  const s = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30));
  assert.ok(s.length <= 40);
  assert.ok(!s.endsWith('-'));
});

test('isSafeRepoName rejects paths that escape the workspace', () => {
  assert.equal(isSafeRepoName('orders service'), true);
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a..b']) assert.equal(isSafeRepoName(bad), false, bad);
});

test('repoOf is still exported from naming', () => {
  assert.equal(repoOf({ labels: ['repo:x'] }), 'x');
});

test('beadBranch is undefined without a branch label', () => {
  assert.equal(beadBranch({ labels: ['repo:x'] }), undefined);
});

test('beadBranch without isOpen returns the last branch label', () => {
  assert.equal(beadBranch({ labels: ['branch:a', 'branch:b'] }), 'b');
});

test('beadBranch returns the first open branch', () => {
  const open = (n: string) => n === 'a' || n === 'c';
  assert.equal(beadBranch({ labels: ['branch:a', 'branch:b', 'branch:c'] }, open), 'a');
  assert.equal(beadBranch({ labels: ['branch:b', 'branch:c'] }, open), 'c');
});

test('beadBranch falls back to the last label when none is open', () => {
  assert.equal(beadBranch({ labels: ['branch:a', 'branch:b'] }, () => false), 'b');
});
