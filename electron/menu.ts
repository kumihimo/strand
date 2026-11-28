// The desktop app's menus and commands, as plain data (no Electron import), so they can be unit-tested like
// handoff.ts. On macOS the native menu bar is the OS's (menuTemplate). On Windows and Linux the window has no
// title bar and the page draws the menu bar (ui/src/lib/menubar.ts, ADR 0030); main has no native menu there.

/** Every command a native menu item or the page can name. Nothing else reaches main's dispatcher. */
export const COMMANDS = [
  'new-bead',
  'settings',
  'go:brief',
  'go:board',
  'go:epics',
  'go:review',
  'sessions',
  'back',
  'forward',
  'reload',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'fullscreen',
  'devtools',
  'about',
  'close',
  'quit',
  'restart-to-update',
  'open:repo',
  'open:issues',
  'licences',
] as const;
export type Command = (typeof COMMANDS)[number];

/** Commands main passes to the page (the macOS menu's page items). */
export const PAGE_COMMANDS = ['new-bead', 'settings', 'go:brief', 'go:board', 'go:epics', 'go:review', 'sessions'] as const;
export type PageCommand = (typeof PAGE_COMMANDS)[number];

/**
 * Everything main sends the page through the preload: the page commands, and two states the page's menu bar
 * shows (`update-ready`: Restart to Update; `dev-build`: Toggle Developer Tools). preload.cjs repeats this list.
 */
export const PAGE_MESSAGES = [...PAGE_COMMANDS, 'update-ready', 'dev-build'] as const;
export type PageMessage = (typeof PAGE_MESSAGES)[number];

/** The only commands the page may ask main to run (the page's menu bar and keys). preload.cjs repeats this list. */
export const MAIN_COMMANDS = ['zoom-in', 'zoom-out', 'zoom-reset', 'fullscreen', 'devtools', 'about', 'close', 'quit', 'restart-to-update', 'licences'] as const;
export type MainCommand = (typeof MAIN_COMMANDS)[number];

export function isPageCommand(c: unknown): c is PageCommand {
  return typeof c === 'string' && (PAGE_COMMANDS as readonly string[]).includes(c);
}

/** A command from the page: exactly a name on MAIN_COMMANDS, and never the developer tools in a packaged app. */
export function mainCommandAllowed(c: unknown, o: { packaged: boolean }): c is MainCommand {
  if (typeof c !== 'string' || !(MAIN_COMMANDS as readonly string[]).includes(c)) return false;
  return !(c === 'devtools' && o.packaged);
}

/** A menu item: Electron's MenuItemConstructorOptions minus click, plus a command. */
export type Item = {
  label?: string;
  role?: string;
  type?: 'separator';
  accelerator?: string;
  command?: Command;
  submenu?: Item[];
};

const REPO = 'https://github.com/kumihimo/strand';

/** The page a Help command opens in the default browser; undefined for any other command. */
export function linkFor(c: Command): string | undefined {
  if (c === 'open:repo') return REPO;
  if (c === 'open:issues') return `${REPO}/issues/new`;
  return undefined;
}

const SEP: Item = { type: 'separator' };

/** The macOS menu bar. `updateReady`: a downloaded update has been verified. */
export function menuTemplate(o: { packaged: boolean; updateReady: boolean }): Item[] {
  const restart: Item[] = o.updateReady ? [{ label: 'Restart to Update', command: 'restart-to-update' }] : [];
  return [
    {
      label: 'Strand',
      submenu: [
        { role: 'about' },
        ...restart,
        SEP,
        { label: 'Settings…', command: 'settings', accelerator: 'Cmd+,' },
        SEP,
        { role: 'services' },
        SEP,
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        SEP,
        { role: 'quit' },
      ],
    },
    { label: 'File', submenu: [{ label: 'New Bead…', command: 'new-bead', accelerator: 'Cmd+N' }, SEP, { role: 'close' }] },
    // Cmd+C, Cmd+V and Cmd+Z in text fields work only through these roles on macOS.
    { label: 'Edit', role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', command: 'reload', accelerator: 'Cmd+R' },
        ...(o.packaged ? [] : [{ role: 'toggleDevTools', accelerator: 'Alt+Cmd+I' }]),
        SEP,
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        SEP,
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        { label: 'Brief', command: 'go:brief', accelerator: 'Cmd+1' },
        { label: 'Board', command: 'go:board', accelerator: 'Cmd+2' },
        { label: 'Epics', command: 'go:epics', accelerator: 'Cmd+3' },
        { label: 'Review Queue', command: 'go:review', accelerator: 'Cmd+4' },
        SEP,
        { label: 'Sessions…', command: 'sessions', accelerator: 'Cmd+Shift+E' },
        SEP,
        { label: 'Back', command: 'back', accelerator: 'Cmd+[' },
        { label: 'Forward', command: 'forward', accelerator: 'Cmd+]' },
      ],
    },
    { label: 'Window', role: 'windowMenu' },
    {
      label: 'Help',
      role: 'help',
      submenu: [
        { label: 'Strand on GitHub', command: 'open:repo' },
        { label: 'Report an Issue…', command: 'open:issues' },
        SEP,
        { label: 'Licences', command: 'licences' },
      ],
    },
  ];
}

export type UnloadPrompt = { message: string; detail: string; buttons: [string, string] };

/**
 * The page asked before unloading (a live terminal or an unsaved edit). `closing`: the window is closing, not
 * reloading. A reload keeps the server and its sessions, so it always asks in its own words. A close asks only
 * when this app owns the server, since closing then quits it; undefined lets the unload go ahead.
 */
export function unloadPrompt(o: { closing: boolean; owned: boolean }): UnloadPrompt | undefined {
  if (!o.closing) {
    return {
      message: 'Reload Strand?',
      detail: 'Sessions keep running and reconnect after the reload. Unsaved edits are lost.',
      buttons: ['Reload', 'Cancel'],
    };
  }
  if (!o.owned) return undefined;
  return {
    message: 'A Claude Code session is still running.',
    detail: 'Quitting Strand stops the cockpit server and ends the session. It can be resumed later.',
    buttons: ['Quit', 'Cancel'],
  };
}
