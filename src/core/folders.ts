import { realpathSync } from 'node:fs';
import path from 'node:path';

/** True when two folder paths name the same folder (realpath when it exists; case-insensitive on win32). */
export function sameFolder(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (x: string) => {
    let r = x;
    try {
      r = realpathSync.native(x);
    } catch {
      // not on this machine: compare as written
    }
    const out = p.resolve(r);
    return platform === 'win32' ? out.toLowerCase() : out;
  };
  return norm(a) === norm(b);
}

/** True when two folder names under one parent name the same folder: case-insensitive on win32. */
export function sameRepoName(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The repo folder name for `cwd` when cwd sits directly in the workspace root, else undefined. */
export function repoNameIn(workspaceRoot: string, cwd: string): string | undefined {
  let real = cwd;
  try {
    real = realpathSync.native(cwd);
  } catch {
    return undefined;
  }
  return sameFolder(path.dirname(real), workspaceRoot) ? path.basename(real) : undefined;
}
