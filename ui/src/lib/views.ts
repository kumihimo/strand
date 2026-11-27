import type { Brief } from '../../../src/cli/commands/brief.ts';
import type { BeadCard, Epic } from '../../../src/cockpit/model.ts';
import { CRITERION_FORM, STORY_FORM, captureProblems } from '../../../src/core/facts.ts';
import { isRepoLabelName } from '../../../src/core/naming.ts';
import type { Stage } from '../../../src/core/stage.ts';
import { wipState, type ColumnKey } from './format.ts';

const byPriority = (a: { priority: number; id: string }, b: { priority: number; id: string }) =>
  a.priority - b.priority || a.id.localeCompare(b.id);

/* ---------- brief ---------- */

export type WaitingItem = { id: string; title: string; priority?: number };
export type Waiting = { approve: WaitingItem[]; review: WaitingItem[]; total: number };

/**
 * "Waiting on you", split for display. The server Brief already applies the rule: a `specify` bead whose
 * spec meets the approval rules waits for approval, a `review` bead waits for review.
 */
export function waitingOnYou(brief: Pick<Brief, 'waiting'>, cards: BeadCard[]): Waiting {
  const pri = new Map(cards.map((c) => [c.id, c.priority]));
  const item = (w: { id: string; title: string }): WaitingItem =>
    pri.has(w.id) ? { id: w.id, title: w.title, priority: pri.get(w.id) } : { id: w.id, title: w.title };
  const approve = brief.waiting.filter((w) => w.action === 'approve spec').map(item);
  const review = brief.waiting.filter((w) => w.action === 'review').map(item);
  return { approve, review, total: approve.length + review.length };
}

/** The header counts: beads in stage `review` (what the Review view lists) and cards awaiting spec approval. */
export function headerCounts(cards: Pick<BeadCard, 'stage' | 'awaitingApproval'>[]): { review: number; approve: number } {
  return {
    review: cards.filter((c) => c.stage === 'review').length,
    approve: cards.filter((c) => c.awaitingApproval).length,
  };
}

export type WipBar = { key: 'build' | 'review'; label: string; count: number; limit: number; pct: number; full: boolean };

export function wipBars(wip: Brief['wip']): WipBar[] {
  return (['build', 'review'] as const).map((key) => {
    const { count, limit } = wip[key];
    const full = wipState(count, limit) === 'full';
    const pct = limit > 0 ? Math.min(100, Math.round((count / limit) * 100)) : 100;
    return { key, label: key === 'build' ? 'Build' : 'Review', count, limit, pct, full };
  });
}

/**
 * Amber banners for stages at their WIP limit (review first). In `warn` mode nothing is refused, so the text
 * only warns; in `refuse` mode it says new Build work is paused.
 */
export function wipBanners(wip: Brief['wip'], mode: 'warn' | 'refuse' = 'warn'): string[] {
  const out: string[] = [];
  const bars = wipBars(wip);
  const review = bars.find((b) => b.key === 'review')!;
  const build = bars.find((b) => b.key === 'build')!;
  if (review.full) out.push(`Review is at its WIP limit (${review.count}/${review.limit})${mode === 'refuse' ? ' - new Build work is paused' : ''}`);
  if (build.full) out.push(`Build is at its WIP limit (${build.count}/${build.limit})${mode === 'refuse' ? ' - no new Build work starts until one finishes' : ''}`);
  return out;
}

export function greeting(d: Date): string {
  const h = d.getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const day = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  return `${part} · ${day}`;
}

/* ---------- epics ---------- */

export type SegmentKey = 'closed' | 'inProgress' | 'ready' | 'blocked' | 'other';
export type Segment = { key: SegmentKey; label: string; n: number; pct: number };

const SEGMENT_LABELS: Record<SegmentKey, string> = {
  closed: 'closed',
  inProgress: 'in progress',
  ready: 'ready',
  blocked: 'blocked',
  other: 'other',
};

/**
 * Progress bar segments from the model's counts over the child count. Children the counts do not cover
 * (e.g. open but waiting on a gate) show as "other", so the bar always sums to the child count.
 */
