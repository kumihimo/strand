import type { ArtefactFile, ArtefactList, BeadCard, BeadDetail, Relations } from '../../../src/cockpit/model.ts';
import type { Comment } from '../../../src/core/bd.ts';
import { CRITERION_FORM, captureProblems, criterionKey, hasEvidence, mergeCriteria, parseCriteria, specProblems } from '../../../src/core/facts.ts';
import type { Criterion } from '../../../src/core/facts.ts';
import type { ColumnKey } from './format.ts';
import { NEEDS_PRIMARY, NO_PRIMARY, fieldOf, lacksPrimary } from './views.ts';

export type Column = { key: ColumnKey; label: string; sub: string; gate?: boolean; wip?: 'build' | 'review' };

/** The board columns: one per stage, plus Queued. `gate` marks the column where you act (amber subtitle). */
export const COLUMNS: Column[] = [
  { key: 'backlog', label: 'Backlog', sub: 'triage · prioritise' },
  { key: 'queued', label: 'Queued', sub: 'starts by itself when there is room' },
  { key: 'specify', label: 'Specify', sub: '◆ approve spec', gate: true },
  { key: 'build', label: 'Build', sub: 'TDD: red → green → refactor', wip: 'build' },
  { key: 'verify', label: 'Verify', sub: 'tick criteria with evidence' },
  { key: 'review', label: 'Review', sub: 'PR open · review and merge', wip: 'review' },
  { key: 'done', label: 'Done', sub: 'closed · merged' },
];

const DOC_TYPES = new Set(['dpia', 'eula-review', 'deck', 'supplier-spec', 'security-review', 'rfc', 'retro', 'decision']);

/** Document-style beads get the purple card edge, as in the mockup. */
export const isDocType = (type: string): boolean => DOC_TYPES.has(type);

export type ApproveState = { show: boolean; disabled: boolean; reasons: string[] };

/** Approve spec shows in stage `specify` only; when the spec rules are not met it is disabled and lists why. */
export function approveState(d: Pick<BeadDetail, 'stage' | 'specProblems'>): ApproveState {
  if (d.stage !== 'specify') return { show: false, disabled: false, reasons: [] };
  return { show: true, disabled: d.specProblems.length > 0, reasons: [...d.specProblems] };
}

export type CriterionRow = { text: string; check?: string; evidence?: string; state: 'verified' | 'unverified' | 'open' };

/** Rows of the Criteria panel. Verified needs a tick and evidence; a tick alone, or empty evidence, is "unverified". */
export function criteriaRows(criteria: Criterion[]): CriterionRow[] {
  return criteria.map((c) => {
    const evidence = hasEvidence(c);
    const row: CriterionRow = { text: c.text, state: c.ticked ? (evidence ? 'verified' : 'unverified') : 'open' };
    if (c.check !== undefined) row.check = c.check;
    if (evidence) row.evidence = c.evidence;
    return row;
  });
}

/** How a PR shows: `owner/repo#n`, plus its url when the server has one (it opens through /api/open). */
export function prRef(pr: NonNullable<BeadCard['pr']>): { text: string; url?: string } {
  const text = `${pr.owner}/${pr.repo}#${pr.number}`;
  return pr.url ? { text, url: pr.url } : { text };
}

export const NOTE_MAX = 2000;

/** Why a request-changes note cannot be sent, if it cannot (the server takes 1 to 2000 characters). */
export function requestChangesProblem(note: string): string | undefined {
  if (note.trim() === '') return 'Write what needs to change';
  if (note.trim().length > NOTE_MAX) return `At most ${NOTE_MAX} characters`;
  return undefined;
}

/* ---------- edit form ---------- */

export type EditDraft = {
  title: string;
  description: string;
  /** After approval criterion lines only (`- [ ] <text> (check: <check>)`); before it, free text. */
  acceptance: string;
  design: string;
  type: string;
  priority: number;
  /** Empty when the bead has no parent. */
  parent: string;
  /** The primary repo, then the context folders. Empty for a bead with no repo. */
  repos: string[];
};

export type EditChanges = Partial<{
  title: string;
  description: string;
  acceptance: string;
  design: string;
  type: string;
  priority: number;
  parent: string;
  repo: string;
  context: string[];
}>;
export type EditProblems = Partial<Record<'title' | 'description' | 'acceptance' | 'type' | 'parent' | 'repos', string>>;

const editLine = (c: Criterion): string => `- [ ] ${c.text}${c.check === undefined ? '' : ` (check: ${c.check})`}`;

