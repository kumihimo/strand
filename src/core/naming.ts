import { branchesOf } from './facts.ts';

/** Turn a title into a lowercase ASCII slug of at most `max` characters, never ending in '-'. */
export function slugify(title: string, max = 40): string {
  const ascii = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let s = ascii;
  if (s.length > max) {
    const cut = s.slice(0, max);
    const dash = s[max] === '-' ? max : cut.lastIndexOf('-');
    s = dash > 0 ? s.slice(0, dash) : cut;
    s = s.replace(/-+$/, '');
  }
  return s === '' ? 'untitled' : s;
}

/** A repo folder name that cannot escape the workspace: no separators, not `.`/`..`, no `..` inside. Spaces are fine. */
export function isSafeRepoName(name: string): boolean {
  return name.trim() !== '' && name !== '.' && !name.includes('..') && !name.includes('/') && !name.includes('\\');
}

/** A name that may go in a `repo:` or `context:` label: a safe folder name, and no comma (bd splits labels on it). */
export function isRepoLabelName(name: string): boolean {
  return isSafeRepoName(name) && !name.includes(',');
}

// The terminal rules, shared by the manager, its routes, `strand work` and the UI. No Node imports here.

/** A Claude Code session id: a lowercase UUID. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What a cockpit terminal may run: `strand work`, `--specify` or `--resume`. */
export const TERMINAL_MODES = ['work', 'specify', 'resume'] as const;
/** Terminal size ranges, inclusive. */
export const TERMINAL_COLS = { min: 2, max: 500 } as const;
export const TERMINAL_ROWS = { min: 1, max: 300 } as const;
const inRange = (n: unknown, r: { min: number; max: number }): n is number => Number.isInteger(n) && (n as number) >= r.min && (n as number) <= r.max;
export const validCols = (n: unknown): n is number => inRange(n, TERMINAL_COLS);
export const validRows = (n: unknown): n is number => inRange(n, TERMINAL_ROWS);

// The model and effort of a Claude session started by `strand work`. They come from the config and the
// environment only, never from a request or a bead (ADR 0017).

/** Used when the config sets none. */
export const DEFAULT_CLAUDE_MODEL = 'opus';
export const DEFAULT_CLAUDE_EFFORT = 'high';
/** In the config, this value means: pass no flag, so Claude Code's own default applies. */
export const CLAUDE_DEFAULT = 'default';
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** An alias (`opus`) or a full model id, optionally with a suffix like `[1m]`. No spaces, no leading dash. */
const CLAUDE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;

export function isClaudeModel(v: unknown): v is string {
  return typeof v === 'string' && CLAUDE_MODEL.test(v);
}

export function isClaudeEffort(v: unknown): v is string {
  return v === CLAUDE_DEFAULT || (typeof v === 'string' && (CLAUDE_EFFORTS as readonly string[]).includes(v));
}

export { repoOf } from './facts.ts';

/** The bead's branch: the first `branch:` label for which isOpen is true, else the last one. */
export function beadBranch(b: { labels: string[] }, isOpen?: (name: string) => boolean): string | undefined {
  const names = branchesOf(b.labels);
  if (isOpen) {
    const open = names.find((n) => isOpen(n));
    if (open !== undefined) return open;
  }
  return names[names.length - 1];
}