export function epicSegments(e: Pick<Epic, 'counts' | 'children'>): Segment[] {
  const { closed, inProgress, ready, blocked } = e.counts;
  const counted = closed + inProgress + ready + blocked;
  const total = Math.max(e.children.length, counted);
  const other = total - counted;
  const raw: [SegmentKey, number][] = [['closed', closed], ['inProgress', inProgress], ['ready', ready], ['blocked', blocked], ['other', other]];
  return raw
    .filter(([, n]) => n > 0)
    .map(([key, n]) => ({ key, label: SEGMENT_LABELS[key], n, pct: total ? (n / total) * 100 : 0 }));
}

/** The epic named in the route, else the first one. */
export function selectedEpic(epics: Epic[], id: string | undefined): Epic | undefined {
  return (id ? epics.find((e) => e.id === id) : undefined) ?? epics[0];
}

/* ---------- review queue ---------- */

/** Beads in stage `review`, by priority then id. */
export function reviewRows(cards: BeadCard[]): BeadCard[] {
  return cards.filter((c) => c.stage === 'review').sort(byPriority);
}

/* ---------- drag to Specify ---------- */

/** The `dataTransfer` type the board sets. A drop is accepted only when it is present. */
export const BEAD_DRAG_TYPE = 'application/x-strand-bead';

/** Whether a drag carries a card from this board (text and files dragged in from elsewhere do not). */
export const hasBeadDrag = (types: readonly string[]): boolean => types.includes(BEAD_DRAG_TYPE);

export type DropVerdict = { ok: true; action: 'specify' | 'release' | 'enqueue' | 'dequeue' } | { ok: false; reason: string };

const NOT_ALLOWED: Record<ColumnKey, string> = {
  backlog: 'Only a Specify bead can go back to Backlog.',
  queued: 'Only a Backlog bead can be queued.',
  specify: 'Only a Backlog bead can start specifying.',
  build: 'Build starts when you approve the spec.',
  verify: 'Verify starts when every criterion is verified.',
  review: 'Review starts when the PR is open and CI is green.',
  done: 'A bead closes when its PR merges.',
};

/**
 * What dropping `card` on column `to` does. The one place that decides: the board and the buttons ask here.
 * A stage is derived from facts, so only two moves exist: Backlog to Specify (start the session, which claims
 * the bead) and Specify to Backlog (release the claim, when no session is live). `live` is whether the
 * bead has a live terminal. The server checks both again.
 */
export function dropVerdict(card: Pick<BeadCard, 'stage' | 'held'>, to: ColumnKey, live: boolean, queued = false): DropVerdict {
  const from: ColumnKey = queued && card.stage === 'backlog' ? 'queued' : card.stage;
  if (from === to) return { ok: false, reason: '' };
  if (card.held) return { ok: false, reason: 'This bead is on hold.' };
  if (from === 'backlog' && to === 'queued') return { ok: true, action: 'enqueue' };
  if (from === 'queued' && to === 'backlog') return { ok: true, action: 'dequeue' };
  // Queued or not, a Backlog bead can start now; the queue drops it once it is claimed.
  if (card.stage === 'backlog' && to === 'specify') return { ok: true, action: 'specify' };
  if (card.stage === 'specify' && to === 'backlog') {
    return live ? { ok: false, reason: 'Stop the session first.' } : { ok: true, action: 'release' };
  }
  return { ok: false, reason: NOT_ALLOWED[to] };
}

/* ---------- new bead ---------- */

export const TYPE_GROUPS = [
  ['Code', ['feature', 'bug', 'task', 'chore', 'spike']],
  ['Playbooks', ['supplier-spec', 'security-review', 'eula-review', 'dpia', 'deck', 'rfc', 'decision', 'incident', 'retro']],
  ['Container', ['epic']],
] as const;

export const ALL_TYPES: readonly string[] = TYPE_GROUPS.flatMap(([, ts]) => ts);

export const PRIORITIES = [
  [0, 'P0 critical'],
  [1, 'P1 high'],
  [2, 'P2 normal'],
  [3, 'P3 low'],
  [4, 'P4 backlog'],
] as const;

/** Longest title the server accepts: the 60-character rule in captureProblems (src/core/facts.ts). */
export const TITLE_MAX = 60;

/** Suggestions only: a bead may be created with no description or criteria, and they are checked at approval. */
export const DESCRIPTION_PLACEHOLDER = STORY_FORM;
export const ACCEPTANCE_PLACEHOLDER = CRITERION_FORM;

/** The empty option of the Parent epic select. */
export const NO_PARENT_OPTION = '(none)';

