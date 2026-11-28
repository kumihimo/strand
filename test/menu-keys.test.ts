import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuKey, platformOf } from '../ui/src/lib/menu-keys.ts';

const key = (k: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; repeat: boolean }> = {}) => ({
  type: 'keydown',
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  repeat: false,
  ...mods,
});
const ctrl = (k: string) => key(k, { ctrlKey: true });

test('AT-7 Ctrl+N opens New bead when focus is outside a terminal, on Windows and Linux', () => {
  for (const platform of ['win32', 'linux'] as const) {
    assert.equal(menuKey(ctrl('n'), { platform, inTerminal: false }), 'new-bead');
    assert.equal(menuKey(ctrl('N'), { platform, inTerminal: false }), 'new-bead', 'Caps Lock on');
  }
});

test('AT-7 inside a terminal every key goes to the terminal', () => {
  for (const platform of ['win32', 'linux'] as const) {
    for (const k of ['n', 'r', 'w', 'q']) assert.equal(menuKey(ctrl(k), { platform, inTerminal: true }), undefined, k);
  }
});

test('AT-7 the other display-only menu keys: Ctrl+R reloads, Ctrl+W closes, Ctrl+Q quits on Linux only', () => {
  assert.equal(menuKey(ctrl('r'), { platform: 'linux', inTerminal: false }), 'reload');
  assert.equal(menuKey(ctrl('w'), { platform: 'win32', inTerminal: false }), 'close');
  assert.equal(menuKey(ctrl('q'), { platform: 'linux', inTerminal: false }), 'close');
  assert.equal(menuKey(ctrl('q'), { platform: 'win32', inTerminal: false }), undefined);
});

test('AT-7 anything else is left alone: macOS (the menu takes Cmd keys), other modifiers, repeats, keyup', () => {
  assert.equal(menuKey(ctrl('n'), { platform: 'darwin', inTerminal: false }), undefined);
  assert.equal(menuKey(key('n', { metaKey: true }), { platform: 'darwin', inTerminal: false }), undefined);
  assert.equal(menuKey(key('n', { ctrlKey: true, shiftKey: true }), { platform: 'linux', inTerminal: false }), undefined);
  assert.equal(menuKey(key('n', { ctrlKey: true, altKey: true }), { platform: 'linux', inTerminal: false }), undefined);
  assert.equal(menuKey(key('n'), { platform: 'linux', inTerminal: false }), undefined);
  assert.equal(menuKey(key('n', { ctrlKey: true, repeat: true }), { platform: 'linux', inTerminal: false }), undefined);
  assert.equal(menuKey({ ...ctrl('n'), type: 'keyup' }, { platform: 'linux', inTerminal: false }), undefined);
  assert.equal(menuKey(ctrl('c'), { platform: 'linux', inTerminal: false }), undefined, 'copy stays native');
});

test('platformOf reads the user agent', () => {
  assert.equal(platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/45.5.0'), 'win32');
  assert.equal(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/45.5.0'), 'darwin');
  assert.equal(platformOf('Mozilla/5.0 (X11; Linux x86_64) Electron/45.5.0'), 'linux');
});
