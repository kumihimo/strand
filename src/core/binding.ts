import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertSafeSegment } from './sessions.ts';
import { removeState, stateDir, stateEntries, stateFile } from './state.ts';

/** Per-session workflow state. Lives beside the session index, never on the bead. */
export type Binding = {
  bead?: string;
  none?: true;
  epic?: string;
  approved?: boolean;
  dirty?: boolean;
  nagged?: string;
  appTitle?: string;
  learnAsked?: boolean;
  handoverFrom?: string;
  /** The stage the last prompt reported, so a change is said once. */
  lastStage?: string;
  /** ISO time the engineer edited this bead's spec in the cockpit. The next prompt says so once, then clears it. */
  specEditedAt?: string;
};

/** `/clear` handover files start with this. They sit beside the bindings and are never one. */
const HANDOVER = 'handover-';

const SUB = 'bindings';

function dirOf(trackerDir: string): string {
  return stateDir(trackerDir, SUB);
}

/** Where the session's binding is written. */
function fileOf(trackerDir: string, sessionId: string): string {
  assertSafeSegment(sessionId, 'session id');
  return join(dirOf(trackerDir), `${sessionId}.json`);
}

/** Where the session's binding is read: `.strand/`, else the pre-rename `.sdlc/`. */
function readFileOf(trackerDir: string, sessionId: string): string {
  assertSafeSegment(sessionId, 'session id');
  return stateFile(trackerDir, SUB, `${sessionId}.json`);
}

function parse(file: string): Binding {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Binding) : {};
  } catch {
    return {};
  }
}

/** The session's binding, or `{}` when the file is absent or malformed. */
export function readBinding(trackerDir: string, sessionId: string): Binding {
  return parse(readFileOf(trackerDir, sessionId));
}

/** Windows refuses a rename over a file another process has open for a moment: these codes are worth a retry. */
const RENAME_RETRY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_TRIES = 5;
const RENAME_WAIT_MS = 15;

/** Rename `from` to `to`, retrying a few times when Windows reports it busy. On failure nothing is removed. */
export function retryRename(from: string, to: string): void {
  for (let i = 1; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= RENAME_TRIES || code === undefined || !RENAME_RETRY.has(code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_WAIT_MS);
    }
  }
}

/** Rename the temp file `from` over `to`, retrying as retryRename does. On failure `from` is removed. */
export function renameWithRetry(from: string, to: string): void {
  try {
    retryRename(from, to);
  } catch (e) {
    rmSync(from, { force: true });
    throw e;
  }
}

/** Write `text` to a temp file, then rename it over `file`, so a reader never sees half a file. */
export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameWithRetry(tmp, file);
}

export function writeBinding(trackerDir: string, sessionId: string, b: Binding): void {
  const file = fileOf(trackerDir, sessionId);
  mkdirSync(dirOf(trackerDir), { recursive: true });
  writeAtomic(file, JSON.stringify(b, null, 2) + '\n');
}

export function patchBinding(trackerDir: string, sessionId: string, p: Partial<Binding>): Binding {
  const next = { ...readBinding(trackerDir, sessionId), ...p };
  writeBinding(trackerDir, sessionId, next);
  return next;
}

export function clearBinding(trackerDir: string, sessionId: string): void {
  assertSafeSegment(sessionId, 'session id');
  removeState(trackerDir, SUB, `${sessionId}.json`);
}

/** Every session whose binding names this bead. */
export function bindingsFor(trackerDir: string, beadId: string): { sessionId: string; binding: Binding }[] {
  const out: { sessionId: string; binding: Binding }[] = [];
  for (const { name: f, path } of stateEntries(trackerDir, SUB)) {
    if (!f.endsWith('.json') || f.startsWith(HANDOVER)) continue;
    const binding = parse(path);
    if (binding.bead === beadId) out.push({ sessionId: f.slice(0, -'.json'.length), binding });
  }
  return out;
}

/** What SessionEnd leaves on `/clear` for the next session in the same folder. */
export type Handover = { cwd: string; bead: string; epic?: string; at: string; from?: string };

/** One handover per folder: `handover-<first 12 hex of sha256 of the lower-cased, forward-slashed cwd>.json`. */
function handoverName(cwd: string): string {
  const key = createHash('sha256').update(cwd.toLowerCase().replace(/\\/g, '/')).digest('hex').slice(0, 12);
  return `${HANDOVER}${key}.json`;
}

export function writeHandover(trackerDir: string, h: Handover): void {
  mkdirSync(dirOf(trackerDir), { recursive: true });
  writeAtomic(join(dirOf(trackerDir), handoverName(h.cwd)), JSON.stringify(h, null, 2) + '\n');
}

/** The handover left in this folder, or undefined when there is none or it is malformed. */
export function readHandover(trackerDir: string, cwd: string): Handover | undefined {
  const v = parse(stateFile(trackerDir, SUB, handoverName(cwd))) as Partial<Handover>;
  return typeof v.cwd === 'string' && typeof v.bead === 'string' && typeof v.at === 'string' ? (v as Handover) : undefined;
}

export function clearHandover(trackerDir: string, cwd: string): void {
  removeState(trackerDir, SUB, handoverName(cwd));
}
