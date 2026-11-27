// Pure facts read from a bead's labels, notes and acceptance criteria.
// No Node imports: the UI imports this file.

export type Criterion = { text: string; ticked: boolean; check?: string; evidence?: string };

const CRITERION = /^\s*[-*]?\s*\[( |x|X)\]\s+(.*)$/;

/** Take a trailing `(<tag>: ...)` off the text. */
function takeSuffix(text: string, tag: string): { text: string; value?: string } {
  const m = new RegExp(`\\s*\\(${tag}:\\s*(.*)\\)\\s*$`).exec(text);
  if (!m) return { text };
  return { text: text.slice(0, m.index), value: m[1]!.trim() };
}

export function parseCriteria(text: string | undefined): Criterion[] {
  const out: Criterion[] = [];
  for (const line of (text ?? '').split(/\r?\n/)) {
    const m = CRITERION.exec(line);
    if (!m) continue;
    let rest = m[2]!;
    const c: Criterion = { text: '', ticked: m[1] !== ' ' };
    // Evidence comes last, then the check, so both can sit on one line.
    const ev = takeSuffix(rest, 'verified');
    rest = ev.text;
    const ck = takeSuffix(rest, 'check');
    rest = ck.text;
    c.text = rest.trim();
    if (ck.value !== undefined) c.check = ck.value;
    if (ev.value !== undefined) c.evidence = ev.value;
    out.push(c);
  }
  return out;
}

/** A criterion as one stored line: `- [ ] <text> (check: ...)`, ticked with `(verified: ...)` when it has evidence. */
export function criterionLine(c: Criterion): string {
  const check = c.check === undefined ? '' : ` (check: ${c.check})`;
  if (!c.ticked) return `- [ ] ${c.text}${check}`;
  return `- [x] ${c.text}${check}${c.evidence ? ` (verified: ${c.evidence})` : ''}`;
}

const squash = (s: string | undefined): string => (s ?? '').trim().replace(/\s+/g, ' ');

/** What makes two criteria the same one across an edit: text and check, trimmed, inner whitespace collapsed. */
export const criterionKey = (c: Pick<Criterion, 'text' | 'check'>): string => `${squash(c.text)}\u0000${squash(c.check)}`;

/** Each old criterion once, by text and check: the merged form of a new criterion. */
function pool(oldText: string | undefined): (c: Criterion) => string {
  const byKey = new Map<string, Criterion[]>();
  for (const c of parseCriteria(oldText)) {
    const k = criterionKey(c);
    byKey.set(k, [...(byKey.get(k) ?? []), c]);
  }
  return (c) => criterionLine(byKey.get(criterionKey(c))?.shift() ?? { ...c, ticked: false, evidence: undefined });
}

/**
 * The criteria in `newText`, in its order. One whose text and check match an old one keeps that old criterion,
 * tick and evidence included; any other starts unticked. Each old criterion is used once. Lines of `newText`
 * that are not criteria are dropped. The server saves this, and the edit form judges it.
 */
export function mergeCriteria(oldText: string | undefined, newText: string): string {
  return parseCriteria(newText).map(pool(oldText)).join('\n');
}

/**
 * The acceptance text of a bead not yet approved: stored as typed, line by line, except that a criterion line
 * whose text and check match an old one keeps its tick and evidence (as in mergeCriteria).
 */
export function mergeAcceptance(oldText: string | undefined, newText: string): string {
  const take = pool(oldText);
  return newText
    .split(/\r?\n/)
    .map((line) => {
      const c = parseCriteria(line)[0];
      return c ? take(c) : line;
    })
    .join('\n');
}

/** `(verified: )` with nothing in it is not evidence. */
export function hasEvidence(c: Criterion): boolean {
  return c.evidence !== undefined && c.evidence !== '';
}

export function allVerified(c: Criterion[]): boolean {
  return c.length > 0 && c.every((x) => x.ticked && hasEvidence(x));
}

export function unverifiedTicks(c: Criterion[]): number {
  return c.filter((x) => x.ticked && !hasEvidence(x)).length;
}

export function branchesOf(labels: string[]): string[] {
  return labels.filter((l) => l.startsWith('branch:') && l.length > 'branch:'.length).map((l) => l.slice('branch:'.length));
}

