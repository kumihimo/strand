import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, stateEntries, stateFile } from './state.ts';

export type SessionEntry = {
  sessionId: string;
  beadId: string;
  startedAt: string;
  endedAt?: string;
  transcriptPath?: string;
  branch?: string;
  archived?: boolean;
  /** The session this one took over in the same terminal (a /clear): the cockpit ends the whole chain. */
  replaces?: string;
  /** ISO time since when the session has stopped and waits for the engineer. Absent while it works, and once it ended. */
  needsYou?: string;
};

const SUB = 'sessions';

/** Where index entries are written. */
function indexDir(trackerDir: string): string {
  return stateDir(trackerDir, SUB);
}

/** Reject values that could escape a directory when used as a single path segment. */
export function assertSafeSegment(value: string, what: string): void {
  if (typeof value !== 'string' || !value || value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new Error(`invalid ${what}: ${String(value)}`);
  }
}

/** Where the session's entry is read: `.strand/`, else the pre-rename `.sdlc/`. Writes go to indexDir. */
function entryPath(trackerDir: string, sessionId: string): string {
  assertSafeSegment(sessionId, 'session id');
  return stateFile(trackerDir, SUB, `${sessionId}.json`);
}

/** Every entry of the index, from both folders, each session once. */
function allEntries(trackerDir: string): SessionEntry[] {
  const out: SessionEntry[] = [];
  for (const { name, path } of stateEntries(trackerDir, SUB)) {
    if (!name.endsWith('.json')) continue;
    const e = readEntry(path);
    if (e) out.push(e);
  }
  return out;
}

function readEntry(file: string): SessionEntry | undefined {
  try {
    const e = JSON.parse(readFileSync(file, 'utf8'));
    const opt = (v: unknown) => v === undefined || typeof v === 'string';
    if (
      e && typeof e.sessionId === 'string' && typeof e.beadId === 'string' && typeof e.startedAt === 'string' &&
      opt(e.endedAt) && opt(e.transcriptPath) && opt(e.branch) && opt(e.replaces) && opt(e.needsYou) &&
      (e.archived === undefined || typeof e.archived === 'boolean')
    ) {
      assertSafeSegment(e.sessionId, 'session id');
      assertSafeSegment(e.beadId, 'bead id');
      if (e.replaces !== undefined) assertSafeSegment(e.replaces, 'session id');
      return e as SessionEntry;
    }
  } catch {
    // unreadable or malformed: treated as absent
  }
  return undefined;
}

/** Write an entry to the index (also used to mark entries archived). */
export function writeEntry(trackerDir: string, e: SessionEntry): void {
  assertSafeSegment(e.sessionId, 'session id');
  const file = join(indexDir(trackerDir), `${e.sessionId}.json`);
  mkdirSync(indexDir(trackerDir), { recursive: true });
  writeFileSync(file, JSON.stringify(e, null, 2) + '\n');
}

export function recordStart(trackerDir: string, e: { sessionId: string; beadId: string; branch?: string; replaces?: string }): void {
  assertSafeSegment(e.beadId, 'bead id');
  if (e.replaces !== undefined) assertSafeSegment(e.replaces, 'session id');
  const entry: SessionEntry = { sessionId: e.sessionId, beadId: e.beadId, startedAt: new Date().toISOString() };
  if (e.branch) entry.branch = e.branch;
  if (e.replaces) entry.replaces = e.replaces;
  writeEntry(trackerDir, entry);
}

export function recordEnd(
  trackerDir: string,
  e: { sessionId: string; transcriptPath?: string; branch?: string },
): SessionEntry | undefined {
  const file = entryPath(trackerDir, e.sessionId);
  if (!existsSync(file)) return undefined;
  const cur = readEntry(file);
  if (!cur) return undefined;
  // An ended session never needs you.
  const { needsYou: _waiting, ...live } = cur;
  const next: SessionEntry = { ...live, endedAt: new Date().toISOString() };
  if (e.transcriptPath !== undefined) next.transcriptPath = e.transcriptPath;
  if (e.branch !== undefined) next.branch = e.branch;
  writeEntry(trackerDir, next);
  return next;
}

