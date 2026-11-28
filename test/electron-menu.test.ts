import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMANDS, PAGE_COMMANDS, displayOnly, linkFor, menuTemplate, unloadPrompt, type Item, type Platform } from '../electron/menu.ts';

const OTHERS: Platform[] = ['win32', 'linux'];
const ALL: Platform[] = ['darwin', 'win32', 'linux'];
const build = (platform: Platform, o: { packaged?: boolean; updateReady?: boolean } = {}) =>
  menuTemplate({ platform, packaged: o.packaged ?? true, updateReady: o.updateReady ?? false });

/** Every item, depth first. */
function walk(items: Item[]): Item[] {
  return items.flatMap((i) => [i, ...walk(i.submenu ?? [])]);
}
const top = (t: Item[]) => t.map((m) => m.label);
const menu = (t: Item[], label: string) => {
  const m = t.find((x) => x.label?.replace('&', '') === label);
  assert.ok(m, `no ${label} menu`);
  return m.submenu ?? [];
};
const labels = (items: Item[]) => items.filter((i) => i.type !== 'separator').map((i) => i.label ?? i.role);
const find = (t: Item[], label: string) => walk(t).find((i) => i.label === label);

test('AT-1 Windows and Linux: File, Edit, View, Go, Window, Help with mnemonics, and no Update menu', () => {
  for (const p of OTHERS) {
    const t = build(p, { updateReady: true });
    assert.deepEqual(top(t), ['&File', '&Edit', '&View', '&Go', '&Window', '&Help']);
    assert.ok(!t.some((m) => m.label?.includes('Update')));
  }
});

test('AT-2 macOS: the Strand app menu first, with About, Settings, Services, Hide and Quit; File has no Settings or Quit', () => {
  const t = build('darwin');
  assert.deepEqual(top(t), ['Strand', 'File', 'Edit', 'View', 'Go', 'Window', 'Help']);
  const app = menu(t, 'Strand');
  assert.deepEqual(labels(app), ['about', 'Settings…', 'services', 'hide', 'hideOthers', 'unhide', 'quit']);
  assert.equal(app.find((i) => i.label === 'Settings…')?.accelerator, 'Cmd+,');
  assert.deepEqual(labels(menu(t, 'File')), ['New Bead…', 'close']);
  assert.ok(!t.some((m) => m.label?.includes('&')), 'no mnemonics on macOS');
});

test('AT-2 Windows and Linux: Settings, Close Window and Exit or Quit are in File', () => {
  assert.deepEqual(labels(menu(build('win32'), 'File')), ['New Bead…', 'Settings…', 'close', 'Exit']);
  assert.deepEqual(labels(menu(build('linux'), 'File')), ['New Bead…', 'Settings…', 'close', 'Quit']);
  assert.equal(find(build('linux'), 'Quit')?.accelerator, 'Ctrl+Q');
  assert.equal(find(build('win32'), 'Exit')?.accelerator, undefined);
  assert.equal(find(build('win32'), 'Settings…')?.accelerator, 'Ctrl+,');
});

test('AT-3 Go has the views on Mod+1-4, then Setup, Sessions, Back and Forward', () => {
  for (const p of ALL) {
    const mod = p === 'darwin' ? 'Cmd' : 'Ctrl';
    const go = menu(build(p), 'Go');
    assert.deepEqual(labels(go), ['Brief', 'Board', 'Epics', 'Review Queue', 'Setup', 'Sessions…', 'Back', 'Forward']);
    assert.deepEqual(
      go.slice(0, 4).map((i) => [i.command, i.accelerator]),
      [['go:brief', `${mod}+1`], ['go:board', `${mod}+2`], ['go:epics', `${mod}+3`], ['go:review', `${mod}+4`]],
    );
    assert.equal(find(build(p), 'Setup')?.command, 'go:setup');
    assert.equal(find(build(p), 'Sessions…')?.accelerator, `${mod}+Shift+E`);
    assert.equal(find(build(p), 'Back')?.accelerator, p === 'darwin' ? 'Cmd+[' : 'Alt+Left');
    assert.equal(find(build(p), 'Forward')?.accelerator, p === 'darwin' ? 'Cmd+]' : 'Alt+Right');
    assert.deepEqual([find(build(p), 'New Bead…')?.command, find(build(p), 'New Bead…')?.accelerator], ['new-bead', `${mod}+N`]);
  }
});

test('AT-3 every command in the template is in the fixed list, and the page commands are a part of it', () => {
  for (const p of ALL) {
    for (const packaged of [true, false]) {
      for (const updateReady of [true, false]) {
        for (const i of walk(menuTemplate({ platform: p, packaged, updateReady }))) {
          if (i.command !== undefined) assert.ok((COMMANDS as readonly string[]).includes(i.command), i.command);
          assert.ok(!(i.command && i.role), 'an item has a command or a role, not both');
        }
      }
    }
  }
  for (const c of PAGE_COMMANDS) assert.ok((COMMANDS as readonly string[]).includes(c));
});

