import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStage, isHeld, titleState } from '../src/core/stage.ts';
import type { StageFacts } from '../src/core/stage.ts';

const base: StageFacts = { status: 'in_progress', planApproved: true, verified: true, hasBranch: true };

test('open bead that is not claimed is backlog', () => {
  assert.equal(deriveStage({ ...base, status: 'open', planApproved: false, verified: false, hasBranch: false }), 'backlog');
});

test('claimed bead without plan approval is specify', () => {
  assert.equal(deriveStage({ ...base, planApproved: false, verified: false }), 'specify');
});

test('plan approved with criteria not all verified is build', () => {
  assert.equal(deriveStage({ ...base, verified: false }), 'build');
});

test('verified with a branch and no PR is verify', () => {
  assert.equal(deriveStage(base), 'verify');
});

test('verified with an open PR and CI running is verify', () => {
  assert.equal(deriveStage({ ...base, pr: { state: 'open', ci: 'running' } }), 'verify');
});

test('open PR with CI failure is verify', () => {
  assert.equal(deriveStage({ ...base, pr: { state: 'open', ci: 'failure' } }), 'verify');
});

test('open PR with CI pending or none is verify', () => {
  assert.equal(deriveStage({ ...base, pr: { state: 'open', ci: 'pending' } }), 'verify');
  assert.equal(deriveStage({ ...base, pr: { state: 'open', ci: 'none' } }), 'verify');
});

test('open PR with CI success is review', () => {
  assert.equal(deriveStage({ ...base, pr: { state: 'open', ci: 'success' } }), 'review');
});

test('open PR with CI unknown is review', () => {
  assert.equal(deriveStage({ ...base, pr: { state: 'open', ci: 'unknown' } }), 'review');
});

test('merged PR is review whatever the CI says', () => {
  assert.equal(deriveStage({ ...base, pr: { state: 'merged', ci: 'failure' } }), 'review');
});

test('closed PR is verify', () => {
  assert.equal(deriveStage({ ...base, pr: { state: 'closed', ci: 'success' } }), 'verify');
});

test('closed bead is done', () => {
  assert.equal(deriveStage({ ...base, status: 'closed', pr: { state: 'merged', ci: 'success' } }), 'done');
  assert.equal(deriveStage({ status: 'closed', planApproved: false, verified: false, hasBranch: false }), 'done');
});

test('a held bead with plan approval keeps its stage', () => {
  assert.equal(deriveStage({ ...base, status: 'blocked', verified: false }), 'build');
  assert.equal(deriveStage({ ...base, status: 'deferred', verified: false }), 'build');
});

test('a held bead without plan approval is backlog', () => {
  assert.equal(deriveStage({ ...base, status: 'blocked', planApproved: false, verified: false }), 'backlog');
  assert.equal(deriveStage({ ...base, status: 'deferred', planApproved: false, verified: false }), 'backlog');
});

test('isHeld is true for blocked and deferred only', () => {
  assert.equal(isHeld('blocked'), true);
  assert.equal(isHeld('deferred'), true);
  assert.equal(isHeld('in_progress'), false);
  assert.equal(isHeld('open'), false);
  assert.equal(isHeld('closed'), false);
});

test('titleState maps stage and status', () => {
  assert.equal(titleState('done', 'closed'), 'DONE');
  assert.equal(titleState('build', 'blocked'), 'HOLD');
  assert.equal(titleState('build', 'deferred'), 'HOLD');
  assert.equal(titleState('review', 'in_progress'), 'REVIEW');
  assert.equal(titleState('build', 'in_progress'), 'WIP');
  assert.equal(titleState('specify', 'in_progress'), 'WIP');
  assert.equal(titleState('verify', 'in_progress'), 'WIP');
});
