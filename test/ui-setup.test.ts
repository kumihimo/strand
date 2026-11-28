import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SetupView } from '../src/cockpit/setup-routes.ts';
import type { ToolState } from '../src/core/tools.ts';
import { SETUP_HASH, landOnSetup, rowOf } from '../ui/src/lib/setup.ts';
import { parseRoute } from '../ui/src/lib/route.ts';

const t = (o: Partial<ToolState> & Pick<ToolState, 'name' | 'status'>): ToolState => ({ min: '1.0.0', required: true, ...o });

const offer = (tool: 'but' | 'claude' | 'gh', available = true) => ({
  tool,
  title: tool,
  licence: { name: 'L', url: 'https://l.example' },
  source: 'src',
  action: 'runs it',
  after: 'after',
  upgrade: `${tool} update`,
  available,
});

const view = (tools: ToolState[], ready: boolean): SetupView => ({ tools, offers: [offer('but'), offer('claude'), offer('gh')], ready });

test('AT-3 the app lands on Setup instead of the Brief while setup is needed and not skipped', () => {
  const needed = view([t({ name: 'but', status: 'missing' })], false);
  const done = view([t({ name: 'but', status: 'ok' })], true);
  assert.equal(landOnSetup(needed, 'brief', false), true);
  assert.equal(landOnSetup(needed, 'brief', true), false, 'skipped for this window');
  assert.equal(landOnSetup(needed, 'board', false), false, 'only the landing view moves');
  assert.equal(landOnSetup(done, 'brief', false), false);
  assert.equal(landOnSetup(undefined, 'brief', false), false);
});

test('AT-7 Setup lives in Settings: #/setup opens Settings, and a first run lands there', () => {
  assert.deepEqual(parseRoute('#/setup'), { view: 'settings' });
  assert.deepEqual(parseRoute('#/settings'), { view: 'settings' });
  assert.equal(SETUP_HASH, '#/settings');
});

test('AT-4 rowOf: a missing offered tool can be installed; an old one gets its upgrade; git and bd come with the app', () => {
  const v = view([], false);
  const but = rowOf(t({ name: 'but', status: 'missing' }), v);
  assert.equal(but.install, true);
  assert.equal(but.offer?.licence.url, 'https://l.example');
  assert.equal(but.label, 'Missing');
  const old = rowOf(t({ name: 'claude', status: 'old', found: '0.1.0' }), v);
  assert.equal(old.install, false);
  assert.equal(old.label, 'Too old: 0.1.0, needs 1.0.0 or newer');
  assert.equal(old.note, 'claude update');
  const git = rowOf(t({ name: 'git', status: 'missing' }), v);
  assert.equal(git.install, false);
  assert.match(git.note!, /git-scm\.com/);
  const ok = rowOf(t({ name: 'gh', status: 'ok', found: '2.50.0', required: false }), v);
  assert.equal(ok.label, 'Installed: 2.50.0');
  const unavailable = rowOf(t({ name: 'but', status: 'missing' }), { ...v, offers: [offer('but', false)] });
  assert.equal(unavailable.install, false);
  assert.match(unavailable.note!, /no official installer/);
});
