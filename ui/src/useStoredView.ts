import { useCallback, useState } from 'react';
import { DEFAULT_VIEW, parseStoredView, type ViewState } from './lib/filter.ts';

export type ViewStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/*
 * Every storage access can throw (private windows, blocked site data) or the object can be absent.
 * The view then runs on defaults and just forgets on reload. `storage` is injectable for tests.
 */

export function readStoredView(key: string, storage?: ViewStorage): ViewState {
  try {
    return parseStoredView((storage ?? localStorage).getItem(key));
  } catch {
    return DEFAULT_VIEW;
  }
}

export function writeStoredView(key: string, view: ViewState, storage?: ViewStorage): void {
  try {
    (storage ?? localStorage).setItem(key, JSON.stringify(view));
  } catch {
    // Not remembered, still applied.
  }
}

export function removeStoredView(key: string, storage?: ViewStorage): void {
  try {
    (storage ?? localStorage).removeItem(key);
  } catch {
    // Nothing to remove.
  }
}

/** A view's sort and filters, kept in `localStorage` under `key`. */
export function useStoredView(key: string): [ViewState, (next: ViewState) => void, () => void] {
  const [view, setView] = useState<ViewState>(() => readStoredView(key));
  const set = useCallback(
    (next: ViewState) => {
      setView(next);
      writeStoredView(key, next);
    },
    [key],
  );
  const clear = useCallback(() => {
    setView(DEFAULT_VIEW);
    removeStoredView(key);
  }, [key]);
  return [view, set, clear];
}
