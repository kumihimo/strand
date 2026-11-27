import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnsFor, extraPills, SESSION_LEGEND, sessionLight, stageLabel, statusPill, wipState } from '../ui/src/lib/format.ts';
import type { BeadCard } from '../src/cockpit/model.ts';

const card = (o: Partial<BeadCard>): BeadCard => ({
  id: 'b-1', title: 't', type: 'task', priority: 2, status: 'open', stage: 'backlog',
  ready: false, blockedBy: [], live: false, needsYou: false, held: false, awaitingApproval: false, ciUnknown: false, labels: [], context: [], ...o,
});

test('sessionLight: one light per card, waiting wins over working', () => {
  assert.equal(sessionLight(card({})), undefined);
  assert.deepEqual(sessionLight(card({ live: true })), { state: 'working', label: 'Claude session live' });
  assert.deepEqual(sessionLight(card({}), true), { state: 'working', label: 'Claude session live, terminal open here' });
  assert.deepEqual(sessionLight(card({ live: true, needsYou: true }), true), { state: 'waiting', label: 'Claude is waiting for you' });
  // The model never sets needsYou without a live session, but the light does not depend on that.
  assert.deepEqual(sessionLight(card({ needsYou: true })), { state: 'waiting', label: 'Claude is waiting for you' });
  assert.deepEqual(SESSION_LEGEND.map((l) => l.state), ['working', 'waiting']);
});

test('stageLabel names all six stages', () => {
  assert.deepEqual(
    (['backlog', 'specify', 'build', 'verify', 'review', 'done'] as const).map(stageLabel),
    ['Backlog', 'Specify', 'Build', 'Verify', 'Review', 'Done'],
  );
});

test('columnsFor groups by stage, sorted by priority then id', () => {
  const cols = columnsFor([
    card({ id: 'b-3', stage: 'build', priority: 2 }),
    card({ id: 'b-2', stage: 'build', priority: 1 }),
    card({ id: 'b-1', stage: 'build', priority: 2 }),
    card({ id: 'b-9', stage: 'done', priority: 3 }),
    card({ id: 'b-8', stage: 'done', priority: 0 }),
  ]);
  assert.deepEqual(cols.build.map((c) => c.id), ['b-2', 'b-1', 'b-3']);
  assert.deepEqual(cols.done.map((c) => c.id), ['b-8', 'b-9']);
  assert.deepEqual(Object.keys(cols), ['backlog', 'queued', 'specify', 'build', 'verify', 'review', 'done']);
  assert.deepEqual(cols.backlog, []);
});

test('columnsFor does not mutate its input', () => {
  const input = [card({ id: 'b-2', priority: 2 }), card({ id: 'b-1', priority: 1 })];
  columnsFor(input);
  assert.equal(input[0].id, 'b-2');
});

test('wipState is full at or above the limit', () => {
  assert.equal(wipState(2, 3), 'ok');
  assert.equal(wipState(3, 3), 'full');
  assert.equal(wipState(4, 3), 'full');
  assert.equal(wipState(0, 0), 'full');
});

test('statusPill: closed, on hold, blocked, awaiting approval, ready, in progress', () => {
  assert.equal(statusPill(card({ status: 'closed' })), 'closed');
  assert.equal(statusPill(card({ stage: 'done' })), 'closed');
  assert.equal(statusPill(card({ held: true, status: 'blocked' })), 'on hold');
  assert.equal(statusPill(card({ held: true, status: 'deferred', blockedBy: ['b-2'] })), 'on hold');
  assert.equal(statusPill(card({ blockedBy: ['b-2'] })), 'blocked');
  assert.equal(statusPill(card({ awaitingApproval: true, status: 'in_progress', stage: 'specify' })), 'awaiting approval');
  assert.equal(statusPill(card({ awaitingApproval: true, blockedBy: ['b-2'] })), 'blocked');
  assert.equal(statusPill(card({ awaitingApproval: true, status: 'closed' })), 'closed');
  assert.equal(statusPill(card({ ready: true })), 'ready');
  assert.equal(statusPill(card({ status: 'in_progress' })), 'in progress');
  assert.equal(statusPill(card({ blockedBy: ['b-2'], ready: true })), 'blocked');
});

