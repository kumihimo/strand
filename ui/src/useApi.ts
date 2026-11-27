import { useCallback, useEffect, useState } from 'react';

/** Load once per `key` change; errors go to `onError` (the app's banner). */
export function useApi<T>(load: () => Promise<T>, key: string, onError: (e: unknown) => void) {
  const [data, setData] = useState<T>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    load().then((d) => live && setData(d), (e) => live && onError(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, reload };
}