export function prsOf(labels: string[]): { owner: string; repo: string; number: number }[] {
  const out: { owner: string; repo: string; number: number }[] = [];
  for (const l of labels) {
    const m = /^pr:([^/#\s]+)\/([^/#\s]+)#(\d+)$/.exec(l);
    if (m) out.push({ owner: m[1]!, repo: m[2]!, number: Number(m[3]) });
  }
  return out;
}

/** The close reason of a bead whose PR merged. One wording for the hooks and the cockpit. */
export function mergedAsReason(repo: string, number: number): string {
  return `Merged as ${repo}#${number}`;
}

/** Repo folder name from the `repo:<folder-name>` label, if present. */
export function repoOf(b: { labels: string[] }): string | undefined {
  const label = b.labels.find((l) => l.startsWith('repo:') && l.length > 'repo:'.length);
  return label?.slice('repo:'.length);
}

function lastMatch(notes: string | undefined, re: RegExp): string | undefined {
  let found: string | undefined;
  for (const line of (notes ?? '').split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (m) found = m[1];
  }
  return found;
}

/** The ISO time of the last `plan-approved <ISO>` note line. */
export function planApprovedAt(notes: string | undefined): string | undefined {
  return lastMatch(notes, /^plan-approved (\S+)$/);
}

/** The hash on the last `criteria <hash>` note line. */
export function criteriaBaseline(notes: string | undefined): string | undefined {
  return lastMatch(notes, /^criteria (\S+)$/);
}

/** Bead ids of the form `<prefix>-xxx` or `<prefix>-xxx.N`, for any of `prefixes`, in the text that are in `known`. */
export function beadIdsIn(text: string, prefixes: readonly string[], known: ReadonlySet<string>): string[] {
  const alts = prefixes.filter((p) => p !== '').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (alts.length === 0) return [];
  const re = new RegExp(`\\b(?:${alts.join('|')})-[a-z0-9]{3,8}(\\.[0-9]+)*\\b`, 'g');
  return (text.match(re) ?? []).filter((id) => known.has(id));
}

/** Folder names from the `context:<folder>` labels, in label order, without duplicates. */
export function contextOf(labels: string[]): string[] {
  const out: string[] = [];
  for (const l of labels) {
    if (!l.startsWith('context:') || l.length === 'context:'.length) continue;
    const name = l.slice('context:'.length);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** The suggested story line and criterion form, shown as placeholders and in help text. */
export const STORY_FORM = 'As a ..., I want ..., so that ...';
export const CRITERION_FORM = '- [ ] <text> (check: <command>)';

/** What creating a bead needs: a title of at most 60 characters, and a parent epic for every non-epic. */
export function captureProblems(i: { title: string; type: string; parent?: string }): string[] {
  const out: string[] = [];
  if (i.title.length > 60) out.push('title is over 60 characters');
  if (i.type !== 'epic' && !i.parent) out.push('needs a parent epic');
  return out;
}

/**
 * What approving the spec needs (RFC 0003, amended): the story line (not for a chore or an epic), at least one
 * criterion (not for a chore), and every non-empty acceptance line in the criterion form with a check.
 */
export function specProblems(i: { type: string; description?: string; acceptance?: string }): string[] {
  const out: string[] = [];
  if (i.type !== 'chore' && i.type !== 'epic' && !/^\s*As an? .+, I want .+, so that .+/s.test(i.description ?? '')) {
    out.push(`description must open "${STORY_FORM}"`);
  }
  const lines = (i.acceptance ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  // An approved bead's criteria get ticked, and its edits are checked with these rules too. A ticked line
  // passes with a check or with evidence: the skill's tick format replaces the check with the evidence.
  const bad = lines.filter((l) => !/^- \[ \] \S.*\(check: .+\)|^- \[[xX]\] \S.*\((check|verified): .+\)/.test(l.trim())).length;
  if (i.type !== 'chore' && lines.length === 0) out.push('needs at least one acceptance criterion');
  if (bad > 0) out.push(`${bad} acceptance line${bad === 1 ? ' is' : 's are'} not in the form "${CRITERION_FORM}"`);
  return out;
}

/** A spec in Specify waits for the engineer when it has acceptance text and meets the approval rules. */
export function specReady(i: { type: string; description?: string; acceptance?: string }): boolean {
  return (i.acceptance ?? '').trim() !== '' && specProblems(i).length === 0;
}
