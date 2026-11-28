import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BeadDetail } from '../src/cockpit/model.ts';
import type { TerminalInfo } from '../src/cockpit/pty.ts';
import {
  chunkInput,
  clampSize,
  encodeInput,
  encodeResize,
  firstEnabled,
  isLeaveChord,
  liveBeadIds,
  liveElsewhere,
  openTerminalLink,
  parseServerText,
  pushInput,
  queuedBytes,
  sessionButtons,
  sessionRows,
  socketUrl,
  terminalFont,
  terminalTheme,
  terminalsOf,
  withTerminal,
} from '../ui/src/lib/terminal.ts';

const SID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

const detail = (o: Partial<BeadDetail> = {}): BeadDetail =>
  ({
    id: 'b-1', title: 't', type: 'task', priority: 2, status: 'open', stage: 'build',
    ready: true, blockedBy: [], live: false, needsYou: false, held: false, awaitingApproval: false, ciUnknown: false, labels: [],
    sessions: [], command: 'strand work b-1', editable: true, ...o,
  }) as BeadDetail;

const term = (o: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id: 't-1', beadId: 'b-1', mode: 'work', startedAt: '2026-11-23T10:00:00.000Z', ...o,
});

const ended = (n: number, startedAt: string) => ({ sessionId: SID(n), beadId: 'b-1', startedAt, endedAt: '2026-11-23T23:00:00.000Z' });

test('Start specifying shows in backlog only; Start session shows for any open bead', () => {
  const backlog = sessionButtons(detail({ stage: 'backlog' }), [], true);
  assert.equal(backlog.start, true);
  assert.equal(backlog.specify, true);
  for (const stage of ['specify', 'build', 'verify', 'review'] as const) {
    const b = sessionButtons(detail({ stage }), [], true);
    assert.equal(b.start, true, stage);
    assert.equal(b.specify, false, stage);
  }
});

test('a closed bead gets no start button and no resume', () => {
  const b = sessionButtons(detail({ stage: 'done', status: 'closed', sessions: [ended(1, '2026-11-20T10:00:00.000Z')] }), [], true);
  assert.deepEqual(b, { start: false, specify: false, resume: [], stop: undefined });
});

test('a live terminal turns start and resume off and offers Stop', () => {
  const s = [ended(1, '2026-11-20T10:00:00.000Z')];
  const b = sessionButtons(detail({ stage: 'backlog', sessions: s }), [term({ id: 'live-1' })], true);
  assert.equal(b.start, false);
  assert.equal(b.specify, false);
  assert.deepEqual(b.resume, []);
  assert.equal(b.stop, 'live-1');
});

test('an ended terminal or one for another bead does not count as live', () => {
  const ts = [term({ id: 'x', exited: { code: 0, at: '2026-11-23T10:05:00.000Z' } }), term({ id: 'y', beadId: 'b-2' })];
  const b = sessionButtons(detail(), ts, true);
  assert.equal(b.start, true);
  assert.equal(b.stop, undefined);
});

test('resume lists the sessions newest first, at most five, skipping malformed ids', () => {
  const sessions = [
    ended(0, '2026-10-31T10:00:00.000Z'),
    ended(1, '2026-11-01T10:00:00.000Z'),
    ended(2, '2026-11-02T10:00:00.000Z'),
    ended(3, '2026-11-03T10:00:00.000Z'),
    ended(4, '2026-11-04T10:00:00.000Z'),
    ended(5, '2026-11-05T10:00:00.000Z'),
    ended(6, '2026-11-06T10:00:00.000Z'),
    // No end recorded: a session in another window, or one killed with the server. The bead has no live terminal, so it is offered.
    { sessionId: SID(7), beadId: 'b-1', startedAt: '2026-11-07T10:00:00.000Z' },
    { sessionId: 'not an id --flag', beadId: 'b-1', startedAt: '2026-11-08T10:00:00.000Z', endedAt: '2026-11-08T11:00:00.000Z' },
  ];
  const r = sessionButtons(detail({ sessions }), [], true).resume;
  assert.deepEqual(r.map((x) => x.sessionId), [SID(7), SID(6), SID(5), SID(4), SID(3)]);
  assert.match(r[1]!.label, /2026-11-06 10:00/);
  assert.ok(r[1]!.label.includes(SID(6).slice(0, 8)));
  // The tracker lists SID(7) as live and no cockpit terminal runs it: it is marked.
  assert.ok(r[0]!.label.endsWith(' (live elsewhere)'), r[0]!.label);
  assert.ok(!r[1]!.label.includes('live elsewhere'), r[1]!.label);
});

