// Merged detection from plain git. No forge calls. Every function takes the repo dir,
// never throws, and answers "not merged" / "not open" on any git error.
import { run } from './exec.ts';

async function git(repoDir: string, args: string[]): Promise<string | undefined> {
  try {
    const r = await run('git', args, { cwd: repoDir, timeoutMs: 15000 });
    return r.code === 0 ? r.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** The `origin/HEAD` target (for example `origin/main`), else `origin/main`. */
export async function defaultRemoteBranch(repoDir: string): Promise<string> {
  const out = await git(repoDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const name = out?.trim();
  return name ? name : 'origin/main';
}

/** Commits on `refs/heads/<name>` that are not on the default remote branch. */
async function commitsBeyond(repoDir: string, name: string, format: string): Promise<string | undefined> {
  const head = `refs/heads/${name}`;
  if ((await git(repoDir, ['rev-parse', '--verify', '--quiet', head])) === undefined) return undefined;
  const base = await defaultRemoteBranch(repoDir);
  return git(repoDir, ['log', `--format=${format}`, `${base}..${head}`, '--']);
}

/** The branch exists and has commits that are not on the default remote branch. */
export async function branchOpen(repoDir: string, name: string): Promise<boolean> {
  const out = await commitsBeyond(repoDir, name, '%H');
  return out !== undefined && out.trim() !== '';
}

/** The numbers whose `(#<n>)` ends a subject in the last 500 commits of the default remote branch. */
export async function mergedPrNumbers(repoDir: string, numbers: number[]): Promise<number[]> {
  if (numbers.length === 0) return [];
  const base = await defaultRemoteBranch(repoDir);
  const out = await git(repoDir, ['log', '-500', '--format=%s', base, '--']);
  if (out === undefined) return [];
  const found = new Set<number>();
  for (const line of out.split(/\r?\n/)) {
    const m = /\(#(\d+)\)\s*$/.exec(line);
    if (m) found.add(Number(m[1]));
  }
  return numbers.filter((n) => found.has(n));
}

// A message written on Windows can end its lines in CRLF. JS `$` with the m flag already stops before `\r`;
// the `\r` in the class says so where it is read, and the CRLF test guards it.
const CHANGE_ID = /^Change-Id:[ \t]*(\S+)[ \t\r]*$/m;
const SEP = '\u0001';

/**
 * The branch has commits beyond the default remote branch, every one has a `Change-Id:` trailer,
 * and each id appears in the last 2000 commits of the default remote branch (a rebase or cherry-pick merge).
 */
export async function mergedByChangeId(repoDir: string, name: string): Promise<boolean> {
  const mine = await commitsBeyond(repoDir, name, `%B${SEP}`);
  if (mine === undefined) return false;
  const bodies = mine.split(SEP).filter((b) => b.trim() !== '');
  if (bodies.length === 0) return false;
  const ids: string[] = [];
  for (const b of bodies) {
    const id = CHANGE_ID.exec(b)?.[1];
    if (!id) return false;
    ids.push(id);
  }
  const base = await defaultRemoteBranch(repoDir);
  const main = await git(repoDir, ['log', '-2000', `--format=%B${SEP}`, base, '--']);
  if (main === undefined) return false;
  const onMain = new Set<string>();
  for (const b of main.split(SEP)) {
    const id = CHANGE_ID.exec(b)?.[1];
    if (id) onMain.add(id);
  }
  return ids.every((id) => onMain.has(id));
}
