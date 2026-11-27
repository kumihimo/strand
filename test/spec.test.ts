import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSpecFormat, specTemplate } from '../src/core/spec.ts';

test('defaultSpecFormat maps each bead type per global constraints', () => {
  assert.equal(defaultSpecFormat('feature'), 'gwt');
  assert.equal(defaultSpecFormat('bug'), 'repro');
  assert.equal(defaultSpecFormat('task'), 'checklist');
  assert.equal(defaultSpecFormat('chore'), 'checklist');
  assert.equal(defaultSpecFormat('spike'), 'checklist');
  assert.equal(defaultSpecFormat('supplier spec'), 'ears');
  assert.equal(defaultSpecFormat('supplier-spec'), 'ears');
  assert.equal(defaultSpecFormat('security review'), 'ears');
  assert.equal(defaultSpecFormat('security-review'), 'ears');
  assert.equal(defaultSpecFormat('rfc'), 'document');
  assert.equal(defaultSpecFormat('decision'), 'document');
  assert.equal(defaultSpecFormat('EULA review'), 'brief');
  assert.equal(defaultSpecFormat('eula-review'), 'brief');
  assert.equal(defaultSpecFormat('DPIA'), 'brief');
  assert.equal(defaultSpecFormat('dpia'), 'brief');
  assert.equal(defaultSpecFormat('deck'), 'brief');
  assert.equal(defaultSpecFormat('incident'), 'brief');
  assert.equal(defaultSpecFormat('retro'), 'brief');
});

test('unknown bead type defaults to checklist', () => {
  assert.equal(defaultSpecFormat('whatever'), 'checklist');
});

test('gwt template has Scenario and Given/When/Then', () => {
  const t = specTemplate('gwt');
  assert.ok(t.includes('Scenario:'));
  assert.ok(t.includes('Given'));
  assert.ok(t.includes('When'));
  assert.ok(t.includes('Then'));
});

test('ears template has shall and If', () => {
  const t = specTemplate('ears');
  assert.ok(t.includes('shall'));
  assert.ok(t.includes('If'));
});

test('repro template has Steps, Expected, Actual', () => {
  const t = specTemplate('repro');
  assert.ok(t.includes('Steps'));
  assert.ok(t.includes('Expected'));
  assert.ok(t.includes('Actual'));
});

test('checklist template has unchecked items', () => {
  assert.ok(specTemplate('checklist').includes('- [ ]'));
});

test('document template points at RFC/ADR locations', () => {
  const t = specTemplate('document');
  assert.ok(t.includes('docs/rfc'));
  assert.ok(t.includes('docs/adr'));
});

test('brief template has the five placeholders', () => {
  const t = specTemplate('brief');
  for (const word of ['Purpose', 'Audience', 'Need', 'Information', 'Communication']) {
    assert.ok(t.includes(word), `missing ${word}`);
  }
});
