import { useEffect, useRef } from 'react';
import { menuKey, platformOf } from './lib/menu-keys.ts';

type Handlers = { newBead: () => void; sessions: () => void };

/**
 * The desktop app's menu bar reaching the page (ADR 0030): commands from the receive-only preload, and on Windows
 * and Linux the Ctrl+letter keys the menu shows but leaves to the page (lib/menu-keys.ts). Nothing in a browser tab.
 */
export function useMenu(h: Handlers): void {
  const handlers = useRef(h);
  handlers.current = h;
  useEffect(() => {
    const bridge = window.strandMenu;
    if (!bridge) return;
    const stop = bridge.onCommand((command) => {
      if (command === 'new-bead') handlers.current.newBead();
      else if (command === 'sessions') handlers.current.sessions();
      else if (command === 'settings') location.hash = '#/settings';
      else if (command.startsWith('go:')) location.hash = `#/${command.slice(3)}`;
    });
    const platform = platformOf(navigator.userAgent);
    const onKey = (e: KeyboardEvent) => {
      const inTerminal = e.target instanceof Element && e.target.closest('.xterm') !== null;
      const action = menuKey(e, { platform, inTerminal });
      if (!action) return;
      e.preventDefault();
      if (action === 'new-bead') handlers.current.newBead();
      else if (action === 'reload') location.reload();
      else window.close();
    };
    addEventListener('keydown', onKey);
    return () => {
      stop();
      removeEventListener('keydown', onKey);
    };
  }, []);
}
