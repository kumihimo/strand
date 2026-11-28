import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SettingField } from '../src/core/settings.ts';
import { draftOf, hintsOf, patchOf, placeholderOf } from '../ui/src/lib/settings.ts';
import { errorFromResponse } from '../ui/src/lib/errors.ts';
import { parseRoute } from '../ui/src/lib/route.ts';

const f = (o: Partial<SettingField> & { key: string }): SettingField => ({ label: o.key, kind: 'text', file: undefined, effective: undefined, restart: false, ...o });

const FIELDS = [
  f({ key: 'wip.build', kind: 'number', file: 3, effective: 3 }),
  f({ key: 'wip.mode', kind: 'choice', choices: ['warn', 'refuse'], effective: 'warn' }),
  f({ key: 'branchPrefix', file: 'kmg', effective: 'kmg' }),
  f({ key: 'claudeModel', file: 'opus', effective: 'sonnet', envVar: 'STRAND_CLAUDE_MODEL' }),
  f({ key: 'trackerDir', kind: 'path', effective: '/w/tracker', restart: true }),
];

test('draftOf shows the file value, or the effective value for a field the env sets', () => {
  assert.deepEqual(draftOf(FIELDS), { 'wip.build': '3', 'wip.mode': '', branchPrefix: 'kmg', claudeModel: 'sonnet', trackerDir: '' });
});

test('placeholderOf shows the value in force when the file has none', () => {
  assert.equal(placeholderOf(FIELDS[4] as SettingField), '/w/tracker');
  assert.equal(placeholderOf(f({ key: 'claudePath', kind: 'path' })), '');
});

test('patchOf sends only changed fields, numbers as numbers, cleared fields as empty, never env-set fields', () => {
  const draft = { ...draftOf(FIELDS), 'wip.build': ' 5 ', 'wip.mode': 'refuse', branchPrefix: '', claudeModel: 'haiku' };
  assert.deepEqual(patchOf(FIELDS, draft), { 'wip.build': 5, 'wip.mode': 'refuse', branchPrefix: '' });
  assert.deepEqual(patchOf(FIELDS, draftOf(FIELDS)), {});
  // A number that does not parse goes as typed, so the server names the field.
  assert.deepEqual(patchOf(FIELDS, { ...draftOf(FIELDS), 'wip.build': 'three' }), { 'wip.build': 'three' });
  assert.deepEqual(patchOf(FIELDS, { ...draftOf(FIELDS), 'wip.build': '' }), { 'wip.build': '' });
});

test('hintsOf names the env variable, the restart and the artefacts caveat', () => {
  assert.deepEqual(hintsOf(FIELDS[3] as SettingField), ['Set by STRAND_CLAUDE_MODEL; unset it to change it here.']);
  assert.deepEqual(hintsOf(FIELDS[4] as SettingField), ['Applies after the cockpit restarts.', 'Empty uses a folder under the workspace.']);
  assert.match(hintsOf(f({ key: 'artefactsVcs', kind: 'choice' })).join(' '), /does not move/);
  assert.match(hintsOf(f({ key: 'claudePath', kind: 'path' })).join(' '), /PATH/);
});

test('errorFromResponse keeps per-field messages', () => {
  const e = errorFromResponse(400, JSON.stringify({ error: 'invalid settings', fields: { 'wip.mode': 'must be one of warn, refuse', bad: 3 } }));
  assert.equal(e.message, 'invalid settings');
  assert.deepEqual(e.fields, { 'wip.mode': 'must be one of warn, refuse' });
  assert.equal(errorFromResponse(400, '{"error":"x"}').fields, undefined);
});

test('parseRoute knows the settings view', () => {
  assert.deepEqual(parseRoute('#/settings'), { view: 'settings' });
});
