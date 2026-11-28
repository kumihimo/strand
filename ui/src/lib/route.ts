export type Route = { view: 'brief' | 'board' | 'epics' | 'review' | 'settings'; beadId?: string; epicId?: string };

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseRoute(hash: string): Route {
  const [view, id] = hash.replace(/^#\/?/, '').split('/');
  if (view === 'board') return id ? { view, beadId: safeDecode(id) } : { view };
  if (view === 'epics') return id ? { view, epicId: safeDecode(id) } : { view };
  if (view === 'review') return { view };
  if (view === 'settings') return { view };
  return { view: 'brief' };
}

/** What is asked before an edit form with unsaved changes is unmounted. */
export const LEAVE_DRAFT = 'Leave the edit form? Your unsaved changes will be lost.';

/** Switching the bead detail from tab `from` to `to` would unmount the edit form (it lives on Spec) with unsaved changes. */
export function tabLeavesDraft(dirty: boolean, from: string, to: string): boolean {
  return dirty && from === 'spec' && to !== 'spec';
}

/** Moving from `from` to `to` would unmount an edit form that holds unsaved changes. */
export function leavesDraft(dirty: boolean, from: string, to: string): boolean {
  return dirty && JSON.stringify(parseRoute(from)) !== JSON.stringify(parseRoute(to));
}

export const boardHref =(id: string): string => `#/board/${encodeURIComponent(id)}`;
export const epicHref = (id: string): string => `#/epics/${encodeURIComponent(id)}`;
