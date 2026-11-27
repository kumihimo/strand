/**
 * The layout of the bead detail. `details` and `panel`: true = collapsed. `wide`: the drawer takes 80% of
 * the view's height, so the terminal has room. The state applies to every bead.
 */
export type Drawers = { details: boolean; panel: boolean; wide: boolean };
export type Drawer = keyof Drawers;

export const DEFAULT_DRAWERS: Drawers = { details: false, panel: false, wide: false };

/** The `localStorage` key the drawers are kept under. */
export const DRAWERS_KEY = 'cockpit.detail.drawers';

/**
 * A stored value that is absent, not JSON or the wrong shape means the defaults.
 * A value stored before `wide` existed has no such key: it reads as not wide.
 */
export function parseDrawers(raw: string | null): Drawers {
  if (!raw) return DEFAULT_DRAWERS;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return DEFAULT_DRAWERS;
    const o = v as Record<string, unknown>;
    if (typeof o.details !== 'boolean' || typeof o.panel !== 'boolean') return DEFAULT_DRAWERS;
    if (o.wide !== undefined && typeof o.wide !== 'boolean') return DEFAULT_DRAWERS;
    return { details: o.details, panel: o.panel, wide: o.wide === true };
  } catch {
    return DEFAULT_DRAWERS;
  }
}

export function toggle(d: Drawers, which: Drawer): Drawers {
  return { ...d, [which]: !d[which] };
}

/** Starting a session shows the terminal: the panel opens, the details drawer and the width stay as they are. */
export function onSessionStart(d: Drawers): Drawers {
  return d.panel ? { ...d, panel: false } : d;
}

/** Class names for `main` while a bead is selected. None when no bead is selected. */
export function layoutClasses(d: Drawers, selected: boolean): string[] {
  if (!selected) return [];
  const out: string[] = [];
  if (d.details) out.push('details-off');
  if (d.panel) out.push('panel-off');
  else if (d.wide) out.push('panel-wide');
  return out;
}
