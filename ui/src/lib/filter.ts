import type { BeadCard, Epic } from '../../../src/cockpit/model.ts';
import type { Stage } from '../../../src/core/stage.ts';
import { columnsFor, type ColumnKey } from './format.ts';

export type SortKey = 'priority' | 'status' | 'stage' | 'type' | 'updated' | 'title';

export type ViewState = {
  sort: SortKey;
  dir: 'asc' | 'desc';
  status: string[];
  stage: string[];
  type: string[];
  repo: string[];
  label: string[];
  epic?: string;
  ready: boolean;
  blocked: boolean;
  text: string;
  hideEmptyEpics: boolean;
  /** A view setting, not a filter: closed beads stay hidden unless Status closed or Stage Done is ticked. */
  hideClosed: boolean;
};

export const DEFAULT_VIEW: ViewState = {
  sort: 'priority',
  dir: 'asc',
  status: [],
  stage: [],
  type: [],
  repo: [],
  label: [],
  ready: false,
  blocked: false,
  text: '',
  hideEmptyEpics: true,
  hideClosed: true,
};

/** The epic filter value for cards that have no parent. */
export const NO_EPIC = '(none)';

export const SORT_KEYS: readonly SortKey[] = ['priority', 'status', 'stage', 'type', 'updated', 'title'];
/** Position of each stage on the board. A `Record` over `Stage`, so adding a stage fails to compile until it is placed here. */
const STAGE_RANK: Record<Stage, number> = { backlog: 0, specify: 1, build: 2, verify: 3, review: 4, done: 5 };
export const STAGE_ORDER: readonly Stage[] = (Object.keys(STAGE_RANK) as Stage[]).sort((a, b) => STAGE_RANK[a] - STAGE_RANK[b]);

type KnownStatus = 'in_progress' | 'open' | 'blocked' | 'deferred' | 'closed';
const STATUS_RANK: Record<KnownStatus, number> = { in_progress: 0, open: 1, blocked: 2, deferred: 3, closed: 4 };
export const STATUS_ORDER: readonly string[] = (Object.keys(STATUS_RANK) as KnownStatus[]).sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b]);
const statusRank = (s: string): number => (Object.hasOwn(STATUS_RANK, s) ? STATUS_RANK[s as KnownStatus] : STATUS_ORDER.length);

/* ---------- filtering ---------- */

/** Whether any filter is set. Sort, the epics toggle and Hide closed are not filters. */
export function isFiltering(v: ViewState): boolean {
  return (
    v.status.length > 0 || v.stage.length > 0 || v.type.length > 0 || v.repo.length > 0 || v.label.length > 0 ||
    v.epic !== undefined || v.ready || v.blocked || v.text.trim() !== ''
  );
}

/** Blocked means it waits on an open bead, or its status says so. */
const isBlocked = (c: BeadCard): boolean => c.blockedBy.length > 0 || c.status === 'blocked';

/** Closed: the status says so, or the bead sits in Done (the rule `statusPill` in format.ts uses). */
export const isClosed = (c: Pick<BeadCard, 'status' | 'stage'>): boolean => c.status === 'closed' || c.stage === 'done';

/** Asking for closed beads by Status or Stage shows them whatever Hide closed says. */
const asksForClosed = (v: ViewState): boolean => v.status.includes('closed') || v.stage.includes('done');

export function matches(card: BeadCard, v: ViewState): boolean {
  if (v.hideClosed && isClosed(card) && !asksForClosed(v)) return false;
  if (v.status.length && !v.status.includes(card.status)) return false;
  if (v.stage.length && !v.stage.includes(card.stage)) return false;
  if (v.type.length && !v.type.includes(card.type)) return false;
  if (v.repo.length && !(card.repo !== undefined && v.repo.includes(card.repo))) return false;
  if (v.label.length && !v.label.every((l) => card.labels.includes(l))) return false;
  if (v.epic !== undefined && (v.epic === NO_EPIC ? card.parent !== undefined : card.parent !== v.epic)) return false;
  if (v.ready && !card.ready) return false;
  if (v.blocked && !isBlocked(card)) return false;
  const text = v.text.trim().toLowerCase();
  if (text && !card.id.toLowerCase().includes(text) && !card.title.toLowerCase().includes(text)) return false;
  return true;
}

/* ---------- sorting ---------- */

const byPriorityThenId = (a: BeadCard, b: BeadCard): number => a.priority - b.priority || a.id.localeCompare(b.id);

/** Orders cards by the view's key and direction. Ties fall back to priority, then id, whatever the direction. */
export function compareCards(v: ViewState): (a: BeadCard, b: BeadCard) => number {
  const sign = v.dir === 'desc' ? -1 : 1;
  const key = (a: BeadCard, b: BeadCard): number => {
    switch (v.sort) {
      case 'priority': return a.priority - b.priority;
      case 'status': return statusRank(a.status) - statusRank(b.status);
      case 'stage': return STAGE_RANK[a.stage] - STAGE_RANK[b.stage];
      case 'type': return a.type.localeCompare(b.type);
      case 'title': return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
      case 'updated': return (a.updatedAt ?? '') < (b.updatedAt ?? '') ? -1 : (a.updatedAt ?? '') > (b.updatedAt ?? '') ? 1 : 0;
    }
  };
  return (a, b) => {
    if (v.sort === 'updated' && (!a.updatedAt || !b.updatedAt)) {
      // A missing date goes last in both directions.
      if (!a.updatedAt && !b.updatedAt) return byPriorityThenId(a, b);
      return a.updatedAt ? -1 : 1;
    }
    return sign * key(a, b) || byPriorityThenId(a, b);
  };
}

