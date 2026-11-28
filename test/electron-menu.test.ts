import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMANDS, MAIN_COMMANDS, PAGE_COMMANDS, PAGE_MESSAGES, linkFor, mainCommandAllowed, menuTemplate, unloadPrompt, type Item } from '../electron/menu.ts';

// The native menu is macOS only (ADR 0030): Windows and Linux draw the menu bar in the page.
const build = (o: { packaged?: boolean; updateReady?: boolean } = {}) => menuTemplate({ packaged: o.packaged ?? true, updateReady: o.updateReady ?? false });

/** Every item, depth first. */
function walk(items: Item[]): Item[] {
  return items.flatMap((i) => [i, ...walk(i.submenu ?? [])]);
}
const menu = (t: Item[], label: string) => {
  const m = t.find((x) => x.label === label);
  assert.ok(m, `no ${label} menu`);
  return m.submenu ?? [];
};
const labels = (items: Item[]) => items.filter((i) => i.type !== 'separator').map((i) => i.label ?? i.role);
const find = (t: Item[], label: string) => walk(t).find((i) => i.label === label);
const preloadList = (name: string): string[] => {
  const src = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const m = new RegExp(`const ${name} = (\\[[^\\]]*\\])`).exec(src);
  assert.ok(m, `preload has a ${name} list`);
  return JSON.parse(m[1].replaceAll("'", '"'));
};

test('AT-2 macOS keeps the native Strand, File, Edit, View, Go, Window and Help menus', () => {
  const t = build();
  assert.deepEqual(t.map((m) => m.label), ['Strand', 'File', 'Edit', 'View', 'Go', 'Window', 'Help']);
  assert.deepEqual(labels(menu(t, 'Strand')), ['about', 'Settings…', 'services', 'hide', 'hideOthers', 'unhide', 'quit']);
  assert.equal(find(t, 'Settings…')?.accelerator, 'Cmd+,');
  assert.deepEqual(labels(menu(t, 'File')), ['New Bead…', 'close']);
  assert.equal(t.find((m) => m.label === 'Edit')?.role, 'editMenu', 'Cmd+C, Cmd+V and Cmd+Z need the edit role');
  assert.equal(t.find((m) => m.label === 'Window')?.role, 'windowMenu');
});

test('AT-3 macOS Go has the views on Cmd+1-4, Sessions, Back and Forward; File has New Bead on Cmd+N', () => {
  const t = build();
  const go = menu(t, 'Go');
  assert.deepEqual(labels(go), ['Brief', 'Board', 'Epics', 'Review Queue', 'Sessions…', 'Back', 'Forward']);
  assert.deepEqual(
    go.slice(0, 4).map((i) => [i.command, i.accelerator]),
    [['go:brief', 'Cmd+1'], ['go:board', 'Cmd+2'], ['go:epics', 'Cmd+3'], ['go:review', 'Cmd+4']],
  );
  assert.equal(find(t, 'Sessions…')?.accelerator, 'Cmd+Shift+E');
  assert.equal(find(t, 'Back')?.accelerator, 'Cmd+[');
  assert.equal(find(t, 'Forward')?.accelerator, 'Cmd+]');
  assert.deepEqual([find(t, 'New Bead…')?.command, find(t, 'New Bead…')?.accelerator], ['new-bead', 'Cmd+N']);
  assert.deepEqual([find(t, 'Reload')?.command, find(t, 'Reload')?.accelerator], ['reload', 'Cmd+R']);
});

test('AT-3 every command in the template is in the fixed list; page and main commands are parts of it', () => {
  for (const packaged of [true, false]) {
    for (const updateReady of [true, false]) {
      for (const i of walk(menuTemplate({ packaged, updateReady }))) {
        if (i.command !== undefined) assert.ok((COMMANDS as readonly string[]).includes(i.command), i.command);
        assert.ok(!(i.command && i.role), 'an item has a command or a role, not both');
      }
    }
  }
  for (const c of [...PAGE_COMMANDS, ...MAIN_COMMANDS]) assert.ok((COMMANDS as readonly string[]).includes(c), c);
});

test('AT-3 the preload passes on exactly the page messages and sends exactly the main commands', () => {
  assert.deepEqual(preloadList('ALLOWED'), [...PAGE_MESSAGES]);
  assert.deepEqual(preloadList('RUN'), [...MAIN_COMMANDS]);
  for (const c of PAGE_COMMANDS) assert.ok((PAGE_MESSAGES as readonly string[]).includes(c));
});

test('AT-5 macOS: Restart to Update in the Strand menu only once an update is verified', () => {
  assert.equal(find(build(), 'Restart to Update'), undefined);
  assert.equal(menu(build({ updateReady: true }), 'Strand').find((i) => i.label === 'Restart to Update')?.command, 'restart-to-update');
});

test('AT-6 mainCommandAllowed: only the fixed list, and devtools only when not packaged', () => {
  for (const c of MAIN_COMMANDS) assert.equal(mainCommandAllowed(c, { packaged: false }), true, c);
  for (const c of MAIN_COMMANDS.filter((x) => x !== 'devtools')) assert.equal(mainCommandAllowed(c, { packaged: true }), true, c);
  assert.equal(mainCommandAllowed('devtools', { packaged: true }), false);
  for (const bad of ['new-bead', 'go:brief', 'open:repo', 'reload', '', 'ZOOM-IN', 'zoom-in ', 'constructor', '__proto__', 42, null, undefined, { c: 'quit' }, ['quit']]) {
    assert.equal(mainCommandAllowed(bad, { packaged: false }), false, String(bad));
  }
});

test('AT-6 macOS View has Toggle Developer Tools only when not packaged', () => {
  assert.ok(!walk(build({ packaged: true })).some((i) => i.role === 'toggleDevTools'));
  assert.equal(walk(build({ packaged: false })).find((i) => i.role === 'toggleDevTools')?.accelerator, 'Alt+Cmd+I');
});

test('Help links go to the repo and its issues', () => {
  assert.deepEqual(labels(menu(build(), 'Help')).slice(0, 2), ['Strand on GitHub', 'Report an Issue…']);
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

test('AT-8 Help has Licences on every platform, after the links, carrying the licences command', () => {
  // macOS here; Windows and Linux in test/menubar.test.ts (the in-page menu bar).
  const help = menu(build(), 'Help');
  assert.deepEqual(labels(help).slice(0, 3), ['Strand on GitHub', 'Report an Issue…', 'Licences']);
  assert.equal(find(build(), 'Licences')?.command, 'licences');
  assert.ok((COMMANDS as readonly string[]).includes('licences'));
  assert.ok(!(PAGE_COMMANDS as readonly string[]).includes('licences'), 'main opens the window; the page never sees it');
});
