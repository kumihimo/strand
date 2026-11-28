import type { BeadDetail } from '../../../src/cockpit/model.ts';
import type { TerminalInfo } from '../../../src/cockpit/pty.ts';
import { externalUrl } from '../../../src/core/links.ts';
import { SESSION_ID, TERMINAL_COLS, TERMINAL_ROWS } from '../../../src/core/naming.ts';
const RESUME_MAX = 5;
const UNAVAILABLE = 'terminals are not available';

export type SessionButtons = {
  start: boolean;
  specify: boolean;
  resume: { sessionId: string; label: string }[];
  /** The id of the live terminal to stop. */
  stop: string | undefined;
  /** Set when terminals are unavailable: the reason, shown with the copyable command. */
  fallback?: string;
};

const isLive = (t: TerminalInfo) => t.exited === undefined;

/**
 * Which session buttons the bead detail shows.
 * - Start specifying: Backlog only. Start session: any open bead. Both need no live terminal for the bead.
 * - Resume: sessions of the bead, newest first, at most five. One with no recorded end is offered too, marked
 *   "(live elsewhere)": with no live cockpit terminal it runs in another window, or was killed with the server.
 * - Stop: the bead's live terminal.
 */
export function sessionButtons(d: BeadDetail, terminals: TerminalInfo[], available: boolean, reason?: string): SessionButtons {
  if (!available) return { start: false, specify: false, resume: [], stop: undefined, fallback: reason || UNAVAILABLE };
  const live = terminals.find((t) => t.beadId === d.id && isLive(t));
  const open = d.status !== 'closed';
  const idle = open && !live;
  const resume = idle
    ? d.sessions
        .filter((s) => SESSION_ID.test(s.sessionId))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, RESUME_MAX)
        .map((s) => ({
          sessionId: s.sessionId,
          // No end recorded and no cockpit terminal for the bead: the tracker lists it live somewhere else.
          label: `${s.startedAt.replace('T', ' ').slice(0, 16)} · ${s.sessionId.slice(0, 8)}${s.endedAt ? '' : ' (live elsewhere)'}`,
        }))
    : [];
  return { start: idle, specify: idle && d.stage === 'backlog', resume, stop: live?.id };
}

/** Beads with a terminal that has not exited. */
export function liveBeadIds(terminals: TerminalInfo[]): Set<string> {
  return new Set(terminals.filter(isLive).map((t) => t.beadId));
}

/** The terminals of one bead for the pane tabs: live first, then newest first. */
export function terminalsOf(terminals: TerminalInfo[], beadId: string): TerminalInfo[] {
  return terminals
    .filter((t) => t.beadId === beadId)
    .sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.startedAt.localeCompare(a.startedAt));
}

export type SessionRow = { terminalId: string; beadId: string; title?: string; mode: string; since: string; exitCode?: number };

