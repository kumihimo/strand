import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wipCounts, checkBuild } from '../src/core/wip.ts';
import type { Stage } from '../src/core/stage.ts';

const limits = { build: 3, review: 3 };

test('wipCounts counts only build and review stages', () => {
  const stages: Stage[] = ['backlog', 'specify', 'build', 'build', 'verify', 'review', 'done'];
  const items = stages.map((stage) => ({ stage, status: 'in_progress' }));
  assert.deepEqual(wipCounts(items), { build: 2, review: 1 });
  assert.deepEqual(wipCounts([]), { build: 0, review: 0 });
});

test('held items are not counted', () => {
  assert.deepEqual(
    wipCounts([
      { stage: 'build', status: 'blocked' },
      { stage: 'build', status: 'deferred' },
      { stage: 'build', status: 'in_progress' },
      { stage: 'review', status: 'blocked' },
    ]),
    { build: 1, review: 0 },
  );
});

test('refuse mode: review at its limit is not ok', () => {
  assert.deepEqual(checkBuild({ build: 1, review: 3 }, limits, 'refuse'), {
    ok: false,
    reason: 'Review is at its WIP limit (3/3)',
  });
});

test('refuse mode: build at its limit is not ok', () => {
  assert.deepEqual(checkBuild({ build: 3, review: 0 }, limits, 'refuse'), {
    ok: false,
    reason: 'Build is at its WIP limit (3/3)',
  });
});

test('warn mode: ok is true and the reason is given', () => {
  assert.deepEqual(checkBuild({ build: 1, review: 3 }, limits, 'warn'), {
    ok: true,
    reason: 'Review is at its WIP limit (3/3)',
  });
  assert.deepEqual(checkBuild({ build: 3, review: 0 }, limits, 'warn'), {
    ok: true,
    reason: 'Build is at its WIP limit (3/3)',
  });
});

test('review is checked first and reasons carry the real numbers', () => {
  assert.deepEqual(checkBuild({ build: 9, review: 2 }, { build: 5, review: 1 }, 'refuse'), {
    ok: false,
    reason: 'Review is at its WIP limit (2/1)',
  });
});

test('below both limits is ok with no reason in either mode', () => {
  assert.deepEqual(checkBuild({ build: 2, review: 2 }, limits, 'refuse'), { ok: true });
  assert.deepEqual(checkBuild({ build: 2, review: 2 }, limits, 'warn'), { ok: true });
});