test('firstEnabled skips missing and disabled targets', () => {
  const off = { disabled: true, id: 'off' };
  const on = { disabled: false, id: 'on' };
  const plain: { disabled?: boolean; id: string } = { id: 'plain' };
  assert.equal(firstEnabled([undefined, null, off, on]), on);
  assert.equal(firstEnabled([plain, on]), plain);
  assert.equal(firstEnabled([off, undefined]), undefined);
});

test('unavailable terminals give only the fallback reason', () => {
  const d = detail({ stage: 'backlog', sessions: [ended(1, '2026-11-01T10:00:00.000Z')] });
  const b = sessionButtons(d, [], false, 'node-pty failed to load');
  assert.deepEqual(b, { start: false, specify: false, resume: [], stop: undefined, fallback: 'node-pty failed to load' });
  assert.equal(sessionButtons(d, [], false).fallback, 'terminals are not available');
});

test('liveBeadIds: beads with a terminal that has not exited', () => {
  const ids = liveBeadIds([
    term({ id: 'a', beadId: 'b-1' }),
    term({ id: 'b', beadId: 'b-2', exited: { code: 1, at: 'x' } }),
    term({ id: 'c', beadId: 'b-3' }),
  ]);
  assert.deepEqual([...ids].sort(), ['b-1', 'b-3']);
  assert.equal(liveBeadIds([]).size, 0);
});

test('terminalsOf: one bead, live first, then newest', () => {
  const ts = [
    term({ id: 'old', startedAt: '2026-11-23T09:00:00.000Z', exited: { code: 0, at: 'x' } }),
    term({ id: 'other', beadId: 'b-2' }),
    term({ id: 'newer', startedAt: '2026-11-23T09:30:00.000Z', exited: { code: 0, at: 'x' } }),
    term({ id: 'live', startedAt: '2026-11-23T08:00:00.000Z' }),
  ];
  assert.deepEqual(terminalsOf(ts, 'b-1').map((t) => t.id), ['live', 'newer', 'old']);
});

test('frames are the JSON the server expects', () => {
  assert.deepEqual(JSON.parse(encodeInput('ls\r')), { type: 'input', data: 'ls\r' });
  assert.deepEqual(JSON.parse(encodeResize(120, 30)), { type: 'resize', cols: 120, rows: 30 });
});

const FRAME_CAP = 64 * 1024;

test('chunkInput measures the real JSON frame: control characters, emoji and mixes all stay under 64 KB', () => {
  assert.deepEqual(chunkInput(''), []);
  assert.deepEqual(chunkInput('abc'), ['abc']);
  const mixed = Array.from({ length: 30_000 }, (_, i) => ['\x1b', 'a', '\u{1F600}', '€', '\x01', '"', '\\', '\n'][i % 8]).join('');
  const cases: Record<string, string> = {
    esc: '\x1b'.repeat(100_000),
    soh: '\x01'.repeat(100_000),
    emoji: '\u{1F600}'.repeat(40_000),
    euro: '€'.repeat(100_000),
    quotes: '"'.repeat(100_000),
    mixed,
  };
  for (const [name, input] of Object.entries(cases)) {
    const parts = chunkInput(input);
    assert.equal(parts.join(''), input, `${name}: parts join back`);
    assert.ok(parts.length > 1, `${name}: split`);
    for (const p of parts) {
      assert.ok(Buffer.byteLength(encodeInput(p), 'utf8') < FRAME_CAP, `${name}: frame size`);
      assert.doesNotMatch(p, /^[\udc00-\udfff]|[\ud800-\udbff]$/, `${name}: no cut pair`);
    }
  }
});

test('clampSize keeps a resize inside the server range, whatever the fit proposes', () => {
  assert.deepEqual(clampSize(120, 30), { cols: 120, rows: 30 });
  assert.deepEqual(clampSize(900, 900), { cols: 500, rows: 300 });
  assert.deepEqual(clampSize(0, 0), { cols: 2, rows: 1 });
  assert.deepEqual(clampSize(-5, -5), { cols: 2, rows: 1 });
  assert.deepEqual(clampSize(Number.NaN, Number.NaN), { cols: 2, rows: 1 });
  assert.deepEqual(clampSize(Infinity, Infinity), { cols: 500, rows: 300 });
  assert.deepEqual(clampSize(80.7, 24.2), { cols: 80, rows: 24 });
});

