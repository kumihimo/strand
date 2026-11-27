import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordStart, recordEnd, recordResume, endTerminalSession, beadForSession, pendingArchives, liveSessions, writeEntry, sessionsFor, markNeedsYou, clearNeedsYou } from '../src/core/sessions.ts';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'strand-sessions-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('index lives under .strand/sessions and maps session to bead', () => {
  recordStart(dir, { sessionId: 's1', beadId: 'bd-a3f8.2' });
  assert.ok(existsSync(join(dir, '.strand', 'sessions', 's1.json')));
  assert.equal(beadForSession(dir, 's1'), 'bd-a3f8.2');
  assert.equal(beadForSession(dir, 'nope'), undefined);
});

test('recordStart overwrites previous entry', () => {
  recordStart(dir, { sessionId: 's1', beadId: 'bd-1' });
  recordStart(dir, { sessionId: 's1', beadId: 'bd-2' });
  assert.equal(beadForSession(dir, 's1'), 'bd-2');
});

test('recordEnd sets endedAt and transcriptPath; unknown id returns undefined', () => {
  recordStart(dir, { sessionId: 's1', beadId: 'bd-1' });
  const e = recordEnd(dir, { sessionId: 's1', transcriptPath: '/x/t.jsonl', branch: 'b' });
  assert.ok(e?.endedAt);
  assert.equal(e?.transcriptPath, '/x/t.jsonl');
  assert.equal(e?.branch, 'b');
  assert.equal(recordEnd(dir, { sessionId: 'ghost' }), undefined);
  assert.equal(existsSync(join(dir, '.strand', 'sessions', 'ghost.json')), false);
});

test('pendingArchives returns ended, unarchived, sorted; skips malformed', () => {
  recordStart(dir, { sessionId: 'a', beadId: 'bd-1' });
  recordStart(dir, { sessionId: 'b', beadId: 'bd-1' });
  recordStart(dir, { sessionId: 'c', beadId: 'bd-1' });
  recordEnd(dir, { sessionId: 'b' });
  recordEnd(dir, { sessionId: 'a' });
  writeFileSync(join(dir, '.strand', 'sessions', 'bad.json'), '{not json');
  const p = pendingArchives(dir);
  assert.deepEqual(p.map((e) => e.sessionId).sort(), ['a', 'b']);
  assert.ok(p[0].endedAt! <= p[1].endedAt!);
});