/** The stored criteria as edit lines: no ticks, no evidence, prose dropped. */
export function editableCriteria(acceptance: string | undefined): string {
  return parseCriteria(acceptance).map(editLine).join('\n');
}

const isApproved = (d: Pick<BeadDetail, 'planApprovedAt'>): boolean => d.planApprovedAt !== undefined;

/**
 * The stored acceptance text as the edit form shows it. After approval: criterion lines only (editableCriteria).
 * Before it: every line, with criterion lines in edit form (the server keeps ticks on unchanged ones).
 */
export function editableAcceptance(d: Pick<BeadDetail, 'acceptance' | 'planApprovedAt'>): string {
  if (isApproved(d)) return editableCriteria(d.acceptance);
  return (d.acceptance ?? '')
    .split(/\r?\n/)
    .map((line) => {
      const c = parseCriteria(line)[0];
      return c ? editLine(c) : line;
    })
    .join('\n')
    .trim();
}

/** The primary then the context folders; a leading NO_PRIMARY when there are context folders but no primary. */
export const reposOf = (d: Pick<BeadDetail, 'repo' | 'context'>): string[] => {
  const context = d.context ?? [];
  if (d.repo) return [d.repo, ...context];
  return context.length ? [NO_PRIMARY, ...context] : [];
};

