// The in-page menu bar (ADR 0030): File, View, Go and Help in the header, drawn with shadcn's Menubar. On
// Windows and Linux it replaces the OS menu, which the title-bar-less window does not show. In the macOS app the
// OS menu bar has these items (electron/menu.ts), so there is none in the window. In a browser tab it shows only
// what a page can do, with no shortcuts (the browser keeps its own).

export type Platform = 'darwin' | 'win32' | 'linux';

/** Actions the page asks the main process to run; electron/menu.ts MAIN_COMMANDS and preload.cjs RUN match it. */
export const MAIN_ACTIONS = ['zoom-in', 'zoom-out', 'zoom-reset', 'fullscreen', 'devtools', 'about', 'close', 'quit', 'restart-to-update', 'licences'] as const;
export type MainAction = (typeof MAIN_ACTIONS)[number];
export type PageAction = 'toggle-sidebar' | 'new-bead' | 'settings' | 'reload' | 'go:brief' | 'go:board' | 'go:epics' | 'go:review' | 'sessions' | 'back' | 'forward' | 'open:repo' | 'open:issues';
export type MenuAction = MainAction | PageAction;

export const isMainAction = (a: string): a is MainAction => (MAIN_ACTIONS as readonly string[]).includes(a);

export type MenuItem = { label: string; action: MenuAction; shortcut?: string };
export type MenuEntry = MenuItem | 'separator';
export type MenuId = 'file' | 'view' | 'go' | 'help';
export type MenuDef = { id: MenuId; label: string; mnemonic: string; items: MenuEntry[] };

export const REPO_URL = 'https://github.com/kumihimo/strand';
export const ISSUES_URL = `${REPO_URL}/issues/new`;

/** No separator first, last or twice in a row: whatever items a context drops. */
function tidy(entries: (MenuEntry | false)[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (e === false) continue;
    if (e === 'separator' && (out.length === 0 || out[out.length - 1] === 'separator')) continue;
    out.push(e);
  }
  while (out[out.length - 1] === 'separator') out.pop();
  return out;
}

export function appMenus(o: { platform: Platform; desktop: boolean; devBuild: boolean; updateReady: boolean }): MenuDef[] {
  if (o.desktop && o.platform === 'darwin') return [];
  const d = o.desktop;
  const item = (label: string, action: MenuAction, shortcut?: string): MenuItem => (d && shortcut ? { label, action, shortcut } : { label, action });
  const file = tidy([
    item('New Bead…', 'new-bead', 'Ctrl+N'),
    item('Settings…', 'settings', 'Ctrl+,'),
    'separator',
    d && item('Close Window', 'close', 'Ctrl+W'),
    d && (o.platform === 'win32' ? item('Exit', 'quit') : item('Quit', 'quit', 'Ctrl+Q')),
  ]);
  const view = tidy([
    item('Toggle Sidebar', 'toggle-sidebar', 'Ctrl+B'),
    'separator',
    item('Reload', 'reload', 'Ctrl+R'),
    d && o.devBuild && item('Toggle Developer Tools', 'devtools', 'Ctrl+Shift+I'),
    'separator',
    d && item('Actual Size', 'zoom-reset', 'Ctrl+0'),
    d && item('Zoom In', 'zoom-in', 'Ctrl+='),
    d && item('Zoom Out', 'zoom-out', 'Ctrl+-'),
    'separator',
    d && item('Toggle Full Screen', 'fullscreen', 'F11'),
  ]);
  const go = tidy([
    item('Brief', 'go:brief', 'Ctrl+1'),
    item('Board', 'go:board', 'Ctrl+2'),
    item('Epics', 'go:epics', 'Ctrl+3'),
    item('Review Queue', 'go:review', 'Ctrl+4'),
    'separator',
    item('Sessions…', 'sessions', 'Ctrl+Shift+E'),
    'separator',
    item('Back', 'back', 'Alt+←'),
    item('Forward', 'forward', 'Alt+→'),
  ]);
  const help = tidy([
    item('Strand on GitHub', 'open:repo'),
    item('Report an Issue…', 'open:issues'),
    'separator',
    d && item('Licences', 'licences'),
    'separator',
    d && o.updateReady && item('Restart to Update', 'restart-to-update'),
    'separator',
    d && item('About Strand', 'about'),
  ]);
  return [
    { id: 'file', label: 'File', mnemonic: 'f', items: file },
    { id: 'view', label: 'View', mnemonic: 'v', items: view },
    { id: 'go', label: 'Go', mnemonic: 'g', items: go },
    { id: 'help', label: 'Help', mnemonic: 'h', items: help },
  ];
}
