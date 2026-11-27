import { useEffect, useRef, useState } from 'react';
import { LEAVE_DRAFT, leavesDraft, parseRoute, type Route } from './lib/route.ts';

/**
 * The route from the location hash. While `dirty` (an edit form holds unsaved changes), a change of route asks
 * first; on No the old hash is put back and the route stays.
 */
export function useRoute(dirty = false): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    let current = location.hash;
    const on = () => {
      const next = location.hash;
      if (leavesDraft(dirtyRef.current, current, next) && !confirm(LEAVE_DRAFT)) {
        // replaceState fires no hashchange, so this does not ask again.
        history.replaceState(null, '', current || location.pathname + location.search);
        return;
      }
      current = next;
      setRoute(parseRoute(next));
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}