test('AT-3 the preload passes on exactly the page commands', () => {
  const src = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const m = /const ALLOWED = (\[[^\]]*\])/.exec(src);
  assert.ok(m, 'preload has an ALLOWED list');
  assert.deepEqual(JSON.parse(m[1].replaceAll("'", '"')), [...PAGE_COMMANDS]);
});

test('AT-4 displayOnly: on Windows and Linux a Ctrl+letter accelerator without Shift or Alt; never on macOS', () => {
  for (const p of OTHERS) {
    for (const a of ['Ctrl+N', 'Ctrl+R', 'Ctrl+W', 'Ctrl+Q', 'Ctrl+C', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+A']) assert.equal(displayOnly(a, p), true, a);
    for (const a of ['Ctrl+1', 'Ctrl+,', 'Ctrl+=', 'Ctrl+-', 'Ctrl+0', 'Ctrl+Shift+E', 'Ctrl+Shift+I', 'Alt+Left', 'F11', 'Ctrl+Plus']) assert.equal(displayOnly(a, p), false, a);
  }
  for (const a of ['Cmd+N', 'Cmd+R', 'Cmd+W', 'Cmd+Q', 'Cmd+C']) assert.equal(displayOnly(a, 'darwin'), false, a);
});

test('AT-4 the template registers every accelerator except the display-only ones', () => {
  for (const p of ALL) {
    const items = walk(build(p, { packaged: false, updateReady: true })).filter((i) => i.accelerator !== undefined);
    assert.ok(items.length > 10);
    for (const i of items) {
      const expected = displayOnly(i.accelerator!, p) ? false : undefined;
      assert.equal(i.registerAccelerator, expected, `${p} ${i.label ?? i.role} ${i.accelerator}`);
    }
  }
});

test('AT-4 Windows and Linux: roles whose default key is a Ctrl+letter carry it explicitly, display-only', () => {
  for (const p of OTHERS) {
    const t = build(p);
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'close']) {
      const i = walk(t).find((x) => x.role === role);
      assert.ok(i, role);
      assert.ok(i.accelerator?.startsWith('Ctrl+'), `${role} has an explicit accelerator`);
      assert.equal(i.registerAccelerator, false, role);
    }
    // Ctrl+M is a carriage return in a terminal: Minimize is a command with no key, not the role.
    const minimize = find(t, 'Minimize');
    assert.equal(minimize?.command, 'minimize');
    assert.equal(minimize?.accelerator, undefined);
    assert.ok(!walk(t).some((i) => i.role === 'minimize' || i.role === 'windowMenu' || i.role === 'editMenu'));
  }
});

test('AT-5 Restart to Update only once an update is verified: the app menu on macOS, Help elsewhere', () => {
  for (const p of ALL) assert.equal(find(build(p), 'Restart to Update'), undefined);
  assert.equal(menu(build('darwin', { updateReady: true }), 'Strand').find((i) => i.label === 'Restart to Update')?.command, 'restart-to-update');
  for (const p of OTHERS) {
    assert.equal(menu(build(p, { updateReady: true }), 'Help').find((i) => i.label === 'Restart to Update')?.command, 'restart-to-update');
  }
  assert.equal(menu(build('darwin', { updateReady: true }), 'Help').find((i) => i.label === 'Restart to Update'), undefined);
});

test('AT-6 Toggle Developer Tools only when not packaged', () => {
  for (const p of ALL) {
    assert.ok(!walk(build(p, { packaged: true })).some((i) => i.role === 'toggleDevTools'));
    const dev = walk(build(p, { packaged: false })).find((i) => i.role === 'toggleDevTools');
    assert.equal(dev?.accelerator, p === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I');
  }
});

test('View has Reload, zoom and full screen; Help links to the repo and its issues, and About', () => {
  for (const p of ALL) {
    const t = build(p);
    const mod = p === 'darwin' ? 'Cmd' : 'Ctrl';
    assert.deepEqual(labels(menu(t, 'View')), ['Reload', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']);
    assert.deepEqual([find(t, 'Reload')?.command, find(t, 'Reload')?.accelerator], ['reload', `${mod}+R`]);
    const help = labels(menu(t, 'Help'));
    assert.deepEqual(help.slice(0, 2), ['Strand on GitHub', 'Report an Issue…']);
    assert.equal(help.includes('about'), p !== 'darwin');
  }
  assert.equal(linkFor('open:repo'), 'https://github.com/kumihimo/strand');
  assert.equal(linkFor('open:issues'), 'https://github.com/kumihimo/strand/issues/new');
  assert.equal(linkFor('reload'), undefined);
});

test('AT-9 unloadPrompt: a reload always asks with reload wording; a close asks to quit only when the app owns the server', () => {
  assert.equal(unloadPrompt({ closing: false, owned: true })?.message, 'Reload Strand?');
  assert.deepEqual(unloadPrompt({ closing: false, owned: false })?.buttons, ['Reload', 'Cancel']);
  assert.equal(unloadPrompt({ closing: true, owned: true })?.message, 'A Claude Code session is still running.');
  assert.deepEqual(unloadPrompt({ closing: true, owned: true })?.buttons, ['Quit', 'Cancel']);
  assert.equal(unloadPrompt({ closing: true, owned: false }), undefined);
});
