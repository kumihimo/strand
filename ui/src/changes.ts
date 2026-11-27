import { useEffect } from 'react';

const EVENT = 'strand:changed';

/** Tell every view that a write (create, approve) happened, so it refetches now rather than at the next poll. */
export function notifyChanged(): void {
  dispatchEvent(new Event(EVENT));
}

export function useOnChanged(fn: () => void): void {
  useEffect(() => {
    addEventListener(EVENT, fn);
    return () => removeEventListener(EVENT, fn);
  }, [fn]);
}
