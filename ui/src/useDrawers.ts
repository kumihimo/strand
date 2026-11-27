import { useCallback, useRef, useState } from 'react';
import { DEFAULT_DRAWERS, DRAWERS_KEY, onSessionStart, parseDrawers, toggle, type Drawer, type Drawers } from './lib/drawer.ts';

export { DRAWERS_KEY };
type Store = Pick<Storage, 'getItem' | 'setItem'>;

/* Every storage access can throw or the object can be absent: the drawers then start open and are not remembered. */

export function readDrawers(storage?: Store): Drawers {
  try {
    return parseDrawers((storage ?? localStorage).getItem(DRAWERS_KEY));
  } catch {
    return DEFAULT_DRAWERS;
  }
}

export function writeDrawers(d: Drawers, storage?: Store): void {
  try {
    (storage ?? localStorage).setItem(DRAWERS_KEY, JSON.stringify(d));
  } catch {
    // Not remembered, still applied.
  }
}

/** The drawer state, a toggle, and "expand for a session start" (panel open, details as they are). */
export function useDrawers(): [Drawers, (which: Drawer) => void, () => void] {
  const [state, setState] = useState<Drawers>(() => readDrawers());
  const current = useRef(state);
  const apply = useCallback((next: Drawers) => {
    if (next === current.current) return;
    current.current = next;
    setState(next);
    writeDrawers(next);
  }, []);
  const flip = useCallback((which: Drawer) => apply(toggle(current.current, which)), [apply]);
  const expandForSession = useCallback(() => apply(onSessionStart(current.current)), [apply]);
  return [state, flip, expandForSession];
}