export const NO_REPO_NOTE = 'No repo: this bead cannot start a session until one is set.';

/** `repos` is in the order they were ticked: the first is the primary repo, the rest are context folders. */
export type NewBeadForm = { title: string; type: string; priority: number; repos: string[]; parent: string; description: string; acceptance: string };
export type NewBeadErrors = Partial<Record<'title' | 'type' | 'priority' | 'repos' | 'parent' | 'description' | 'acceptance', string>>;
export type ValidBead = {
  title: string;
  type: string;
  priority: number;
  repo?: string;
  context?: string[];
  parent?: string;
  description?: string;
  acceptance?: string;
};

export const emptyForm = (): NewBeadForm => ({ title: '', type: 'feature', priority: 2, repos: [], parent: '', description: '', acceptance: '' });

/** Whether any field differs from a fresh form (a stray backdrop click must not throw input away). */
export function formTouched(f: NewBeadForm): boolean {
  const e = emptyForm();
  return (Object.keys(e) as (keyof NewBeadForm)[]).some((k) => JSON.stringify(f[k]) !== JSON.stringify(e[k]));
}

/** Which form field a capture or spec message (from src/core/facts.ts) belongs to. */
export function fieldOf(problem: string): 'title' | 'parent' | 'description' | 'acceptance' {
  if (problem.startsWith('title')) return 'title';
  if (problem.startsWith('description')) return 'description';
  if (problem.startsWith('needs a parent')) return 'parent';
  return 'acceptance';
}

/** Client-side mirror of src/core/create-bead.ts and the capture rules; the server stays the authority. */
export function validateNewBead(f: NewBeadForm): { ok: ValidBead } | { errors: NewBeadErrors } {
  const errors: NewBeadErrors = {};
  const title = f.title.trim();
  if (!title) errors.title = 'Title is required';
  else if (title.length > TITLE_MAX) errors.title = `Title is too long (${TITLE_MAX} characters at most)`;
  if (!ALL_TYPES.includes(f.type)) errors.type = `Unknown type ${f.type}`;
  if (!Number.isInteger(f.priority) || f.priority < 0 || f.priority > 4) errors.priority = 'Priority must be P0–P4';
  const bad = f.repos.find((r) => !isRepoLabelName(r));
  if (bad !== undefined) errors.repos = `Not a repo folder name: ${bad}`;
  const description = f.description.trim();
  const acceptance = f.acceptance.trim();
  const parent = f.parent.trim();
  for (const p of captureProblems({ title, type: f.type, parent })) {
    const k = fieldOf(p);
    if (k === 'title' || k === 'parent') errors[k] ??= p;
  }
  if (Object.keys(errors).length) return { errors };
  const ok: ValidBead = { title, type: f.type, priority: f.priority };
  const [repo, ...context] = f.repos;
  if (repo) ok.repo = repo;
  if (context.length) ok.context = context;
  if (description) ok.description = description;
  if (acceptance) ok.acceptance = acceptance;
  if (parent) ok.parent = parent;
  return { ok };
}

/* ---------- repos control ---------- */

/**
 * A repo list is the primary then the context folders. A leading empty entry (NO_PRIMARY) means there is no
 * primary: a bead with `context:` labels and no `repo:` label.
 */
export const NO_PRIMARY = '';

export const NEEDS_PRIMARY = 'Make one repo the primary before saving: context folders need a primary repo.';

/** Tick or untick a repo. Ticked repos keep the order they were ticked in, so the first one left is the primary. */
export function toggleRepo(repos: readonly string[], name: string): string[] {
  const next = repos.includes(name) ? repos.filter((r) => r !== name) : [...repos, name];
  return next.every((r) => r === NO_PRIMARY) ? [] : next;
}

/** Make a ticked repo the primary (first); the others keep their order. */
export function makePrimary(repos: readonly string[], name: string): string[] {
  if (name === NO_PRIMARY || !repos.includes(name)) return [...repos];
  return [name, ...repos.filter((r) => r !== name && r !== NO_PRIMARY)];
}

/** Whether the list has context folders but no primary repo. */
export const lacksPrimary = (repos: readonly string[]): boolean => repos[0] === NO_PRIMARY && repos.length > 1;

/** The repos whose name contains the filter text, ignoring case. */
export function filterRepos(all: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  return q ? all.filter((r) => r.toLowerCase().includes(q)) : [...all];
}
