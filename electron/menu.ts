// The desktop app's menu bar, as plain data (no Electron import), so it can be unit-tested like handoff.ts.
// Items carry a command name from a fixed list instead of a click handler; main.ts maps each name to its action.

export type Platform = 'darwin' | 'win32' | 'linux';

/** Every command a menu item can carry. Nothing else reaches main's dispatcher. */
export const COMMANDS = [
  'new-bead',
  'settings',
  'go:brief',
  'go:board',
  'go:epics',
  'go:review',
  'go:setup',
  'sessions',
  'back',
  'forward',
  'reload',
  'minimize',
  'restart-to-update',
  'open:repo',
  'open:issues',
  'licences',
] as const;
export type Command = (typeof COMMANDS)[number];

/** The commands main passes to the page through the receive-only preload (ADR 0030); preload.cjs repeats this list. */
export const PAGE_COMMANDS = ['new-bead', 'settings', 'go:brief', 'go:board', 'go:epics', 'go:review', 'go:setup', 'sessions'] as const;
export type PageCommand = (typeof PAGE_COMMANDS)[number];

export function isPageCommand(c: unknown): c is PageCommand {
  return typeof c === 'string' && (PAGE_COMMANDS as readonly string[]).includes(c);
}

/** A menu item: Electron's MenuItemConstructorOptions minus click, plus a command. */
export type Item = {
  label?: string;
  role?: string;
  type?: 'separator';
  accelerator?: string;
  registerAccelerator?: false;
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

/**
 * On Windows and Linux a Ctrl+letter key (no Shift, no Alt) is a terminal control key: Ctrl+R history search,
 * Ctrl+W delete word, Ctrl+C interrupt. The menu shows such a shortcut but does not take the key; the page acts
 * on it when focus is outside a terminal. On macOS Cmd never reaches the terminal, so every key registers.
 */
export function displayOnly(accelerator: string, platform: Platform): boolean {
  return platform !== 'darwin' && /^(Ctrl|CmdOrCtrl|CommandOrControl|Control)\+[A-Z]$/i.test(accelerator);
}

const SEP: Item = { type: 'separator' };

/** The whole menu bar for one platform. `updateReady`: a downloaded update has been verified. */
export function menuTemplate(o: { platform: Platform; packaged: boolean; updateReady: boolean }): Item[] {
  const mac = o.platform === 'darwin';
  const mod = mac ? 'Cmd' : 'Ctrl';
  // Mnemonics (Alt+F opens File) on Windows and Linux only.
  const name = (label: string) => (mac ? label : `&${label}`);
  const restart: Item[] = o.updateReady ? [{ label: 'Restart to Update', command: 'restart-to-update' }] : [];
  const settings: Item = { label: 'Settings…', command: 'settings', accelerator: `${mod}+,` };

  const appMenu: Item[] = mac
    ? [
        {
          label: 'Strand',
          submenu: [{ role: 'about' }, ...restart, SEP, settings, SEP, { role: 'services' }, SEP, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, SEP, { role: 'quit' }],
        },
      ]
    : [];

  const file: Item = {
    label: name('File'),
    submenu: [
      { label: 'New Bead…', command: 'new-bead', accelerator: `${mod}+N` },
      ...(mac
        ? [SEP, { role: 'close' }]
        : [
            SEP,
            settings,
            SEP,
            { role: 'close', accelerator: 'Ctrl+W' },
            o.platform === 'win32' ? { role: 'quit', label: 'Exit' } : { role: 'quit', label: 'Quit', accelerator: 'Ctrl+Q' },
          ]),
    ],
  };

  const edit: Item = mac
    ? { label: 'Edit', role: 'editMenu' }
    : {
        label: name('Edit'),
        submenu: [
          { role: 'undo', accelerator: 'Ctrl+Z' },
          { role: 'redo', accelerator: 'Ctrl+Y' },
          SEP,
          { role: 'cut', accelerator: 'Ctrl+X' },
          { role: 'copy', accelerator: 'Ctrl+C' },
          { role: 'paste', accelerator: 'Ctrl+V' },
          { role: 'delete' },
          SEP,
          { role: 'selectAll', accelerator: 'Ctrl+A' },
        ],
      };

  const view: Item = {
    label: name('View'),
    submenu: [
      { label: 'Reload', command: 'reload', accelerator: `${mod}+R` },
      ...(o.packaged ? [] : [{ role: 'toggleDevTools', accelerator: mac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I' }]),
      SEP,
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      SEP,
      { role: 'togglefullscreen' },
    ],
  };

  const go: Item = {
    label: name('Go'),
    submenu: [
      { label: 'Brief', command: 'go:brief', accelerator: `${mod}+1` },
      { label: 'Board', command: 'go:board', accelerator: `${mod}+2` },
      { label: 'Epics', command: 'go:epics', accelerator: `${mod}+3` },
      { label: 'Review Queue', command: 'go:review', accelerator: `${mod}+4` },
      SEP,
      { label: 'Setup', command: 'go:setup' },
      { label: 'Sessions…', command: 'sessions', accelerator: `${mod}+Shift+E` },
      SEP,
      { label: 'Back', command: 'back', accelerator: mac ? 'Cmd+[' : 'Alt+Left' },
      { label: 'Forward', command: 'forward', accelerator: mac ? 'Cmd+]' : 'Alt+Right' },
    ],
  };

  // Electron's window role would add Minimize on Ctrl+M, a carriage return in a terminal.
  const windowMenu: Item = mac ? { label: 'Window', role: 'windowMenu' } : { label: name('Window'), submenu: [{ label: 'Minimize', command: 'minimize' }] };

  const help: Item = {
    label: name('Help'),
    ...(mac ? { role: 'help' } : {}),
    submenu: [
      { label: 'Strand on GitHub', command: 'open:repo' },
      { label: 'Report an Issue…', command: 'open:issues' },
      SEP,
      { label: 'Licences', command: 'licences' },
      ...(mac ? [] : [...(restart.length ? [SEP, ...restart] : []), SEP, { role: 'about' }]),
    ],
  };

  return withRegistration([...appMenu, file, edit, view, go, windowMenu, help], o.platform);
}

function withRegistration(items: Item[], platform: Platform): Item[] {
  return items.map((i) => ({
    ...i,
    ...(i.accelerator !== undefined && displayOnly(i.accelerator, platform) ? { registerAccelerator: false as const } : {}),
    ...(i.submenu ? { submenu: withRegistration(i.submenu, platform) } : {}),
  }));
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
