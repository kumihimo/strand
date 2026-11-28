// The menu keys the page handles itself in the desktop app. On Windows and Linux the menu shows Ctrl+N, Ctrl+R,
// Ctrl+W and Ctrl+Q but does not take them (electron/menu.ts, displayOnly), since a terminal needs them as control
// keys. The page acts on them only when focus is outside a terminal. On macOS the menu takes Cmd keys itself.

export type Platform = 'darwin' | 'win32' | 'linux';
export type KeyAction = 'new-bead' | 'reload' | 'close';

type KeyLike = { type: string; key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; repeat: boolean };

export function menuKey(e: KeyLike, o: { platform: Platform; inTerminal: boolean }): KeyAction | undefined {
  if (o.platform === 'darwin' || o.inTerminal) return undefined;
  if (e.type !== 'keydown' || e.repeat || !e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return undefined;
  switch (e.key.toLowerCase()) {
    case 'n':
      return 'new-bead';
    case 'r':
      return 'reload';
    case 'w':
      return 'close';
    case 'q':
      return o.platform === 'linux' ? 'close' : undefined;
    default:
      return undefined;
  }
}

export function platformOf(userAgent: string): Platform {
  if (/Windows/.test(userAgent)) return 'win32';
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'darwin';
  return 'linux';
}
