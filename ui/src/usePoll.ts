import { useEffect } from 'react';

/** Call `tick` every `ms` while the page is visible, and once when it becomes visible again. */
export function usePoll(tick: () => void, ms: number): void {
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') tick();
    }, ms);
    const onVis = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [tick, ms]);
}
