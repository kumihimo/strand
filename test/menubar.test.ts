import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAIN_ACTIONS, appMenus, type MenuDef, type MenuEntry } from '../ui/src/lib/menubar.ts';
import { MAIN_COMMANDS } from '../electron/menu.ts';

type Opts = Parameters<typeof appMenus>[0];
const desk = (platform: Opts['platform'], o: Partial<Opts> = {}): MenuDef[] => appMenus({ platform, desktop: true, devBuild: false, updateReady: false, ...o });
const items = (menus: MenuDef[], id: MenuDef['id']) => menus.find((m) => m.id === id)?.items ?? [];
const labels = (es: MenuEntry[]) => es.filter((e) => e !== 'separator').map((e) => e.label);
const entry = (menus: MenuDef[], label: string) => menus.flatMap((m) => m.items).find((e) => e !== 'separator' && e.label === label) as Exclude<MenuEntry, 'separator'> | undefined;

test('AT-1 Windows and Linux: File, View, Go, Help with mnemonics; no Edit or Window menu', () => {
  for (const p of ['win32', 'linux'] as const) {
    const m = desk(p);
    assert.deepEqual(m.map((x) => [x.id, x.label, x.mnemonic]), [['file', 'File', 'f'], ['view', 'View', 'v'], ['go', 'Go', 'g'], ['help', 'Help', 'h']]);
  }
});

test('AT-2 the desktop app on macOS has no in-window menu bar (the OS menu bar has it); a browser tab on a Mac does', () => {
  assert.deepEqual(desk('darwin'), []);
  assert.equal(appMenus({ platform: 'darwin', desktop: false, devBuild: false, updateReady: false }).length, 4);
});

test('AT-3 File, View, Go and Help items and their shortcuts', () => {
  const win = desk('win32');
  const linux = desk('linux');
  assert.deepEqual(labels(items(win, 'file')), ['New Bead…', 'Settings…', 'Close Window', 'Exit']);
  assert.deepEqual(labels(items(linux, 'file')), ['New Bead…', 'Settings…', 'Close Window', 'Quit']);
  assert.deepEqual(labels(items(win, 'view')), ['Toggle Sidebar', 'Reload', 'Actual Size', 'Zoom In', 'Zoom Out', 'Toggle Full Screen']);
  assert.deepEqual(labels(items(win, 'go')), ['Brief', 'Board', 'Epics', 'Review Queue', 'Sessions…', 'Back', 'Forward']);
  assert.deepEqual(labels(items(win, 'help')), ['Strand on GitHub', 'Report an Issue…', 'Licences', 'About Strand']);
  const sc = (m: MenuDef[], l: string) => [entry(m, l)?.action, entry(m, l)?.shortcut];
  assert.deepEqual(sc(win, 'New Bead…'), ['new-bead', 'Ctrl+N']);
  assert.deepEqual(sc(win, 'Settings…'), ['settings', 'Ctrl+,']);
  assert.deepEqual(sc(win, 'Close Window'), ['close', 'Ctrl+W']);
  assert.deepEqual(sc(win, 'Exit'), ['quit', undefined]);
  assert.deepEqual(sc(linux, 'Quit'), ['quit', 'Ctrl+Q']);
  assert.deepEqual(sc(win, 'Toggle Sidebar'), ['toggle-sidebar', 'Ctrl+B']);
  assert.deepEqual(sc(win, 'Reload'), ['reload', 'Ctrl+R']);
  assert.deepEqual(sc(win, 'Actual Size'), ['zoom-reset', 'Ctrl+0']);
  assert.deepEqual(sc(win, 'Zoom In'), ['zoom-in', 'Ctrl+=']);
  assert.deepEqual(sc(win, 'Zoom Out'), ['zoom-out', 'Ctrl+-']);
  assert.deepEqual(sc(win, 'Toggle Full Screen'), ['fullscreen', 'F11']);
  assert.deepEqual(sc(win, 'Brief'), ['go:brief', 'Ctrl+1']);
  assert.deepEqual(sc(win, 'Board'), ['go:board', 'Ctrl+2']);
  assert.deepEqual(sc(win, 'Epics'), ['go:epics', 'Ctrl+3']);
  assert.deepEqual(sc(win, 'Review Queue'), ['go:review', 'Ctrl+4']);
  assert.deepEqual(sc(win, 'Sessions…'), ['sessions', 'Ctrl+Shift+E']);
  assert.deepEqual(sc(win, 'Back'), ['back', 'Alt+←']);
  assert.deepEqual(sc(win, 'Forward'), ['forward', 'Alt+→']);
  assert.deepEqual(sc(win, 'Licences'), ['licences', undefined]);
});

test('AT-3 every action the page sends to main is one the main process and the preload accept', () => {
  assert.deepEqual([...MAIN_ACTIONS].sort(), [...MAIN_COMMANDS].sort());
  const src = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const m = /const RUN = (\[[^\]]*\])/.exec(src);
  assert.ok(m, 'preload has a RUN list');
  assert.deepEqual(JSON.parse(m[1].replaceAll("'", '"')).sort(), [...MAIN_COMMANDS].sort());
});

test('AT-5 Restart to Update only after update-ready, in Help before About', () => {
  assert.equal(entry(desk('win32'), 'Restart to Update'), undefined);
  const help = labels(items(desk('linux', { updateReady: true }), 'help'));
  assert.deepEqual(help, ['Strand on GitHub', 'Report an Issue…', 'Licences', 'Restart to Update', 'About Strand']);
});

test('AT-5 Toggle Developer Tools only in a dev build', () => {
  assert.equal(entry(desk('win32'), 'Toggle Developer Tools'), undefined);
  assert.deepEqual([entry(desk('win32', { devBuild: true }), 'Toggle Developer Tools')?.shortcut], ['Ctrl+Shift+I']);
});

test('AT-5 a browser tab has no desktop-only items and shows no shortcuts', () => {
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    const m = appMenus({ platform, desktop: false, devBuild: true, updateReady: true });
    const all = m.flatMap((x) => x.items).filter((e) => e !== 'separator');
    for (const e of all) {
      assert.ok(!(MAIN_ACTIONS as readonly string[]).includes(e.action), `${e.action} is desktop only`);
      assert.equal(e.shortcut, undefined, e.label);
    }
    assert.deepEqual(labels(items(m, 'file')), ['New Bead…', 'Settings…']);
    assert.deepEqual(labels(items(m, 'view')), ['Toggle Sidebar', 'Reload']);
    assert.deepEqual(labels(items(m, 'help')), ['Strand on GitHub', 'Report an Issue…']);
  }
});

test('no menu starts or ends with a separator, or has two in a row', () => {
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    for (const desktop of [true, false]) {
      for (const flag of [true, false]) {
        for (const m of appMenus({ platform, desktop, devBuild: flag, updateReady: flag })) {
          const s = m.items.map((e) => (e === 'separator' ? '|' : 'x')).join('');
          assert.ok(!s.startsWith('|') && !s.endsWith('|') && !s.includes('||'), `${platform} ${desktop} ${m.id}: ${s}`);
        }
      }
    }
  }
});