test('pushInput keeps order, caps the held keys at 64 KB of frames and drops the oldest', () => {
  assert.deepEqual(pushInput([], 'ab'), ['ab']);
  assert.deepEqual(pushInput(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(pushInput(['a'], ''), ['a']);
  let q: string[] = [];
  for (let i = 0; i < 40; i++) q = pushInput(q, `${i % 10}`.repeat(5000));
  assert.ok(queuedBytes(q) <= FRAME_CAP);
  assert.ok(q.length > 1);
  assert.equal(q[q.length - 1], '9'.repeat(5000), 'newest kept');
  assert.equal(q[0]![0], String((40 - q.length) % 10), 'oldest dropped first');
  // One huge paste is split, and only its tail survives the cap.
  const big = pushInput([], '\x1b'.repeat(100_000));
  assert.ok(queuedBytes(big) <= FRAME_CAP);
  assert.ok(big.length >= 1);
});

test('pushInput measures each frame once: a 10 MB paste while connecting does not freeze the page', () => {
  const start = performance.now();
  // Re-measuring the whole queue per dropped part took about 2.5 s here; once per part is well under 1 s.
  const q = pushInput([], 'x'.repeat(10 * 1024 * 1024));
  const ms = performance.now() - start;
  assert.ok(queuedBytes(q) <= FRAME_CAP);
  assert.equal(q.at(-1)!.at(-1), 'x');
  assert.ok(ms < 1000, `took ${Math.round(ms)} ms`);
});

test('isLeaveChord: Ctrl+Shift+F6 on keydown only', () => {
  const k = (o: object) => ({ type: 'keydown', key: 'F6', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, ...o });
  assert.equal(isLeaveChord(k({})), true);
  assert.equal(isLeaveChord(k({ type: 'keyup' })), false);
  assert.equal(isLeaveChord(k({ shiftKey: false })), false);
  assert.equal(isLeaveChord(k({ ctrlKey: false })), false);
  assert.equal(isLeaveChord(k({ altKey: true })), false);
  assert.equal(isLeaveChord(k({ key: 'Escape' })), false);
});

test('withTerminal adds or replaces a terminal by id, keeping the rest of the list', () => {
  const a = term({ id: 'a' });
  const list = { available: true, terminals: [a] };
  assert.deepEqual(withTerminal(list, term({ id: 'b' })).terminals.map((t) => t.id), ['a', 'b']);
  const replaced = withTerminal(list, term({ id: 'a', exited: { code: 0, at: 'x' } }));
  assert.equal(replaced.terminals.length, 1);
  assert.deepEqual(replaced.terminals[0]!.exited, { code: 0, at: 'x' });
  assert.equal(replaced.available, true);
  assert.equal(list.terminals.length, 1, 'input untouched');
});

test('parseServerText: the exit frame only', () => {
  assert.deepEqual(parseServerText('{"type":"exit","code":3}'), { type: 'exit', code: 3 });
  assert.deepEqual(parseServerText('{"type":"exit","code":0}'), { type: 'exit', code: 0 });
  assert.equal(parseServerText('{"type":"exit"}'), undefined);
  assert.equal(parseServerText('{"type":"exit","code":"1"}'), undefined);
  assert.equal(parseServerText('{"type":"other","code":1}'), undefined);
  assert.equal(parseServerText('not json'), undefined);
  assert.equal(parseServerText('null'), undefined);
  assert.equal(parseServerText('[1]'), undefined);
});

test('socketUrl: same host, ws for http and wss for https, id escaped', () => {
  assert.equal(socketUrl({ protocol: 'http:', host: '127.0.0.1:4747' }, 'abc'), 'ws://127.0.0.1:4747/api/terminals/abc/io');
  assert.equal(socketUrl({ protocol: 'https:', host: 'h.test' }, 'a/b'), 'wss://h.test/api/terminals/a%2Fb/io');
});

test('terminalTheme comes from the terminal tokens, not the page theme', () => {
  // The page's shadcn tokens share names with the old palette (--accent, --muted): the terminal must not read them.
  const tokens: Record<string, string> = { '--term-bg': '#0f1115', '--term-text': '#e6e9ef', '--term-accent': '#7aa2ff', '--accent': 'oklch(0.97 0 0)', '--background': 'oklch(1 0 0)' };
  const t = terminalTheme((n) => tokens[n] ?? '');
  assert.equal(t.background, '#0f1115');
  assert.equal(t.foreground, '#e6e9ef');
  assert.equal(t.cursor, '#7aa2ff');
  assert.equal(t.selectionBackground, '#7aa2ff55');
  // A token that is not a plain hex colour is used as it is.
  assert.equal(terminalTheme((n) => (n === '--term-accent' ? 'rgb(1, 2, 3)' : '#000000')).selectionBackground, 'rgb(1, 2, 3)');
});

const T0 = Date.parse('2026-11-23T10:00:00.000Z');

test('sessionRows: live terminals oldest first, with titles; an unknown card has no title', () => {
  const ts = [
    term({ id: 't-b', beadId: 'b-2', mode: 'specify', startedAt: '2026-11-23T09:50:00.000Z' }),
    term({ id: 't-a', beadId: 'b-1', startedAt: '2026-11-23T09:00:00.000Z' }),
  ];
  const { live, ended } = sessionRows(ts, [{ id: 'b-1', title: 'First' }], T0);
  assert.deepEqual(live.map((r) => r.terminalId), ['t-a', 't-b']);
  assert.equal(live[0].title, 'First');
  assert.equal(live[0].mode, 'work');
  assert.equal(live[1].title, undefined);
  assert.equal(live[1].beadId, 'b-2');
  assert.deepEqual(ended, []);
});

test('sessionRows: ended terminals are listed apart with their exit code', () => {
  const ts = [
    term({ id: 't-x', startedAt: '2026-11-23T09:55:00.000Z', exited: { code: 3, at: '2026-11-23T09:58:00.000Z' } }),
    term({ id: 't-l', beadId: 'b-2', startedAt: '2026-11-23T09:59:00.000Z' }),
  ];
  const { live, ended } = sessionRows(ts, [], T0);
  assert.deepEqual(live.map((r) => r.terminalId), ['t-l']);
  assert.deepEqual(ended.map((r) => [r.terminalId, r.exitCode]), [['t-x', 3]]);
  assert.equal(live[0].exitCode, undefined);
});

test('sessionRows: relative times at 0 s, 59 s, 5 min and 2 h', () => {
  const since = (ms: number) => sessionRows([term({ startedAt: new Date(T0 - ms).toISOString() })], [], T0).live[0].since;
  assert.equal(since(0), 'just now');
  assert.equal(since(59_000), 'just now');
  assert.equal(since(5 * 60_000), '5 min');
  assert.equal(since(2 * 3_600_000), '2 h');
  assert.equal(since(60_000), '1 min');
  assert.equal(since(3_599_000), '59 min');
  assert.equal(since(3_600_000), '1 h');
  // A malformed start time never prints NaN.
  assert.equal(sessionRows([term({ startedAt: 'not a date' })], [], T0).live[0].since, 'just now');
  // A start time in the future (clock skew) is not negative.
  assert.equal(since(-30_000), 'just now');
});

test('liveElsewhere: a live card with no cockpit terminal for the bead', () => {
  assert.equal(liveElsewhere({ live: true }, [], 'b-1'), true);
  assert.equal(liveElsewhere({ live: true }, [term()], 'b-1'), false);
  assert.equal(liveElsewhere({ live: false }, [], 'b-1'), false);
  assert.equal(liveElsewhere(undefined, [], 'b-1'), false);
  // A terminal of another bead, or one that has exited, does not cover it.
  assert.equal(liveElsewhere({ live: true }, [term({ beadId: 'b-2' })], 'b-1'), true);
  assert.equal(liveElsewhere({ live: true }, [term({ exited: { code: 0, at: 'x' } })], 'b-1'), true);
});

test('terminalFont: the terminal mono token, with a fallback', () => {
  assert.equal(terminalFont((n) => (n === '--term-mono' ? 'Consolas, monospace' : '')), 'Consolas, monospace');
  assert.match(terminalFont(() => ''), /monospace$/);
});

test('openTerminalLink opens only http(s) links, in a new window with no opener', () => {
  const calls: unknown[][] = [];
  const open = (...a: unknown[]) => {
    calls.push(a);
    return null;
  };
  assert.equal(openTerminalLink('https://github.com/o/r/pull/1', open), true);
  assert.deepEqual(calls, [['https://github.com/o/r/pull/1', '_blank', 'noopener,noreferrer']]);
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'vscode://x', 'https://u:p@h/', 'nope']) {
    assert.equal(openTerminalLink(u, open), false, u);
  }
  assert.equal(calls.length, 1);
});
