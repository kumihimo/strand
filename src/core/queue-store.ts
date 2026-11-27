import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renameWithRetry } from './binding.ts';
import { configPath } from './config.ts';
import { BEAD_ID } from './create-bead.ts';

/** `queue.json` beside the strand `config.json` (ADR 0023). */
export function queueFile(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(p.dirname(configPath(platform, env, home)), 'queue.json');
}

/** Whether `ids` is a list of distinct bead ids. */
function validIds(ids: unknown): ids is string[] {
  return Array.isArray(ids) && ids.every((id) => typeof id === 'string' && BEAD_ID.test(id)) && new Set(ids).size === ids.length;
}

/**
 * The queued ids, front first. A missing file is an empty queue. A file that cannot be read or is not
 * `{ version: 1, ids: [distinct bead ids] }` is an empty queue too, with one warning: the beads stay in Backlog.
 */
export function readQueue(file: string, warn: (line: string) => void = (l) => console.error(l)): string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warn(`strand: cannot read the queue ${file}: ${(e as Error).message}; treating it as empty`);
    return [];
  }
  try {
    const v = JSON.parse(text) as { version?: unknown; ids?: unknown } | null;
    if (v && typeof v === 'object' && !Array.isArray(v) && v.version === 1 && validIds(v.ids)) return [...v.ids];
  } catch {
    // Falls through to the warning.
  }
  warn(`strand: the queue ${file} is not valid; treating it as empty`);
  return [];
}

/**
 * Write the queue atomically (temp file, then rename), readable only by the user. POSIX: mode 0o600; on
 * Windows the file inherits the ACL of the user's config folder, as the cockpit key file does.
 */
export function writeQueue(file: string, ids: readonly string[]): void {
  if (!validIds(ids)) throw new Error('writeQueue: every entry must be a distinct bead id');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify({ version: 1, ids }) + '\n', { mode: 0o600, flag: 'wx' });
  renameWithRetry(tmp, file);
}
