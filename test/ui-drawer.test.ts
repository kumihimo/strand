import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DRAWERS, layoutClasses, onSessionStart, parseDrawers, toggle } from '../ui/src/lib/drawer.ts';
import { DRAWERS_KEY, readDrawers, writeDrawers } from '../ui/src/useDrawers.ts';

test('parseDrawers: absent, bad JSON and wrong shapes mean both open and not wide', () => {
  assert.deepEqual(DEFAULT_DRAWERS, { details: false, panel: false, wide: false });
  assert.deepEqual(parseDrawers(null), DEFAULT_DRAWERS);
  assert.deepEqual(parseDrawers(''), DEFAULT_DRAWERS);
  assert.deepEqual(parseDrawers('{nope'), DEFAULT_DRAWERS);
  assert.deepEqual(parseDrawers('null'), DEFAULT_DRAWERS);
  assert.deepEqual(parseDrawers('[true,true]'), DEFAULT_DRAWERS);
  assert.deepEqual(parseDrawers('"x"'), DEFAULT_DRAWERS);
  assert.deepEqual(parseDrawers('{"details":true}'), DEFAULT_DRAWERS);
  assert.deepEqual(parseDrawers('{"details":"yes","panel":true}'), DEFAULT_DRAWERS);
  assert.deepEqual(parseDrawers('{"details":1,"panel":0}'), DEFAULT_DRAWERS);
});

test('parseDrawers: a good value is kept and extra keys are dropped', () => {
  assert.deepEqual(parseDrawers('{"details":true,"panel":false,"wide":true}'), { details: true, panel: false, wide: true });
  assert.deepEqual(parseDrawers('{"details":false,"panel":true,"wide":false,"x":1}'), { details: false, panel: true, wide: false });
});

test('parseDrawers: the old stored shape with no wide reads as not wide', () => {
  assert.deepEqual(parseDrawers('{"details":true,"panel":false}'), { details: true, panel: false, wide: false });
  assert.deepEqual(parseDrawers('{"details":false,"panel":true,"x":1}'), { details: false, panel: true, wide: false });
});

test('parseDrawers: a wide that is not a boolean means defaults', () => {
  assert.deepEqual(parseDrawers('{"details":true,"panel":true,"wide":"yes"}'), DEFAULT_DRAWERS);
  assert.deepEqual(parseDrawers('{"details":true,"panel":true,"wide":1}'), DEFAULT_DRAWERS);
  assert.deepEqual(parseDrawers('{"details":true,"panel":true,"wide":null}'), DEFAULT_DRAWERS);
});

test('toggle flips one flag and leaves the others', () => {
  assert.deepEqual(toggle(DEFAULT_DRAWERS, 'details'), { details: true, panel: false, wide: false });
  assert.deepEqual(toggle(DEFAULT_DRAWERS, 'panel'), { details: false, panel: true, wide: false });
  assert.deepEqual(toggle(DEFAULT_DRAWERS, 'wide'), { details: false, panel: false, wide: true });
  assert.deepEqual(toggle({ details: true, panel: true, wide: true }, 'details'), { details: false, panel: true, wide: true });
  assert.deepEqual(toggle({ details: true, panel: true, wide: true }, 'wide'), { details: true, panel: true, wide: false });
});

test('collapsing and expanding the panel keeps the wide flag', () => {
  const wide = { details: false, panel: false, wide: true };
  const collapsed = toggle(wide, 'panel');
  assert.deepEqual(collapsed, { details: false, panel: true, wide: true });
  assert.deepEqual(toggle(collapsed, 'panel'), wide);
});

test('onSessionStart opens the panel and keeps the details drawer and the width', () => {
  assert.deepEqual(onSessionStart({ details: true, panel: true, wide: false }), { details: true, panel: false, wide: false });
  assert.deepEqual(onSessionStart({ details: false, panel: true, wide: true }), { details: false, panel: false, wide: true });
  assert.deepEqual(onSessionStart(DEFAULT_DRAWERS), DEFAULT_DRAWERS);
});

test('layoutClasses: four drawer states, none without a selection', () => {
  assert.deepEqual(layoutClasses({ details: false, panel: false, wide: false }, true), []);
  assert.deepEqual(layoutClasses({ details: true, panel: false, wide: false }, true), ['details-off']);
  assert.deepEqual(layoutClasses({ details: false, panel: true, wide: false }, true), ['panel-off']);
  assert.deepEqual(layoutClasses({ details: true, panel: true, wide: false }, true), ['details-off', 'panel-off']);
  assert.deepEqual(layoutClasses({ details: true, panel: true, wide: true }, false), []);
});

test('layoutClasses: panel-wide only with a selection and an open panel', () => {
  assert.deepEqual(layoutClasses({ details: false, panel: false, wide: true }, true), ['panel-wide']);
  assert.deepEqual(layoutClasses({ details: true, panel: false, wide: true }, true), ['details-off', 'panel-wide']);
  assert.deepEqual(layoutClasses({ details: false, panel: true, wide: true }, true), ['panel-off']);
  assert.deepEqual(layoutClasses({ details: false, panel: false, wide: true }, false), []);
});

function fakeStorage(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(DRAWERS_KEY, initial);
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

test('storage: round trip under cockpit.detail.drawers', () => {
  const s = fakeStorage();
  writeDrawers({ details: true, panel: false, wide: true }, s);
  assert.equal(DRAWERS_KEY, 'cockpit.detail.drawers');
  assert.equal(s.data.get('cockpit.detail.drawers'), '{"details":true,"panel":false,"wide":true}');
  assert.deepEqual(readDrawers(s), { details: true, panel: false, wide: true });
});

test('storage: a throwing or bad store gives defaults and never throws', () => {
  const boom = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(readDrawers(boom), DEFAULT_DRAWERS);
  assert.doesNotThrow(() => writeDrawers({ details: true, panel: true, wide: false }, boom));
  assert.deepEqual(readDrawers(fakeStorage('garbage')), DEFAULT_DRAWERS);
});