/** A resumed session is live again: clear its end, and its archive mark so the longer transcript is archived on the next end. */
export function recordResume(trackerDir: string, sessionId: string): SessionEntry | undefined {
  const cur = readEntry(entryPath(trackerDir, sessionId));
  if (!cur) return undefined;
  const { endedAt: _ended, archived: _archived, needsYou: _waiting, ...next } = cur;
  writeEntry(trackerDir, next);
  return next;
}

/**
 * The session has stopped and waits for the engineer, since `now`. Does nothing when the session has no index
 * entry or the entry is ended. A time already there is kept unless it is later than `now`. Returns whether the
 * file was written.
 */
export function markNeedsYou(trackerDir: string, sessionId: string, now: Date = new Date()): boolean {
  const cur = readEntry(entryPath(trackerDir, sessionId));
  if (!cur || cur.endedAt) return false;
  const at = now.toISOString();
  if (cur.needsYou !== undefined && cur.needsYou <= at) return false;
  writeEntry(trackerDir, { ...cur, needsYou: at });
  return true;
}

/**
 * The session works again. Does nothing when the session has no index entry or the entry is ended. The file is
 * not rewritten when there is no time to remove: PostToolUse calls this on every tool. Returns whether it was written.
 */
export function clearNeedsYou(trackerDir: string, sessionId: string): boolean {
  const cur = readEntry(entryPath(trackerDir, sessionId));
  if (!cur || cur.endedAt || cur.needsYou === undefined) return false;
  const { needsYou: _waiting, ...next } = cur;
  writeEntry(trackerDir, next);
  return true;
}

/**
 * Record the end of the session a cockpit terminal ran, when the SessionEnd hook could not (a kill ends the
 * hook too). The terminal names its session: the resumed one, or the id it gave a new one. That entry of the
 * bead is ended, and so is each entry of the bead that replaces it through `replaces` links (a /clear in the
 * terminal starts a new session), every branch of them. A successor counts only if it started at or after
 * the terminal: an older one ran elsewhere (a desktop /clear before the terminal resumed its session).
 * Nothing else is ended; an entry that already has an end keeps it. `transcriptOf` gives each ended entry its
 * transcript path. Returns the entries ended.
 */
export function endTerminalSession(
  trackerDir: string,
  t: { beadId: string; sessionId: string; startedAt: string },
  transcriptOf: (sessionId: string) => string | undefined = () => undefined,
): SessionEntry[] {
  const all = sessionsFor(trackerDir, t.beadId);
  const root = all.find((x) => x.sessionId === t.sessionId);
  const chain: SessionEntry[] = root ? [root] : [];
  const seen = new Set(chain.map((e) => e.sessionId));
  for (let i = 0; i < chain.length; i++) {
    const id = chain[i]!.sessionId;
    for (const e of all) {
      if (e.replaces !== id || seen.has(e.sessionId) || e.startedAt < t.startedAt) continue;
      seen.add(e.sessionId);
      chain.push(e);
    }
  }
  const out: SessionEntry[] = [];
  for (const e of chain) {
    if (e.endedAt) continue;
    const ended = recordEnd(trackerDir, { sessionId: e.sessionId, transcriptPath: transcriptOf(e.sessionId) });
    if (ended) out.push(ended);
  }
  return out;
}

export function beadForSession(trackerDir: string, sessionId: string): string | undefined {
  return readEntry(entryPath(trackerDir, sessionId))?.beadId;
}

/** Sessions that have started but not ended, oldest first. */
export function liveSessions(trackerDir: string): SessionEntry[] {
  return allEntries(trackerDir).filter((e) => !e.endedAt).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Every indexed session of one bead (live, ended or archived), oldest first. */
export function sessionsFor(trackerDir: string, beadId: string): SessionEntry[] {
  return allEntries(trackerDir).filter((e) => e.beadId === beadId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function pendingArchives(trackerDir: string): SessionEntry[] {
  return allEntries(trackerDir).filter((e) => e.endedAt && !e.archived).sort((a, b) => a.endedAt!.localeCompare(b.endedAt!));
}
