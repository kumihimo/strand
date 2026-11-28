import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { menuKey, platformOf } from './lib/menu-keys.ts';
import { ISSUES_URL, REPO_URL, appMenus, isMainAction, type MenuAction, type MenuDef, type MenuId, type Platform } from './lib/menubar.ts';

type Handlers = { newBead: () => void; sessions: () => void; toggleSidebar: () => void };

export type Menu = {
  menus: MenuDef[];
  open: MenuId | '';
  setOpen: (id: MenuId | '') => void;
  run: (a: MenuAction) => void;
  /** The desktop app's platform; undefined in a browser tab. */
  desktop: Platform | undefined;
};

/**
 * The menu bar's state and actions (ADR 0030). In the desktop app the preload gives `window.strandMenu`: messages
 * from main (the macOS menu's page commands, update-ready, dev-build) and `run` for the window actions only main
 * can do. On Windows and Linux the page also handles the menu's keys (lib/menu-keys.ts). In a browser tab there is
 * no bridge, and the menu bar offers only what a page can do.
 */
export function useMenu(h: Handlers): Menu {
  const handlers = useRef(h);
  handlers.current = h;
  const bridge = typeof window === 'undefined' ? undefined : window.strandMenu;
  const platform = useMemo(() => platformOf(navigator.userAgent), []);
  const desktop = bridge ? platform : undefined;
  const [updateReady, setUpdateReady] = useState(false);
  const [devBuild, setDevBuild] = useState(false);
  const [open, setOpen] = useState<MenuId | ''>('');

  const run = useCallback(
    (a: MenuAction) => {
      if (isMainAction(a)) return bridge?.run(a);
      switch (a) {
        case 'new-bead':
          return handlers.current.newBead();
        case 'sessions':
          return handlers.current.sessions();
        case 'toggle-sidebar':
          return handlers.current.toggleSidebar();
        case 'settings':
          location.hash = '#/settings';
          return;
        case 'go:brief':
        case 'go:board':
        case 'go:epics':
        case 'go:review':
          location.hash = `#/${a.slice(3)}`;
          return;
        case 'reload':
          return location.reload();
        case 'back':
          return history.back();
        case 'forward':
          return history.forward();
        case 'open:repo':
          return void window.open(REPO_URL, '_blank', 'noopener,noreferrer');
        case 'open:issues':
          return void window.open(ISSUES_URL, '_blank', 'noopener,noreferrer');
      }
    },
    [bridge],
  );

  useEffect(() => {
    if (!bridge) return;
    document.documentElement.dataset.desktop = platform;
    const stop = bridge.onCommand((m) => {
      if (m === 'update-ready') setUpdateReady(true);
      else if (m === 'dev-build') setDevBuild(true);
      else if (m === 'new-bead' || m === 'sessions' || m === 'settings' || m.startsWith('go:')) run(m as MenuAction);
    });
    return () => {
      stop();
      delete document.documentElement.dataset.desktop;
    };
  }, [bridge, platform, run]);

  // Capture phase, so a shortcut that acts everywhere is taken before a terminal sees it.
  useEffect(() => {
    if (!bridge) return;
    const onKey = (e: KeyboardEvent) => {
      const inTerminal = e.target instanceof Element && e.target.closest('.xterm') !== null;
      const r = menuKey(e, { platform, inTerminal, desktop: true, devBuild });
      if (!r) return;
      e.preventDefault();
      e.stopPropagation();
      if (r.startsWith('menu:')) setOpen(r.slice(5) as MenuId);
      else run(r as MenuAction);
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [bridge, platform, devBuild, run]);

  const menus = useMemo(() => appMenus({ platform, desktop: desktop !== undefined, devBuild, updateReady }), [platform, desktop, devBuild, updateReady]);
  return { menus, open, setOpen, run, desktop };
}