/** "just now" under a minute, then whole minutes, then whole hours. A start in the future counts as now. */
function relativeSince(startedAt: string, now: number): string {
  const secs = Math.floor((now - Date.parse(startedAt)) / 1000);
  if (!(secs >= 60)) return 'just now';
  const mins = Math.floor(secs / 60);
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h`;
}

/** The Sessions menu rows: live terminals, then ended ones, each group oldest first. A bead with no card has no title. */
export function sessionRows(terminals: TerminalInfo[], cards: { id: string; title: string }[], now: number): { live: SessionRow[]; ended: SessionRow[] } {
  const titles = new Map(cards.map((c) => [c.id, c.title]));
  const row = (t: TerminalInfo): SessionRow => ({
    terminalId: t.id,
    beadId: t.beadId,
    title: titles.get(t.beadId),
    mode: t.mode,
    since: relativeSince(t.startedAt, now),
    ...(t.exited ? { exitCode: t.exited.code } : {}),
  });
  const oldest = [...terminals].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return { live: oldest.filter(isLive).map(row), ended: oldest.filter((t) => !isLive(t)).map(row) };
}

/** A live session exists for the bead (the tracker's index) but none of the cockpit's terminals is it. */
export function liveElsewhere(card: { live: boolean } | undefined, terminals: TerminalInfo[], beadId: string): boolean {
  return !!card?.live && !terminals.some((t) => t.beadId === beadId && isLive(t));
}

export const encodeInput = (data: string): string => JSON.stringify({ type: 'input', data });
export const encodeResize = (cols: number, rows: number): string => JSON.stringify({ type: 'resize', cols, rows });

/** The server caps a whole input text frame at 64 KB. Parts stay under this, which leaves headroom. */
const FRAME_BUDGET = 60_000;
const QUEUE_CAP = 64 * 1024;
const encoder = new TextEncoder();

/** Bytes of the frame that would be sent for this text. JSON turns a control character into 6 bytes. */
export const frameBytes = (data: string): number => encoder.encode(encodeInput(data)).length;

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

/**
 * Split text so every input frame is under the server's cap, measured on the real frame. Parts start at
 * 16384 UTF-16 units and are halved while their frame is too big. A surrogate pair is never cut.
 */
export function chunkInput(data: string, maxUnits = 16384): string[] {
  const out: string[] = [];
  const emit = (s: string) => {
    if (s.length === 0) return;
    let mid = s.length >> 1;
    if (frameBytes(s) <= FRAME_BUDGET || s.length < 2) return void out.push(s);
    if (isHigh(s.charCodeAt(mid - 1))) mid -= 1;
    if (mid <= 0) return void out.push(s);
    emit(s.slice(0, mid));
    emit(s.slice(mid));
  };
  let i = 0;
  while (i < data.length) {
    let end = Math.min(i + maxUnits, data.length);
    if (end < data.length && isHigh(data.charCodeAt(end - 1))) end -= 1;
    emit(data.slice(i, end));
    i = end;
  }
  return out;
}

/** Total frame bytes of held input. */
export const queuedBytes = (queue: string[]): number => queue.reduce((n, s) => n + frameBytes(s), 0);

/** Hold keys typed while the socket is not open: in order, at most 64 KB of frames, oldest dropped first. */
export function pushInput(queue: string[], data: string, cap = QUEUE_CAP): string[] {
  const next = [...queue, ...chunkInput(data)];
  // Each part is measured once and the total kept as parts drop: re-measuring per drop was quadratic.
  const sizes = next.map(frameBytes);
  let total = sizes.reduce((n, s) => n + s, 0);
  let first = 0;
  while (next.length - first > 1 && total > cap) total -= sizes[first++]!;
  return first === 0 ? next : next.slice(first);
}

/** The server's resize range (TERMINAL_COLS, TERMINAL_ROWS). A fit that proposes more, or NaN, is clamped. */
export function clampSize(cols: number, rows: number): { cols: number; rows: number } {
  const fit = (n: number, r: { min: number; max: number }) => (Number.isNaN(n) ? r.min : Math.min(r.max, Math.max(r.min, Math.floor(n))));
  return { cols: fit(cols, TERMINAL_COLS), rows: fit(rows, TERMINAL_ROWS) };
}

/** Ctrl+Shift+F6: the way out of the terminal by keyboard (Tab and Escape belong to the program). */
export function isLeaveChord(e: { type: string; key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  return e.type === 'keydown' && e.key === 'F6' && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
}

/** The first target that exists and is not disabled: focus must never land on a disabled button. */
export function firstEnabled<T extends { disabled?: boolean }>(targets: (T | null | undefined)[]): T | undefined {
  return targets.find((t): t is T => !!t && !t.disabled);
}

/** The list with `t` added, or replacing the entry with the same id. Used to show a started terminal before the next fetch. */
export function withTerminal<L extends { terminals: TerminalInfo[] }>(list: L, t: TerminalInfo): L {
  return { ...list, terminals: [...list.terminals.filter((x) => x.id !== t.id), t] };
}

/** The one text frame the server sends: the process exit. Anything else is ignored. */
export function parseServerText(frame: string): { type: 'exit'; code: number } | undefined {
  let m: unknown;
  try {
    m = JSON.parse(frame);
  } catch {
    return undefined;
  }
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return undefined;
  const o = m as Record<string, unknown>;
  if (o.type === 'exit' && typeof o.code === 'number' && Number.isFinite(o.code)) return { type: 'exit', code: o.code };
  return undefined;
}

/** The terminal socket: same host and port as the page, `ws:` for http and `wss:` for https. */
export function socketUrl(loc: { protocol: string; host: string }, tid: string): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/api/terminals/${encodeURIComponent(tid)}/io`;
}

type Token = (name: string) => string;

/**
 * xterm colours from the terminal's own CSS tokens (`--term-*` on `.termhost` in `layout.css`), not the page theme.
 * `token` reads one custom property.
 */
export function terminalTheme(token: Token): { background: string; foreground: string; cursor: string; cursorAccent: string; selectionBackground: string } {
  const accent = token('--term-accent');
  return {
    background: token('--term-bg'),
    foreground: token('--term-text'),
    cursor: accent,
    cursorAccent: token('--term-bg'),
    // A hex accent gets about a third alpha for the selection; any other colour form is used as it is.
    selectionBackground: /^#[0-9a-f]{6}$/i.test(accent) ? `${accent}55` : accent,
  };
}

export const terminalFont = (token: Token): string => token('--term-mono') || 'Consolas, monospace';

/**
 * Open a link clicked in the terminal: an http(s) URL only, in a new window with no opener (a browser tab opens it
 * in a new tab; the desktop app hands it to the default browser). Anything else is dropped. True when opened.
 */
export function openTerminalLink(uri: string, open: (url: string, target: string, features: string) => unknown): boolean {
  const url = externalUrl(uri);
  if (url === undefined) return false;
  open(url, '_blank', 'noopener,noreferrer');
  return true;
}
