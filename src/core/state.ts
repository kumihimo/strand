// The tracker's private state folder (`.strand/`), and the read fallback to its pre-rename name (ADR 0021).
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const STATE_DIR = '.strand';
/** The folder's name before the rename to Strand. Read when `.strand/` lacks an item; never written. */
export const LEGACY_STATE_DIR = '.sdlc';

/** Where `<sub>` items are written: `<tracker>/.strand/<sub>`. */
export function stateDir(trackerDir: string, sub: string): string {
  return join(trackerDir, STATE_DIR, sub);
}

function legacyDir(trackerDir: string, sub: string): string {
  return join(trackerDir, LEGACY_STATE_DIR, sub);
}

/** The file to read for `<sub>/<name>`: under `.strand/` when it is there, else under `.sdlc/` when that is, else the `.strand/` path. */
export function stateFile(trackerDir: string, sub: string, name: string): string {
  const current = join(stateDir(trackerDir, sub), name);
  if (existsSync(current)) return current;
  const legacy = join(legacyDir(trackerDir, sub), name);
  return existsSync(legacy) ? legacy : current;
}

/** The files of `<sub>`, by name, from both folders; a name in `.strand/` hides the same name in `.sdlc/`. */
export function stateEntries(trackerDir: string, sub: string): { name: string; path: string }[] {
  const out = new Map<string, string>();
  for (const dir of [legacyDir(trackerDir, sub), stateDir(trackerDir, sub)]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) out.set(name, join(dir, name));
  }
  return [...out].sort(([a], [b]) => a.localeCompare(b)).map(([name, path]) => ({ name, path }));
}

/** Remove `<sub>/<name>` from both folders, so a removed item does not come back from `.sdlc/`. */
export function removeState(trackerDir: string, sub: string, name: string): void {
  rmSync(join(stateDir(trackerDir, sub), name), { force: true });
  rmSync(join(legacyDir(trackerDir, sub), name), { force: true });
}
