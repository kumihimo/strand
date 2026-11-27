// The repo folders under the workspace root. Reads the file system: the UI must not import this file.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sameFolder } from './folders.ts';
import { isSafeRepoName } from './naming.ts';

/**
 * Names of the direct child folders of the workspace root that hold a `.git` entry, sorted ignoring case.
 * Folders in `exclude` (absolute paths, such as the tracker) are left out.
 */
export function listRepos(workspaceRoot: string, exclude: readonly string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(workspaceRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  return names
    .filter((n) => isSafeRepoName(n) && existsSync(join(workspaceRoot, n, '.git')))
    .filter((n) => !exclude.some((x) => sameFolder(join(workspaceRoot, n), x)))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b));
}

export type RepoList = { repos: string[]; at: string };

/** The repo list held in memory: read when made, read again only on refresh. */
export type RepoCache = { list(): RepoList; refresh(): RepoList };

export function createRepoCache(workspaceRoot: string, now: () => Date = () => new Date(), exclude: readonly string[] = []): RepoCache {
  const read = (): RepoList => ({ repos: listRepos(workspaceRoot, exclude), at: now().toISOString() });
  let current = read();
  return {
    list: () => current,
    refresh: () => (current = read()),
  };
}