test('recordResume makes an ended, archived session live again; unknown id returns undefined', () => {
  writeEntry(dir, { sessionId: 's1', beadId: 'bd-1', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T01:00:00.000Z', transcriptPath: '/t', archived: true });
  const e = recordResume(dir, 's1');
  assert.equal(e?.endedAt, undefined);
  assert.equal(e?.archived, undefined);
  assert.equal(e?.transcriptPath, '/t');
  assert.deepEqual(liveSessions(dir).map((x) => x.sessionId), ['s1']);
  assert.equal(recordResume(dir, 'ghost'), undefined);
});

/** A terminal start before every entry in these tests. */
const T0 = '2026-01-01T00:00:00.000Z';

test('endTerminalSession ends exactly the terminal session, not another live one of the bead', () => {
  writeEntry(dir, { sessionId: 'old', beadId: 'bd-1', startedAt: '2026-01-01T00:00:00.000Z' });
  writeEntry(dir, { sessionId: 'mine', beadId: 'bd-1', startedAt: '2026-01-02T00:00:05.000Z' });
  // A desktop or CLI session on the same bead that started after the terminal did.
  writeEntry(dir, { sessionId: 'desktop', beadId: 'bd-1', startedAt: '2026-01-02T00:00:06.000Z' });
  writeEntry(dir, { sessionId: 'other', beadId: 'bd-2', startedAt: '2026-01-02T00:00:07.000Z' });
  const ended = endTerminalSession(dir, { beadId: 'bd-1', sessionId: 'mine', startedAt: T0 }, (sid) => `C:/t/${sid}.jsonl`);
  assert.deepEqual(ended.map((e) => e.sessionId), ['mine']);
  assert.ok(ended[0]!.endedAt);
  assert.equal(ended[0]!.transcriptPath, 'C:/t/mine.jsonl');
  assert.deepEqual(liveSessions(dir).map((x) => x.sessionId), ['old', 'desktop', 'other']);
  // A second call finds nothing more to end; a session of another bead is not ended.
  assert.deepEqual(endTerminalSession(dir, { beadId: 'bd-1', sessionId: 'mine', startedAt: T0 }), []);
  assert.deepEqual(endTerminalSession(dir, { beadId: 'bd-1', sessionId: 'other', startedAt: T0 }), []);
});

test('endTerminalSession keeps the end time the hook wrote', () => {
  writeEntry(dir, { sessionId: 'done', beadId: 'bd-1', startedAt: '2026-01-02T00:00:06.000Z', endedAt: '2026-01-02T00:01:00.000Z' });
  assert.deepEqual(endTerminalSession(dir, { beadId: 'bd-1', sessionId: 'done', startedAt: T0 }), []);
  assert.equal(sessionsFor(dir, 'bd-1')[0]?.endedAt, '2026-01-02T00:01:00.000Z');
});

test('endTerminalSession also ends the sessions that replace the terminal one through /clear, and nothing else', () => {
  // The terminal ran `t0`; /clear ended it (the hook wrote its end) and started `t1`, then `t2`.
  writeEntry(dir, { sessionId: 't0', beadId: 'bd-1', startedAt: '2026-01-02T00:00:00.000Z', endedAt: '2026-01-02T00:10:00.000Z', transcriptPath: 'C:/t/t0.jsonl' });
  writeEntry(dir, { sessionId: 't1', beadId: 'bd-1', startedAt: '2026-01-02T00:10:01.000Z', endedAt: '2026-01-02T00:20:00.000Z', replaces: 't0' });
  writeEntry(dir, { sessionId: 't2', beadId: 'bd-1', startedAt: '2026-01-02T00:20:01.000Z', replaces: 't1' });
  // Live on the same bead, started later, but not in the chain.
  writeEntry(dir, { sessionId: 'desktop', beadId: 'bd-1', startedAt: '2026-01-02T00:30:00.000Z' });
  // Names t0 but belongs to another bead: not followed.
  writeEntry(dir, { sessionId: 'odd', beadId: 'bd-2', startedAt: '2026-01-02T00:30:00.000Z', replaces: 't0' });
  const ended = endTerminalSession(dir, { beadId: 'bd-1', sessionId: 't0', startedAt: '2026-01-02T00:00:00.000Z' }, (sid) => `C:/t/${sid}.jsonl`);
  assert.deepEqual(ended.map((e) => [e.sessionId, e.transcriptPath]), [['t2', 'C:/t/t2.jsonl']]);
  assert.deepEqual(liveSessions(dir).map((x) => x.sessionId), ['desktop', 'odd']);
});

test('endTerminalSession on a resumed session does not end a desktop /clear successor that started before the terminal', () => {
  // Desktop session X did /clear and started Y (replaces X). Later the cockpit resumes X in a terminal.
  writeEntry(dir, { sessionId: 'x', beadId: 'bd-1', startedAt: '2026-01-01T00:00:00.000Z' });
  writeEntry(dir, { sessionId: 'y', beadId: 'bd-1', startedAt: '2026-01-01T01:00:00.000Z', replaces: 'x' });
  const ended = endTerminalSession(dir, { beadId: 'bd-1', sessionId: 'x', startedAt: '2026-01-02T00:00:00.000Z' });
  assert.deepEqual(ended.map((e) => e.sessionId), ['x']);
  assert.deepEqual(liveSessions(dir).map((e) => e.sessionId), ['y']);
});

test('endTerminalSession follows every entry that replaces an id, not only the first', () => {
  writeEntry(dir, { sessionId: 't0', beadId: 'bd-1', startedAt: '2026-01-02T00:00:00.000Z' });
  writeEntry(dir, { sessionId: 'a', beadId: 'bd-1', startedAt: '2026-01-02T00:10:00.000Z', replaces: 't0' });
  writeEntry(dir, { sessionId: 'b', beadId: 'bd-1', startedAt: '2026-01-02T00:11:00.000Z', replaces: 't0' });
  writeEntry(dir, { sessionId: 'c', beadId: 'bd-1', startedAt: '2026-01-02T00:12:00.000Z', replaces: 'b' });
  const ended = endTerminalSession(dir, { beadId: 'bd-1', sessionId: 't0', startedAt: '2026-01-02T00:00:00.000Z' });
  assert.deepEqual(ended.map((e) => e.sessionId).sort(), ['a', 'b', 'c', 't0']);
  assert.deepEqual(liveSessions(dir), []);
});

test('a replaces link is kept by recordStart and an unsafe one is refused', () => {
  recordStart(dir, { sessionId: 'n1', beadId: 'bd-1', replaces: 'o1' });
  assert.equal(sessionsFor(dir, 'bd-1')[0]?.replaces, 'o1');
  assert.throws(() => recordStart(dir, { sessionId: 'n2', beadId: 'bd-1', replaces: '../x' }));
});

const entryText = (sid: string) => readFileSync(join(dir, '.strand', 'sessions', `${sid}.json`), 'utf8');

test('markNeedsYou sets the time on a live entry and keeps an earlier one', () => {
  recordStart(dir, { sessionId: 's1', beadId: 'bd-1' });
  assert.equal(markNeedsYou(dir, 's1', new Date('2026-11-25T10:00:00.000Z')), true);
  assert.equal(sessionsFor(dir, 'bd-1')[0]?.needsYou, '2026-11-25T10:00:00.000Z');
  assert.equal(markNeedsYou(dir, 's1', new Date('2026-11-25T11:00:00.000Z')), false);
  assert.equal(sessionsFor(dir, 'bd-1')[0]?.needsYou, '2026-11-25T10:00:00.000Z');
  // The default time is now.
  recordStart(dir, { sessionId: 's2', beadId: 'bd-2' });
  markNeedsYou(dir, 's2');
  assert.match(sessionsFor(dir, 'bd-2')[0]?.needsYou ?? '', /^\d{4}-\d\d-\d\dT/);
});

test('markNeedsYou does nothing with no entry or an ended one', () => {
  assert.equal(markNeedsYou(dir, 'ghost'), false);
  assert.equal(existsSync(join(dir, '.strand', 'sessions', 'ghost.json')), false);
  recordStart(dir, { sessionId: 's1', beadId: 'bd-1' });
  recordEnd(dir, { sessionId: 's1' });
  const before = entryText('s1');
  assert.equal(markNeedsYou(dir, 's1'), false);
  assert.equal(entryText('s1'), before);
});

test('clearNeedsYou removes the time, and writes nothing when there is none', () => {
  writeEntry(dir, { sessionId: 's1', beadId: 'bd-1', startedAt: '2026-01-01T00:00:00.000Z', branch: 'b' });
  markNeedsYou(dir, 's1');
  assert.equal(clearNeedsYou(dir, 's1'), true);
  assert.deepEqual(sessionsFor(dir, 'bd-1'), [{ sessionId: 's1', beadId: 'bd-1', startedAt: '2026-01-01T00:00:00.000Z', branch: 'b' }]);
  // Already absent: the file is not rewritten. A different layout on disk would be lost by a rewrite.
  const compact = JSON.stringify({ sessionId: 's1', beadId: 'bd-1', startedAt: '2026-01-01T00:00:00.000Z' });
  writeFileSync(join(dir, '.strand', 'sessions', 's1.json'), compact);
  assert.equal(clearNeedsYou(dir, 's1'), false);
  assert.equal(entryText('s1'), compact);
  assert.equal(clearNeedsYou(dir, 'ghost'), false);
  assert.equal(existsSync(join(dir, '.strand', 'sessions', 'ghost.json')), false);
});

test('clearNeedsYou leaves an ended entry alone', () => {
  const ended = { sessionId: 's1', beadId: 'bd-1', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T01:00:00.000Z', needsYou: '2026-01-01T00:30:00.000Z' };
  writeEntry(dir, ended);
  const before = entryText('s1');
  assert.equal(clearNeedsYou(dir, 's1'), false);
  assert.equal(entryText('s1'), before);
});

test('recordEnd and recordResume drop the needs-you time', () => {
  recordStart(dir, { sessionId: 's1', beadId: 'bd-1' });
  markNeedsYou(dir, 's1');
  const ended = recordEnd(dir, { sessionId: 's1' });
  assert.ok(ended?.endedAt);
  assert.equal(ended?.needsYou, undefined);
  assert.equal(sessionsFor(dir, 'bd-1')[0]?.needsYou, undefined);
  // An entry ended by an older version may still carry the time: a resume clears it.
  writeEntry(dir, { sessionId: 's2', beadId: 'bd-2', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T01:00:00.000Z', needsYou: '2026-01-01T00:30:00.000Z' });
  const resumed = recordResume(dir, 's2');
  assert.equal(resumed?.needsYou, undefined);
  assert.equal(sessionsFor(dir, 'bd-2')[0]?.needsYou, undefined);
});

test('an entry with a needs-you time is read; one with a wrong type is skipped', () => {
  const d = join(dir, '.strand', 'sessions');
  mkdirSync(d, { recursive: true });
  const base = { beadId: 'bd-1', startedAt: '2026-01-01T00:00:00.000Z' };
  writeFileSync(join(d, 'a.json'), JSON.stringify({ ...base, sessionId: 'a', needsYou: '2026-01-01T00:30:00.000Z' }));
  writeFileSync(join(d, 'b.json'), JSON.stringify({ ...base, sessionId: 'b' }));
  writeFileSync(join(d, 'c.json'), JSON.stringify({ ...base, sessionId: 'c', needsYou: true }));
  assert.deepEqual(liveSessions(dir).map((e) => [e.sessionId, e.needsYou]), [['a', '2026-01-01T00:30:00.000Z'], ['b', undefined]]);
});

test('pendingArchives with no index dir is empty', () => {
  assert.deepEqual(pendingArchives(dir), []);
});

test('unsafe session ids are rejected', () => {
  for (const id of ['../x', 'a/b', 'a\\b', '..']) {
    assert.throws(() => recordStart(dir, { sessionId: id, beadId: 'bd-1' }));
  }
  mkdirSync(dir, { recursive: true });
});

test('unsafe bead ids are rejected', () => {
  for (const id of ['../x', '../../x', 'a/b', 'a\\b', '']) {
    assert.throws(() => recordStart(dir, { sessionId: 's1', beadId: id }));
  }
  recordStart(dir, { sessionId: 's1', beadId: 'bd-a3f8.2' });
});

test('entries with wrong field types or unsafe bead ids are skipped', () => {
  recordStart(dir, { sessionId: 'ok', beadId: 'bd-1' });
  recordEnd(dir, { sessionId: 'ok' });
  const d = join(dir, '.strand', 'sessions');
  const base = { sessionId: 'x', beadId: 'bd-1', startedAt: 't' };
  writeFileSync(join(d, 'x1.json'), JSON.stringify({ ...base, endedAt: 5 }));
  writeFileSync(join(d, 'x2.json'), JSON.stringify({ ...base, endedAt: 't', beadId: '../../x' }));
  writeFileSync(join(d, 'x3.json'), JSON.stringify({ ...base, endedAt: 't', archived: 'yes' }));
  assert.deepEqual(pendingArchives(dir).map((e) => e.sessionId), ['ok']);
});

/** An index entry written by a pre-rename plugin, under `.sdlc/sessions`. */
function legacyEntry(sid: string, e: Record<string, unknown>): void {
  const d = join(dir, '.sdlc', 'sessions');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${sid}.json`), JSON.stringify({ sessionId: sid, ...e }));
}

test('an entry only in the old .sdlc/sessions is read, and its update is written under .strand', () => {
  legacyEntry('old1', { beadId: 'b-1', startedAt: '2026-11-01T00:00:00.000Z' });
  assert.equal(beadForSession(dir, 'old1'), 'b-1');
  assert.deepEqual(liveSessions(dir).map((e) => e.sessionId), ['old1']);
  assert.deepEqual(sessionsFor(dir, 'b-1').map((e) => e.sessionId), ['old1']);
  const ended = recordEnd(dir, { sessionId: 'old1' });
  assert.ok(ended?.endedAt);
  assert.ok(JSON.parse(readFileSync(join(dir, '.strand', 'sessions', 'old1.json'), 'utf8')).endedAt);
  assert.equal(JSON.parse(readFileSync(join(dir, '.sdlc', 'sessions', 'old1.json'), 'utf8')).endedAt, undefined, 'the old file is kept as it was');
  assert.deepEqual(liveSessions(dir), [], 'the .strand copy wins over the old one');
  assert.deepEqual(pendingArchives(dir).map((e) => e.sessionId), ['old1']);
});

test('listings merge .strand and .sdlc entries, each session once', () => {
  legacyEntry('a', { beadId: 'b-1', startedAt: '2026-11-01T00:00:00.000Z' });
  legacyEntry('b', { beadId: 'b-1', startedAt: '2026-11-02T00:00:00.000Z' });
  recordStart(dir, { sessionId: 'b', beadId: 'b-2' });
  recordStart(dir, { sessionId: 'c', beadId: 'b-1' });
  assert.deepEqual(sessionsFor(dir, 'b-1').map((e) => e.sessionId), ['a', 'c']);
  assert.deepEqual(sessionsFor(dir, 'b-2').map((e) => e.sessionId), ['b']);
});
