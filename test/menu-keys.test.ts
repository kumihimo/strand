import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuKey, platformOf } from '../ui/src/lib/menu-keys.ts';

type Mods = Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; repeat: boolean; type: string }>;
const key = (code: string, mods: Mods = {}) => ({ type: 'keydown', code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, ...mods });
const ctrl = (code: string, m: Mods = {}) => key(code, { ctrlKey: true, ...m });
const alt = (code: string) => key(code, { altKey: true });
const at = (o: Partial<Parameters<typeof menuKey>[1]> = {}) => ({ platform: 'linux' as const, inTerminal: false, desktop: true, devBuild: false, ...o });

test('AT-4 Ctrl+letter acts only outside a terminal', () => {
  for (const platform of ['win32', 'linux'] as const) {
    assert.equal(menuKey(ctrl('KeyN'), at({ platform })), 'new-bead');
    assert.equal(menuKey(ctrl('KeyR'), at({ platform })), 'reload');
    assert.equal(menuKey(ctrl('KeyW'), at({ platform })), 'close');
    for (const c of ['KeyN', 'KeyR', 'KeyW', 'KeyQ']) assert.equal(menuKey(ctrl(c), at({ platform, inTerminal: true })), undefined, c);
  }
  assert.equal(menuKey(ctrl('KeyQ'), at({ platform: 'linux' })), 'quit');
  assert.equal(menuKey(ctrl('KeyQ'), at({ platform: 'win32' })), undefined, 'Exit has no key on Windows');
  assert.equal(menuKey(ctrl('KeyC'), at()), undefined, 'copy stays native');
});

test('AT-4 the other shortcuts act everywhere, a terminal included', () => {
  for (const inTerminal of [false, true]) {
    const o = at({ inTerminal });
    assert.equal(menuKey(ctrl('Digit1'), o), 'go:brief');
    assert.equal(menuKey(ctrl('Digit2'), o), 'go:board');
    assert.equal(menuKey(ctrl('Digit3'), o), 'go:epics');
    assert.equal(menuKey(ctrl('Digit4'), o), 'go:review');
    assert.equal(menuKey(ctrl('Comma'), o), 'settings');
    assert.equal(menuKey(ctrl('KeyE', { shiftKey: true }), o), 'sessions');
    assert.equal(menuKey(ctrl('Digit0'), o), 'zoom-reset');
    assert.equal(menuKey(ctrl('Equal'), o), 'zoom-in');
    assert.equal(menuKey(ctrl('Equal', { shiftKey: true }), o), 'zoom-in', 'Ctrl+Plus');
    assert.equal(menuKey(ctrl('NumpadAdd'), o), 'zoom-in');
    assert.equal(menuKey(ctrl('Minus'), o), 'zoom-out');
    assert.equal(menuKey(ctrl('NumpadSubtract'), o), 'zoom-out');
    assert.equal(menuKey(key('F11'), o), 'fullscreen');
  }
});

test('AT-4 Alt+F/V/G/H open the menus and Alt+arrows go back and forward, outside a terminal only', () => {
  assert.equal(menuKey(alt('KeyF'), at()), 'menu:file');
  assert.equal(menuKey(alt('KeyV'), at()), 'menu:view');
  assert.equal(menuKey(alt('KeyG'), at()), 'menu:go');
  assert.equal(menuKey(alt('KeyH'), at()), 'menu:help');
  assert.equal(menuKey(alt('ArrowLeft'), at()), 'back');
  assert.equal(menuKey(alt('ArrowRight'), at()), 'forward');
  for (const c of ['KeyF', 'KeyV', 'KeyG', 'KeyH', 'ArrowLeft', 'ArrowRight']) assert.equal(menuKey(alt(c), at({ inTerminal: true })), undefined, c);
  assert.equal(menuKey(alt('KeyX'), at()), undefined);
});

test('AT-4 Ctrl+Shift+I toggles the developer tools in a dev build only', () => {
  assert.equal(menuKey(ctrl('KeyI', { shiftKey: true }), at({ devBuild: true })), 'devtools');
  assert.equal(menuKey(ctrl('KeyI', { shiftKey: true }), at()), undefined);
});

test('AT-4 nothing in a browser tab or on macOS (the OS menu takes Cmd keys there)', () => {
  for (const c of ['KeyN', 'KeyR', 'Digit1', 'Comma']) {
    assert.equal(menuKey(ctrl(c), at({ desktop: false })), undefined, c);
    assert.equal(menuKey(ctrl(c), at({ platform: 'darwin' })), undefined, c);
    assert.equal(menuKey(key(c, { metaKey: true }), at({ platform: 'darwin' })), undefined, c);
  }
  assert.equal(menuKey(alt('KeyF'), at({ desktop: false })), undefined);
});

test('AT-4 extra modifiers, repeats and keyup are left alone', () => {
  assert.equal(menuKey(ctrl('KeyN', { shiftKey: true }), at()), undefined);
  assert.equal(menuKey(ctrl('KeyN', { altKey: true }), at()), undefined);
  assert.equal(menuKey(ctrl('KeyN', { metaKey: true }), at()), undefined);
  assert.equal(menuKey(ctrl('Digit1', { altKey: true }), at()), undefined);
  assert.equal(menuKey(key('KeyN'), at()), undefined);
  assert.equal(menuKey(ctrl('KeyN', { repeat: true }), at()), undefined);
  assert.equal(menuKey(ctrl('Equal', { repeat: true }), at()), 'zoom-in', 'zoom may repeat');
  assert.equal(menuKey(ctrl('KeyN', { type: 'keyup' }), at()), undefined);
  assert.equal(menuKey(alt('KeyF'), at()) && menuKey({ ...alt('KeyF'), ctrlKey: true }, at()), undefined);
});

test('platformOf reads the user agent', () => {
  assert.equal(platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/45.5.0'), 'win32');
  assert.equal(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/45.5.0'), 'darwin');
  assert.equal(platformOf('Mozilla/5.0 (X11; Linux x86_64) Electron/45.5.0'), 'linux');
});

test('AT-12 Ctrl+B is left to the sidebar, which ignores it in a terminal (no double toggle)', () => {
  assert.equal(menuKey(ctrl('KeyB'), at()), undefined);
  assert.equal(menuKey(ctrl('KeyB'), at({ inTerminal: true })), undefined);
});