test('extraPills: CI unknown shows only when the card says so', () => {
  assert.deepEqual(extraPills(card({})), []);
  assert.deepEqual(extraPills(card({ ciUnknown: true })).map((p) => p.label), ['CI unknown']);
});

import { LEAVE_DRAFT, boardHref, epicHref, leavesDraft, parseRoute, tabLeavesDraft } from '../ui/src/lib/route.ts';
import { errorFromResponse, SESSION_EXPIRED } from '../ui/src/lib/errors.ts';

test('tabLeavesDraft: leaving the Spec tab with an unsaved draft asks; anything else does not', () => {
  assert.equal(tabLeavesDraft(true, 'spec', 'activity'), true);
  assert.equal(tabLeavesDraft(true, 'spec', 'artefacts'), true);
  assert.equal(tabLeavesDraft(true, 'spec', 'spec'), false);
  assert.equal(tabLeavesDraft(false, 'spec', 'activity'), false);
  assert.equal(tabLeavesDraft(true, 'activity', 'spec'), false);
  assert.equal(LEAVE_DRAFT, 'Leave the edit form? Your unsaved changes will be lost.');
});

test('leavesDraft: an unsaved draft is left by any change of route, not by the same route spelled differently', () => {
  assert.equal(leavesDraft(true, '#/board/b-1', '#/brief'), true);
  assert.equal(leavesDraft(true, '#/board/b-1', '#/board/b-2'), true);
  assert.equal(leavesDraft(true, '#/board/b-1', '#board/b-1'), false);
  assert.equal(leavesDraft(false, '#/board/b-1', '#/brief'), false);
});

test('parseRoute handles each route', () => {
  assert.deepEqual(parseRoute('#/brief'), { view: 'brief' });
  assert.deepEqual(parseRoute('#/board'), { view: 'board' });
  assert.deepEqual(parseRoute('#/board/b-1'), { view: 'board', beadId: 'b-1' });
  assert.deepEqual(parseRoute('#/epics'), { view: 'epics' });
  assert.deepEqual(parseRoute('#/review'), { view: 'review' });
  assert.deepEqual(parseRoute('#/epics/demo-e1'), { view: 'epics', epicId: 'demo-e1' });
});

test('parseRoute: epic ids decode, empty id selects nothing, review ignores ids', () => {
  assert.deepEqual(parseRoute('#/epics/a%2Fb'), { view: 'epics', epicId: 'a/b' });
  assert.deepEqual(parseRoute('#/epics/'), { view: 'epics' });
  assert.deepEqual(parseRoute('#/epics/%E0%A4%A'), { view: 'epics', epicId: '%E0%A4%A' });
  assert.deepEqual(parseRoute('#/review/x'), { view: 'review' });
});

test('boardHref and epicHref round-trip through parseRoute', () => {
  for (const id of ['demo-1', 'demo-a3f8.1', 'odd id/with#chars']) {
    assert.deepEqual(parseRoute(boardHref(id)), { view: 'board', beadId: id });
    assert.deepEqual(parseRoute(epicHref(id)), { view: 'epics', epicId: id });
  }
});

test('parseRoute: unknown or empty hash is brief, trailing slash is board', () => {
  assert.deepEqual(parseRoute(''), { view: 'brief' });
  assert.deepEqual(parseRoute('#/nope'), { view: 'brief' });
  assert.deepEqual(parseRoute('#/board/'), { view: 'board' });
});

test('parseRoute: malformed percent-encoding falls back to the raw id', () => {
  assert.deepEqual(parseRoute('#/board/%E0%A4%A'), { view: 'board', beadId: '%E0%A4%A' });
  assert.deepEqual(parseRoute('#/board/a%20b'), { view: 'board', beadId: 'a b' });
});

test('errorFromResponse maps statuses and bodies', () => {
  const e401 = errorFromResponse(401, '{"error":"unauthorized"}');
  assert.equal(e401.status, 401);
  assert.equal(e401.message, SESSION_EXPIRED);
  assert.equal(errorFromResponse(409, '{"error":"no open gate"}').message, 'no open gate');
  assert.equal(errorFromResponse(500, '<html>oops').message, 'request failed (500)');
  assert.equal(errorFromResponse(500, '{"error":5}').message, 'request failed (500)');
  const net = errorFromResponse(0, 'fetch failed');
  assert.equal(net.status, 0);
  assert.match(net.message, /Cannot reach the cockpit server: fetch failed/);
});