/** Filtered, then sorted. Returns a new array. */
export function applyCards(cards: BeadCard[], v: ViewState): BeadCard[] {
  return cards.filter((c) => matches(c, v)).sort(compareCards(v));
}

/* ---------- board and epics ---------- */

/**
 * The six board columns. Which stage a card sits in comes from `columnsFor` (format.ts), the one place that
 * rule lives; this adds the filter and the sort on top. `total` ignores the filter.
 */
export function boardColumns(cards: BeadCard[], v: ViewState, queue: readonly string[] = []): { stage: ColumnKey; shown: BeadCard[]; total: number }[] {
  const grouped = columnsFor(cards, queue);
  // columnsFor already orders a column by priority then id, which is the default view's order.
  const cmp = v.sort === 'priority' && v.dir === 'asc' ? undefined : compareCards(v);
  const keys = Object.keys(grouped) as ColumnKey[];
  return keys.map((stage) => {
    const shown = grouped[stage].filter((c) => matches(c, v));
    // Queued is in queue order, which is the order beads start in: the sort never changes it.
    return { stage, shown: cmp && stage !== 'queued' ? shown.sort(cmp) : shown, total: grouped[stage].length };
  });
}

/** Children filtered and sorted. While filtering, epics with no shown child go, if the view says so. */
export function applyEpics(epics: Epic[], v: ViewState): Epic[] {
  const hide = v.hideEmptyEpics && isFiltering(v);
  const out: Epic[] = [];
  for (const e of epics) {
    const children = applyCards(e.children, v);
    if (hide && children.length === 0) continue;
    out.push({ ...e, children });
  }
  return out;
}

/* ---------- options and storage ---------- */

/** `epicTitles` has a title for each epic in `epics` whose own card is among the cards. */
export type ViewOptions = { types: string[]; repos: string[]; labels: string[]; epics: string[]; epicTitles: Record<string, string> };

/** Shortens text to `max` characters, ending in an ellipsis when it was cut. */
export function truncate(text: string, max = 40): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The epic select's text: the id, then the title when known. */
export function epicLabel(id: string, titles: Record<string, string>): string {
  return Object.hasOwn(titles, id) ? `${id} ${truncate(titles[id]!)}` : id;
}

/** Number of filters set. Sort is not one. A group with several values counts once. */
export function activeCount(v: ViewState): number {
  const lists = [v.status, v.stage, v.type, v.repo, v.label];
  return (
    lists.filter((l) => l.length > 0).length +
    (v.epic !== undefined ? 1 : 0) +
    (v.ready ? 1 : 0) +
    (v.blocked ? 1 : 0) +
    (v.text.trim() ? 1 : 0)
  );
}

const sorted = (s: Set<string>): string[] => [...s].sort((a, b) => a.localeCompare(b));

/** The values the filter lists offer, taken from the cards on screen. */
export function optionsFrom(cards: BeadCard[]): ViewOptions {
  const types = new Set<string>();
  const repos = new Set<string>();
  const labels = new Set<string>();
  const epics = new Set<string>();
  for (const c of cards) {
    types.add(c.type);
    if (c.repo) repos.add(c.repo);
    for (const l of c.labels) labels.add(l);
    if (c.parent) epics.add(c.parent);
  }
  const epicTitles: Record<string, string> = {};
  for (const c of cards) if (epics.has(c.id)) epicTitles[c.id] = c.title;
  return { types: sorted(types), repos: sorted(repos), labels: sorted(labels), epics: sorted(epics), epicTitles };
}

const keep = (list: string[], allowed: readonly string[]): string[] => {
  const kept = list.filter((x) => allowed.includes(x));
  return kept.length === list.length ? list : kept;
};

/**
 * Drops filter values that no longer exist (a repo or label that is gone). Returns the same object when nothing
 * was dropped, so callers can use identity to see "no change".
 */
export function pruneView(v: ViewState, o: ViewOptions): ViewState {
  const next: ViewState = {
    ...v,
    status: keep(v.status, STATUS_ORDER),
    stage: keep(v.stage, STAGE_ORDER),
    type: keep(v.type, o.types),
    repo: keep(v.repo, o.repos),
    label: keep(v.label, o.labels),
  };
  if (v.epic !== undefined && v.epic !== NO_EPIC && !o.epics.includes(v.epic)) delete next.epic;
  const same =
    next.status === v.status && next.stage === v.stage && next.type === v.type && next.repo === v.repo &&
    next.label === v.label && next.epic === v.epic;
  return same ? v : next;
}

const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);

/** Reads a stored view. Anything broken becomes the default, field by field. */
export function parseStoredView(raw: string | null, options?: ViewOptions): ViewState {
  if (raw === null) return DEFAULT_VIEW;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return DEFAULT_VIEW;
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return DEFAULT_VIEW;
  const r = o as Record<string, unknown>;
  const v: ViewState = {
    sort: SORT_KEYS.includes(r.sort as SortKey) ? (r.sort as SortKey) : DEFAULT_VIEW.sort,
    dir: r.dir === 'asc' || r.dir === 'desc' ? r.dir : DEFAULT_VIEW.dir,
    status: strings(r.status),
    stage: strings(r.stage),
    type: strings(r.type),
    repo: strings(r.repo),
    label: strings(r.label),
    ready: r.ready === true,
    blocked: r.blocked === true,
    text: typeof r.text === 'string' ? r.text : '',
    hideEmptyEpics: typeof r.hideEmptyEpics === 'boolean' ? r.hideEmptyEpics : DEFAULT_VIEW.hideEmptyEpics,
    hideClosed: typeof r.hideClosed === 'boolean' ? r.hideClosed : DEFAULT_VIEW.hideClosed,
  };
  if (typeof r.epic === 'string' && r.epic) v.epic = r.epic;
  return options ? pruneView(v, options) : v;
}
