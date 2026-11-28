import type { OfferView, SetupView } from '../../../src/cockpit/setup-routes.ts';
import type { ToolState } from '../../../src/core/tools.ts';
import type { Route } from './route.ts';

/** sessionStorage key: the engineer chose "Skip for now" in this window. */
export const SKIP_KEY = 'strand.setup.skipped';

/** Where a first run lands: Settings, whose Tools section is Setup. */
export const SETUP_HASH = '#/settings';

/** Open on Setup instead of the Brief while a required tool is missing or old, unless skipped in this window. */
export function landOnSetup(v: SetupView | undefined, view: Route['view'], skipped: boolean): boolean {
  return v !== undefined && !v.ready && !skipped && view === 'brief';
}

/** Tools setup does not install: where they come from. */
const OWN_SOURCE: Partial<Record<ToolState['name'], string>> = {
  git: 'git comes with the Strand app. Without it, install git from git-scm.com.',
  bd: 'Beads (bd) comes with the Strand app. Without it, install bd from github.com/steveyegge/beads.',
};

export type SetupRow = {
  tool: ToolState;
  /** Status in words. */
  label: string;
  /** The offer for a tool setup installs. */
  offer?: OfferView;
  /** True when setup may install it: missing, offered, and an official installer exists here. */
  install: boolean;
  /** What to do instead, when setup does not install it. */
  note?: string;
};

export function rowOf(tool: ToolState, v: SetupView): SetupRow {
  const offer = v.offers.find((o) => o.tool === tool.name);
  const label =
    tool.status === 'ok'
      ? `Installed: ${tool.found}`
      : tool.status === 'old'
        ? tool.found
          ? `Too old: ${tool.found}, needs ${tool.min} or newer`
          : `Does not report a version; needs ${tool.min} or newer`
        : 'Missing';
  if (tool.status === 'ok') return { tool, label, offer, install: false };
  if (!offer) return { tool, label, install: false, note: OWN_SOURCE[tool.name] };
  if (tool.status === 'old') return { tool, label, offer, install: false, note: offer.upgrade };
  if (!offer.available) return { tool, label, offer, install: false, note: `There is no official installer for ${offer.title} on this computer.` };
  return { tool, label, offer, install: true };
}
