// The menu bar's keys in the Windows and Linux desktop app, where the page has the menu (ADR 0030). A terminal
// needs Ctrl+letter (Ctrl+R history search, Ctrl+W delete word) and Alt+letter (Alt+F forward word), so those act
// only when focus is outside a terminal. Ctrl+digit, Ctrl+comma, Ctrl+Shift+letter, zoom and F11 act everywhere.
// On macOS the OS menu takes Cmd keys; a browser tab keeps the browser's keys.

import type { MenuAction, MenuId, Platform } from './menubar.ts';

export type { Platform };
export type KeyResult = MenuAction | `menu:${MenuId}`;

type KeyLike = { type: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; repeat: boolean };
type Where = { platform: Platform; inTerminal: boolean; desktop: boolean; devBuild: boolean };

const ANYWHERE_CTRL: Record<string, MenuAction> = {
  Digit1: 'go:brief',
  Digit2: 'go:board',
  Digit3: 'go:epics',
  Digit4: 'go:review',
  Comma: 'settings',
  Digit0: 'zoom-reset',
  Numpad0: 'zoom-reset',
  Equal: 'zoom-in',
  NumpadAdd: 'zoom-in',
  Minus: 'zoom-out',
  NumpadSubtract: 'zoom-out',
};
const ZOOM = new Set(['Equal', 'NumpadAdd', 'Minus', 'NumpadSubtract']);
const ALT_MENUS: Record<string, MenuId> = { KeyF: 'file', KeyV: 'view', KeyG: 'go', KeyH: 'help' };

export function menuKey(e: KeyLike, o: Where): KeyResult | undefined {
  if (!o.desktop || o.platform === 'darwin' || e.type !== 'keydown' || e.metaKey) return undefined;
  const { ctrlKey: ctrl, shiftKey: shift, altKey: alt, code } = e;
  if (e.repeat && !(ctrl && ZOOM.has(code))) return undefined;

  if (code === 'F11' && !ctrl && !alt && !shift) return 'fullscreen';
  if (ctrl && !alt) {
    // Ctrl+Shift+= is Ctrl+Plus on most layouts.
    if (ANYWHERE_CTRL[code] && (!shift || code === 'Equal')) return ANYWHERE_CTRL[code];
    if (shift && code === 'KeyE') return 'sessions';
    if (shift && code === 'KeyI') return o.devBuild ? 'devtools' : undefined;
    if (shift || o.inTerminal) return undefined;
    if (code === 'KeyN') return 'new-bead';
    if (code === 'KeyR') return 'reload';
    if (code === 'KeyW') return 'close';
    if (code === 'KeyQ') return o.platform === 'linux' ? 'quit' : undefined;
    return undefined;
  }
  if (alt && !ctrl && !shift && !o.inTerminal) {
    if (ALT_MENUS[code]) return `menu:${ALT_MENUS[code]}`;
    if (code === 'ArrowLeft') return 'back';
    if (code === 'ArrowRight') return 'forward';
  }
  return undefined;
}

export function platformOf(userAgent: string): Platform {
  if (/Windows/.test(userAgent)) return 'win32';
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'darwin';
  return 'linux';
}
