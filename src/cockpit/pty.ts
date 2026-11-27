import { randomUUID } from 'node:crypto';
import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { BEAD_ID } from '../core/create-bead.ts';
import { SESSION_ID, TERMINAL_MODES, validCols, validRows } from '../core/naming.ts';
import { Ring } from './ring.ts';

export type PtyProcess = {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
};

export type SpawnPty = (
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number },
) => PtyProcess;

export type TerminalMode = (typeof TERMINAL_MODES)[number];

export type TerminalInfo = {
  id: string;
  beadId: string;
  mode: TerminalMode;
  startedAt: string;
  exited?: { code: number; at: string };
};

const MAX_EXITED_KEPT = 20;
const MODES: readonly string[] = TERMINAL_MODES;
export const MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_RING_BYTES = 1024 * 1024;
const DEFAULT_KEEP_EXITED_MS = 10 * 60 * 1000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export class TerminalLimitError extends Error {
  constructor(max: number) {
    super(`terminal limit reached (${max})`);
    this.name = 'TerminalLimitError';
  }
}

export class TerminalBusyError extends Error {
  constructor() {
    super('this bead already has a live terminal');
    this.name = 'TerminalBusyError';
  }
}

/** One line from an error, for messages shown in a pane. */
export function oneLine(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error';
}

/**
 * On Windows, node-pty 1.1.0 frees the conout worker thread and the pseudoconsole only inside
 * `kill()`. A child that exits on its own would keep the event loop alive and leave one conhost
 * behind. Calling `kill()` after the exit is wrong: it forks a helper against a dead pid and later
 * calls `process.kill` on a pid Windows may have reused. So we do the same two release steps here.
 *
 * These are private fields of node-pty 1.1.0 (`_agent._conoutSocketWorker`, `_agent._ptyNative`,
 * `_agent._pty`, `_agent._useConptyDll`), used because the package has no public dispose on Windows.
 * This is safe only because the version is pinned exactly. Re-check on any version change.
 * If a field is missing, do nothing rather than throw.
 */
function releaseWindowsConsole(p: unknown): void {
  if (process.platform !== 'win32') return;
  const agent = (p as { _agent?: Record<string, unknown> })._agent;
  if (!agent) return;
  try {
    const worker = agent._conoutSocketWorker as { dispose?: () => void } | undefined;
    if (worker && typeof worker.dispose === 'function') worker.dispose();
  } catch {
    // Already released.
  }
  try {
    const native = agent._ptyNative as { kill?: (pty: unknown, useConptyDll: boolean) => void } | undefined;
    if (native && typeof native.kill === 'function' && agent._pty !== undefined) {
      native.kill(agent._pty, agent._useConptyDll === true);
    }
  } catch {
    // Already closed.
  }
}

/** The file calls `ensureSpawnHelperExecutable` makes: a file's mode (`undefined` when it is missing) and chmod. */
export type HelperFs = {
  mode(file: string): number | undefined;
  chmod(file: string, mode: number): void;
};

const realHelperFs: HelperFs = {
  mode: (file) => statSync(file, { throwIfNoEntry: false })?.mode,
  chmod: (file, mode) => chmodSync(file, mode),
};

/**
 * node-pty 1.1.0 ships its macOS `spawn-helper` without the execute bit, so every spawn fails with
 * `posix_spawnp failed`. Add the execute bits to each `spawn-helper` node-pty may use (the folders its
 * native loader tries), keeping the other mode bits. Only on darwin, where the helper is used.
 * Returns a one-line error naming the helper when it cannot be checked or fixed; never throws.
 */
export function ensureSpawnHelperExecutable(
  platform: NodeJS.Platform,
  arch: string,
  ptyDir: string,
  fs: HelperFs,
): string | undefined {
  if (platform !== 'darwin') return undefined;
  const dirs = [join('build', 'Release'), join('build', 'Debug'), join('prebuilds', `darwin-${arch}`)];
  for (const dir of dirs) {
    const file = join(ptyDir, dir, 'spawn-helper');
    try {
      const mode = fs.mode(file);
      if (mode === undefined || (mode & 0o111) === 0o111) continue;
      fs.chmod(file, (mode & 0o7777) | 0o111);
    } catch (e) {
      return `node-pty spawn-helper is not executable: ${file} (${oneLine(e)})`;
    }
  }
  return undefined;
}

