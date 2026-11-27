import { useEffect } from 'react';

/** While `active`, leaving or reloading the page asks for confirmation. Removed again when `active` turns false. */
export function useUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Some browsers still need a value here to show the prompt.
      e.returnValue = '';
    };
    addEventListener('beforeunload', onBeforeUnload);
    return () => removeEventListener('beforeunload', onBeforeUnload);
  }, [active]);
}