/** The stored acceptance text has lines that are not criteria (an old chore); a save would drop them. */
export function hasProseLines(acceptance: string | undefined): boolean {
  const lines = (acceptance ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.length > parseCriteria(acceptance).length;
}

export function editDraft(d: BeadDetail): EditDraft {
  return {
    title: d.title,
    description: d.description ?? '',
    acceptance: editableAcceptance(d),
    design: d.design ?? '',
    type: d.type,
    priority: d.priority,
    parent: d.parent ?? '',
    repos: reposOf(d),
  };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Only the fields that differ from the bead. An untouched criteria field is never sent, so prose in it survives. */
export function draftChanges(d: BeadDetail, draft: EditDraft): EditChanges {
  const out: EditChanges = {};
  const title = draft.title.trim();
  if (title !== d.title) out.title = title;
  if (draft.description !== (d.description ?? '')) out.description = draft.description;
  if (draft.acceptance.trim() !== editableAcceptance(d)) out.acceptance = draft.acceptance.trim();
  if (draft.design !== (d.design ?? '')) out.design = draft.design;
  if (draft.type !== d.type) out.type = draft.type;
  if (draft.priority !== d.priority) out.priority = draft.priority;
  // The server cannot clear a parent; an empty one is never sent (draftProblems explains it).
  if (draft.parent && draft.parent !== (d.parent ?? '')) out.parent = draft.parent;
  // The whole set: the server replaces every repo and context label at once.
  if (!sameList(draft.repos, reposOf(d))) {
    out.repo = draft.repos[0] ?? '';
    out.context = draft.repos.slice(1);
  }
  return out;
}

/**
 * What is wrong with the result of saving, by field. Mirrors the server: before approval only the capture
 * rules; after it the spec rules too, and every acceptance line must be a criterion.
 */
export function draftProblems(d: BeadDetail, draft: EditDraft): EditProblems {
  const out: EditProblems = {};
  const put = (p: string) => {
    const k = fieldOf(p);
    out[k] ??= p.startsWith('needs at least one') ? `Add at least one criterion: ${CRITERION_FORM}` : p;
  };
  if (isApproved(d)) {
    const touched = draft.acceptance.trim() !== editableAcceptance(d);
    if (touched) {
      const stray = draft.acceptance.split(/\r?\n/).find((l) => l.trim() !== '' && parseCriteria(l).length === 0);
      if (stray !== undefined) out.acceptance = `criterion must start "- [ ] ": ${stray.trim()}`;
    }
    // As on the server, the spec rules run only when a field they read changed, and they judge the merged text:
    // a line that matches a stored criterion keeps its tick and evidence. An untouched field stands for the
    // stored criteria, whatever prose sits beside them.
    if (touched || draft.description !== (d.description ?? '') || draft.type !== d.type) {
      const acceptance = mergeCriteria(d.acceptance, touched ? draft.acceptance : (d.acceptance ?? ''));
      for (const p of specProblems({ type: draft.type, description: draft.description.trim(), acceptance })) put(p);
    }
  }
  for (const p of captureProblems({ title: draft.title.trim(), type: draft.type, parent: draft.parent })) put(p);
  if (!draft.title.trim()) out.title = 'Title is required';
  if (d.repo && d.branch && draft.repos[0] !== d.repo) out.repos = `This bead has a branch in ${d.repo}, so its primary repo cannot change.`;
  else if (lacksPrimary(draft.repos) && !sameList(draft.repos, reposOf(d))) out.repos = NEEDS_PRIMARY;
  return out;
}

/** Save and approve: only in stage `specify`, and the saved spec must meet the approval rules. */
export function saveAndApproveState(d: Pick<BeadDetail, 'stage'>, draft: EditDraft): { enabled: boolean; reason?: string } {
  if (d.stage !== 'specify') return { enabled: false, reason: 'Only a bead in Specify can be approved' };
  const problems = specProblems({ type: draft.type, description: draft.description.trim(), acceptance: draft.acceptance });
  if (problems.length) return { enabled: false, reason: problems.join('; ') };
  return { enabled: true };
}

export type DraftField = keyof EditDraft;
export type DraftValue = string | number | string[];
export type ConflictField = { field: DraftField; mine: DraftValue; theirs: DraftValue };

const DRAFT_FIELDS: DraftField[] = ['title', 'description', 'acceptance', 'design', 'type', 'priority', 'parent', 'repos'];

export const FIELD_LABEL: Record<DraftField, string> = {
  title: 'title',
  description: 'description',
  acceptance: 'acceptance criteria',
  design: 'spec body',
  type: 'type',
  priority: 'priority',
  parent: 'parent epic',
  repos: 'repos',
};

/** Whitespace around a title or the criteria is not a difference; repos compare in order. */
const norm = (v: DraftValue): string | number => (Array.isArray(v) ? JSON.stringify(v) : typeof v === 'string' ? v.trim() : v);
const same = (a: DraftValue, b: DraftValue): boolean => norm(a) === norm(b);

/**
 * Carry a draft over to a newer version of the bead (after a 409, or a background refresh).
 * - The user did not touch a field, the server changed it: take the server value (`taken`).
 * - The user touched it, the server did not: keep the user value.
 * - Both changed it to different values: a conflict. The draft keeps the user value until they choose.
 * `open` are conflicts still unresolved from an earlier rebase: they stay open (with the newest `theirs`)
 * until the server value matches the draft. Criteria compare as edit lines, so ticks and evidence never conflict.
 */
export function rebase(
  base: BeadDetail,
  current: BeadDetail,
  draft: EditDraft,
  open: ConflictField[] = [],
): { draft: EditDraft; base: BeadDetail; conflicts: ConflictField[]; taken: DraftField[] } {
  const was = editDraft(base);
  const now = editDraft(current);
  const next: EditDraft = { ...draft };
  const conflicts: ConflictField[] = [];
  const taken: DraftField[] = [];
  for (const k of DRAFT_FIELDS) {
    const mineChanged = !same(draft[k], was[k]);
    const theirsChanged = !same(now[k], was[k]);
    const wasOpen = open.some((c) => c.field === k);
    if (!mineChanged && theirsChanged) {
      (next as Record<DraftField, DraftValue>)[k] = now[k];
      taken.push(k);
    } else if ((mineChanged && theirsChanged) || wasOpen) {
      if (!same(draft[k], now[k])) conflicts.push({ field: k, mine: draft[k], theirs: now[k] });
    }
  }
  return { draft: next, base: current, conflicts, taken };
}

/** The lines of the stale notice, before any conflict. */
export function staleLines(taken: DraftField[]): string[] {
  const lines = ['This bead changed since you opened it.'];
  if (taken.length) lines.push(`Updated from the newer version: ${taken.map((k) => FIELD_LABEL[k]).join(', ')}.`);
  return lines;
}

/**
 * Whether a version differs from the form's while nothing is in flight. Used on each poll delivery (pass a
 * pending refetch as busy too) and again on the fetched result before it is applied.
 */
export function shouldRefetch(formVersion: string, polledVersion: string, busy: boolean): boolean {
  return !busy && polledVersion !== formVersion;
}

/** Every fetch gets a number when it is issued. A result is applied only if no later one was applied already. */
export function acceptResult(seq: number, lastApplied: number): boolean {
  return seq > lastApplied;
}

/**
 * After the freshness check before "Save and approve" with nothing to save: approve only if the form is
 * still mounted and the bead has not moved; a moved bead is rebased; an unmounted form does nothing.
 */
export function freshnessOutcome(mounted: boolean, fetchedVersion: string, formVersion: string): 'approve' | 'rebase' | 'gone' {
  if (!mounted) return 'gone';
  return fetchedVersion === formVersion ? 'approve' : 'rebase';
}

/** Criterion lines in `theirs` that `mine` does not have (text and check, whitespace collapsed): what "Keep mine" would remove. */
export function droppedCriteria(mine: string, theirs: string): string[] {
  const have = new Set(parseCriteria(mine).map(criterionKey));
  return parseCriteria(theirs)
    .filter((c) => !have.has(criterionKey(c)))
    // No checkbox: the list must not claim a tick state.
    .map((c) => `${c.text}${c.check === undefined ? '' : ` (check: ${c.check})`}`);
}

export function conflictSentence(field: DraftField): string {
  return field === 'acceptance'
    ? 'The acceptance criteria were changed on both sides.'
    : `The ${FIELD_LABEL[field]} was changed on both sides.`;
}

/** `a` then the items of `b` not in `a`. */
export function unionFields(a: DraftField[], b: DraftField[]): DraftField[] {
  return [...a, ...b.filter((k) => !a.includes(k))];
}

/** Why Save is off while conflicts are open. */
export function resolveReason(conflicts: ConflictField[]): string | undefined {
  if (conflicts.length === 0) return undefined;
  return `Resolve ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} first.`;
}

export const RELATION_LIMIT = 6;
export type RelationGroup = { label: string; ids: string[]; hidden: number };

/**
 * The relation groups to show, in order: Parent, Children, Blocked by, Blocks, Related, Discovered from, Spawned.
 * Empty groups are left out. A group longer than RELATION_LIMIT shows its first ones and counts the rest in `hidden`,
 * unless its label is in `expanded`.
 */
export function relationGroups(r: Relations, expanded: readonly string[] = []): RelationGroup[] {
  const all: [string, string[]][] = [
    ['Parent', r.parent ? [r.parent] : []],
    ['Children', r.children],
    ['Blocked by', r.blockedBy],
    ['Blocks', r.blocks],
    ['Related', r.related],
    ['Discovered from', r.discoveredFrom],
    ['Spawned', r.spawned],
  ];
  return all
    .filter(([, ids]) => ids.length > 0)
    .map(([label, ids]) => {
      const open = expanded.includes(label) || ids.length <= RELATION_LIMIT;
      return { label, ids: open ? ids : ids.slice(0, RELATION_LIMIT), hidden: open ? 0 : ids.length - RELATION_LIMIT };
    });
}

export const DESCRIPTION_LINES = 8;
export const DESIGN_LINES = 12;
const CLAMP_CHARS = 2000;

/**
 * The first `maxLines` lines of `text`, and no more than `maxChars` characters. `cut` says something was left out.
 * The cut never falls inside a surrogate pair.
 */
export function clampText(text: string, maxLines: number, maxChars: number = CLAMP_CHARS): { text: string; cut: boolean } {
  let out = text;
  let cut = false;
  const lines = out.split('\n');
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join('\n');
    cut = true;
  }
  if (out.length > maxChars) {
    let end = maxChars;
    const last = out.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    out = out.slice(0, end);
    cut = true;
  }
  return cut ? { text: out.trimEnd(), cut } : { text, cut };
}

/** Comments newest first (ISO timestamps; ties keep id order reversed). */
export function newestFirst(comments: Comment[]): Comment[] {
  return [...comments].sort((a, b) => b.created_at.localeCompare(a.created_at) || String(b.id).localeCompare(String(a.id)));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type PreviewKind = 'image' | 'html';

/** How a file previews inline: images (SVG too, as an <img>) and HTML in a sandboxed iframe. */
export function previewKind(f: Pick<ArtefactFile, 'kind'>): PreviewKind | undefined {
  if (f.kind === 'image' || f.kind === 'svg') return 'image';
  if (f.kind === 'html') return 'html';
  return undefined;
}

/** The file previewed by default: the first previewable kept file, else the first previewable scratch file. */
export function defaultPreview(a: ArtefactList): ArtefactFile | undefined {
  return [...a.kept, ...a.scratch].find((f) => previewKind(f));
}

/** Text shown after an Open click: the server answers `{ ok, target, dryRun }` under STRAND_COCKPIT_DRY_OPEN=1. */
export function openResultText(result: unknown, name: string): string {
  const r = (result ?? {}) as { dryRun?: unknown; target?: unknown };
  if (r.dryRun === true && typeof r.target === 'string') return `Would open ${r.target}`;
  return `Opened ${name}`;
}