export type LoadNodePtyDeps = { platform?: NodeJS.Platform; arch?: string; fs?: HelperFs };

/** Load `node-pty` on first use. Never throws: a missing or broken module returns `{ error }`. */
export async function loadNodePty(deps: LoadNodePtyDeps = {}): Promise<{ spawn: SpawnPty } | { error: string }> {
  try {
    const mod = (await import('node-pty')) as unknown as Record<string, unknown> & { default?: Record<string, unknown> };
    const platform = deps.platform ?? process.platform;
    if (platform === 'darwin') {
      const ptyDir = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
      const helperError = ensureSpawnHelperExecutable(platform, deps.arch ?? process.arch, ptyDir, deps.fs ?? realHelperFs);
      if (helperError) return { error: helperError };
    }
    const spawn = (mod.spawn ?? mod.default?.spawn) as
      | ((file: string, args: string[], opts: Record<string, unknown>) => PtyProcess)
      | undefined;
    if (typeof spawn !== 'function') return { error: 'node-pty has no spawn function' };
    return {
      spawn: (file, args, opts) => {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(opts.env)) if (typeof v === 'string') env[k] = v;
        const p = spawn(file, args, { name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env });
        let exited = false;
        let killed = false;
        // Release the Windows console of a child that ended on its own, once and quietly.
        p.onExit(() => {
          exited = true;
          if (!killed) releaseWindowsConsole(p);
        });
        return {
          pid: p.pid,
          write: (d) => p.write(d),
          resize: (c, r) => p.resize(c, r),
          kill: () => {
            // Never kill a dead pid: node-pty would fork a helper against it and may kill a reused pid.
            if (exited) return;
            if (killed) {
              // The first kill did not take: end the child itself. Still before its exit, so the pid is its own.
              try {
                process.kill(p.pid);
              } catch {
                // Already gone.
              }
              return;
            }
            killed = true;
            p.kill();
          },
          onData: (cb) => void p.onData(cb),
          onExit: (cb) => void p.onExit((e: { exitCode: number }) => cb({ exitCode: e.exitCode })),
        };
      },
    };
  } catch (e) {
    return { error: oneLine(e) };
  }
}

type Listener = { onData: (chunk: Buffer) => void; onExit: (code: number) => void };

type Entry = {
  info: TerminalInfo;
  pty: PtyProcess;
  ring: Ring;
  listeners: Set<Listener>;
  killing: boolean;
  /** The Claude session the terminal runs: the resumed one, or the new one's id made by `start`. */
  sessionId: string;
  /** onEnded has been called for this terminal. */
  endReported: boolean;
  exitedAtMs?: number;
};

/** What `onEnded` is told about a terminal that ended. */
export type EndedTerminal = { beadId: string; startedAt: string; sessionId: string };

export class Terminals {
  readonly #o: {
    spawn: SpawnPty;
    nodePath: string;
    cliPath: string;
    maxSessions: number;
    ringBytes: number;
    keepExitedMs: number;
    now: () => number;
    env: NodeJS.ProcessEnv;
    onEnded?: (t: EndedTerminal) => void;
    onExited?: (t: EndedTerminal) => void;
  };
  readonly #entries = new Map<string, Entry>();

  constructor(o: {
    spawn: SpawnPty;
    nodePath: string;
    cliPath: string;
    maxSessions: number;
    ringBytes?: number;
    keepExitedMs?: number;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
    /** Called once per terminal when it exits, or when killAll stops it (the exit may never be seen). */
    onEnded?: (t: EndedTerminal) => void;
    /** Called once per terminal when its process has exited, after onEnded. A killAll does not call it. */
    onExited?: (t: EndedTerminal) => void;
  }) {
    this.#o = {
      spawn: o.spawn,
      nodePath: o.nodePath,
      cliPath: o.cliPath,
      maxSessions: o.maxSessions,
      ringBytes: o.ringBytes ?? DEFAULT_RING_BYTES,
      keepExitedMs: o.keepExitedMs ?? DEFAULT_KEEP_EXITED_MS,
      now: o.now ?? Date.now,
      env: o.env ?? process.env,
      onEnded: o.onEnded,
      onExited: o.onExited,
    };
  }

  #ended(e: Entry): EndedTerminal {
    return { beadId: e.info.beadId, startedAt: e.info.startedAt, sessionId: e.sessionId };
  }

  /** Tell `onEnded` about the terminal, once. A throw is reported and does not stop the caller. */
  #reportEnded(e: Entry): void {
    if (e.endReported || !this.#o.onEnded) return;
    e.endReported = true;
    try {
      this.#o.onEnded(this.#ended(e));
    } catch (err) {
      console.error(`strand: recording the end of a terminal failed: ${oneLine(err)}`);
    }
  }

  /** Tell `onExited` the process is gone. Called from the exit event only, so once. */
  #reportExited(e: Entry): void {
    if (!this.#o.onExited) return;
    try {
      this.#o.onExited(this.#ended(e));
    } catch (err) {
      console.error(`strand: handling the exit of a terminal failed: ${oneLine(err)}`);
    }
  }

  /** Drop exited terminals older than `keepExitedMs`. No timer: called on every public entry point. */
  #purge(): void {
    const now = this.#o.now();
    for (const [id, e] of this.#entries) {
      if (e.exitedAtMs !== undefined && now - e.exitedAtMs >= this.#o.keepExitedMs) this.#entries.delete(id);
    }
  }

  /** Keep at most MAX_EXITED_KEPT exited entries, dropping the oldest exits first. */
  #trimExited(): void {
    const exited = [...this.#entries.values()].filter((e) => e.exitedAtMs !== undefined);
    if (exited.length <= MAX_EXITED_KEPT) return;
    exited.sort((a, b) => a.exitedAtMs! - b.exitedAtMs!);
    for (const e of exited.slice(0, exited.length - MAX_EXITED_KEPT)) this.#entries.delete(e.info.id);
  }

  #live(id: string): Entry | undefined {
    this.#purge();
    const e = this.#entries.get(id);
    return e && !e.info.exited ? e : undefined;
  }

  #liveEntries(): Entry[] {
    this.#purge();
    return [...this.#entries.values()].filter((e) => !e.info.exited);
  }

  #snapshot(e: Entry): TerminalInfo {
    return e.info.exited ? { ...e.info, exited: { ...e.info.exited } } : { ...e.info };
  }

  start(o: { beadId: string; cwd: string; mode: TerminalMode; sessionId?: string; cols?: number; rows?: number }): TerminalInfo {
    if (typeof o.beadId !== 'string' || !BEAD_ID.test(o.beadId)) throw new Error('invalid bead id');
    if (!MODES.includes(o.mode)) throw new Error('invalid mode');
    const args = [this.#o.cliPath, 'work', o.beadId];
    let sessionId: string;
    if (o.mode === 'resume') {
      if (typeof o.sessionId !== 'string' || !SESSION_ID.test(o.sessionId)) throw new Error('invalid session id');
      sessionId = o.sessionId;
      args.push('--resume', sessionId);
    } else {
      // A new session: its id is made here, never taken from the caller, so the end can name exactly it.
      sessionId = randomUUID();
      args.push('--session-id', sessionId);
      if (o.mode === 'specify') args.push('--specify');
    }
    const live = this.#liveEntries();
    if (live.some((e) => e.info.beadId === o.beadId)) throw new TerminalBusyError();
    if (live.length >= this.#o.maxSessions) throw new TerminalLimitError(this.#o.maxSessions);

    const cols = o.cols !== undefined && validCols(o.cols) ? o.cols : DEFAULT_COLS;
    const rows = o.rows !== undefined && validRows(o.rows) ? o.rows : DEFAULT_ROWS;
    const pty = this.#o.spawn(this.#o.nodePath, args, { cwd: o.cwd, env: childEnv(this.#o.env), cols, rows });
    const entry: Entry = {
      info: { id: randomUUID(), beadId: o.beadId, mode: o.mode, startedAt: new Date(this.#o.now()).toISOString() },
      pty,
      ring: new Ring(this.#o.ringBytes),
      listeners: new Set(),
      killing: false,
      sessionId,
      endReported: false,
    };
    // A new run of this bead replaces its earlier, finished ones.
    for (const [id, e] of this.#entries) {
      if (e.info.beadId === o.beadId && e.info.exited) this.#entries.delete(id);
    }
    this.#entries.set(entry.info.id, entry);

    pty.onData((d) => {
      const chunk = Buffer.from(d, 'utf8');
      entry.ring.push(chunk);
      for (const l of [...entry.listeners]) {
        try {
          l.onData(chunk);
        } catch (err) {
          // A broken listener (a closed socket) must not stop the others or the terminal.
          // Detach it so it is not called again, and say so once.
          entry.listeners.delete(l);
          reportListener(err);
        }
      }
    });
    pty.onExit(({ exitCode }) => {
      if (entry.info.exited) return;
      const now = this.#o.now();
      entry.exitedAtMs = now;
      entry.info.exited = { code: exitCode, at: new Date(now).toISOString() };
      const listeners = [...entry.listeners];
      entry.listeners.clear();
      for (const l of listeners) {
        try {
          l.onExit(exitCode);
        } catch (err) {
          reportListener(err);
        }
      }
      this.#reportEnded(entry);
      this.#reportExited(entry);
      this.#trimExited();
    });
    return this.#snapshot(entry);
  }

  list(): TerminalInfo[] {
    this.#purge();
    return [...this.#entries.values()].map((e) => this.#snapshot(e));
  }

  get(id: string): TerminalInfo | undefined {
    this.#purge();
    const e = this.#entries.get(id);
    return e ? this.#snapshot(e) : undefined;
  }

  liveFor(beadId: string): TerminalInfo | undefined {
    const e = this.#liveEntries().find((x) => x.info.beadId === beadId);
    return e ? this.#snapshot(e) : undefined;
  }

  attach(
    id: string,
    onData: (chunk: Buffer) => void,
    onExit: (code: number) => void,
  ): { scrollback: Buffer; detach(): void } | undefined {
    this.#purge();
    const e = this.#entries.get(id);
    if (!e) return undefined;
    const scrollback = e.ring.snapshot();
    if (e.info.exited) {
      // Already over: tell the caller now and keep nothing, so there is nothing to leak.
      const code = e.info.exited.code;
      try {
        onExit(code);
      } catch (err) {
        reportListener(err);
      }
      return { scrollback, detach() {} };
    }
    const listener: Listener = { onData, onExit };
    e.listeners.add(listener);
    return {
      scrollback,
      detach() {
        e.listeners.delete(listener);
      },
    };
  }

  write(id: string, data: string): boolean {
    if (Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) throw new Error('input too large');
    const e = this.#live(id);
    if (!e) return false;
    return safely(() => e.pty.write(data));
  }

  resize(id: string, cols: number, rows: number): boolean {
    if (!validCols(cols) || !validRows(rows)) return false;
    const e = this.#live(id);
    if (!e) return false;
    return safely(() => e.pty.resize(cols, rows));
  }

  /**
   * Ask the process to stop and return at once. The terminal stays live until its exit event arrives.
   * A second call before the exit asks again (the adapter then ends the process by pid).
   */
  kill(id: string): boolean {
    const e = this.#live(id);
    if (!e) return false;
    e.killing = true;
    return safely(() => e.pty.kill());
  }

  /** Type a line into every live terminal of the bead. Control characters are removed first. */
  typeLine(beadId: string, text: string): number {
    if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw new Error('input too large');
    // A line break or tab becomes one space, so words do not join and no second line is submitted.
    const clean = text.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
    let n = 0;
    for (const e of this.#liveEntries()) {
      if (e.info.beadId === beadId && safely(() => e.pty.write(clean + '\r'))) n++;
    }
    return n;
  }

  /** Stop every live terminal. Each is reported ended first: the server may be gone before its exit event. */
  killAll(): void {
    for (const e of this.#liveEntries()) {
      this.#reportEnded(e);
      if (e.killing) continue;
      e.killing = true;
      safely(() => e.pty.kill());
    }
  }
}

/**
 * Variables that mark the cockpit's own process as running inside a Claude Code session. A cockpit started
 * from one would pass them on, and Claude Code may then refuse to start in the terminal.
 */
const SESSION_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

/** The environment for `strand work`: the cockpit's own, less the session markers. Names compare in any case (Windows). */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!SESSION_MARKERS.includes(k.toUpperCase())) out[k] = v;
  return out;
}

function reportListener(err: unknown): void {
  console.error(`strand: terminal listener failed and was detached: ${oneLine(err)}`);
}

/** Run a call on a process that may have just died. A throw means the call did not happen. */
function safely(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}
