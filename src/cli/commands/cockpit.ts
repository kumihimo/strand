import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Ctx } from '../ctx.ts';
import { COCKPIT_WINDOWS, homeDir, type CockpitWindow } from '../../core/config.ts';
import { newToken } from '../../cockpit/auth.ts';
import { instanceFile, probeInstance, readInstance, removeInstance, writeInstance } from '../../cockpit/instance.ts';
import { Model } from '../../cockpit/model.ts';
import { WorkQueue } from '../../cockpit/queue-runner.ts';
import { queueFile } from '../../core/queue-store.ts';
import { loadSnapshot } from '../../core/snapshot.ts';
import { repoDirFor } from './work.ts';
import { loadNodePty, Terminals, type SpawnPty } from '../../cockpit/pty.ts';
import { archiveTranscript, findTranscript } from '../../core/archive.ts';
import { endTerminalSession, type SessionEntry } from '../../core/sessions.ts';
import { createServer, DEFAULT_UI_DIR, REPO_ROOT, uiNotBuiltHint } from '../../cockpit/server.ts';
import { assertCockpitUrl, findDesktopApp, launchDesktop, type DesktopApp, type SpawnDesktop } from '../../cockpit/desktop.ts';

export type Opener = (url: string) => Promise<unknown> | unknown;

/** How the cockpit window is opened; tests inject all three so no app or browser starts. */
export type WindowDeps = {
  /** Opens a normal tab in the default browser. */
  opener?: Opener;
  /** Finds the Strand desktop app; defaults to the packaged app, then the dev Electron. */
  findApp?: () => DesktopApp | undefined;
  /** Starts the desktop app. */
  spawn?: SpawnDesktop;
};

/**
 * The IPC channel to the Strand desktop app that started this process (`--ipc`, ADR 0022). The key travels
 * only here: never on a command line, in a URL or on stdout.
 */
export type IpcChannel = {
  send: (m: unknown) => void;
  onMessage: (fn: (m: unknown) => void) => void;
  onDisconnect: (fn: () => void) => void;
  /** Closes the channel, so a child with nothing else to do exits. */
  close: () => void;
};

/** This process's IPC channel, when a parent started it with one. */
function processIpc(): IpcChannel | undefined {
  if (typeof process.send !== 'function') return undefined;
  return {
    send: (m) => void process.send?.(m),
    onMessage: (fn) => void process.on('message', fn),
    onDisconnect: (fn) => void process.on('disconnect', fn),
    close: () => {
      if (process.connected) process.disconnect?.();
    },
  };
}

/** Only `{kind: 'stop'}` from the app stops the server; anything else is ignored. */
const isStop = (m: unknown) =>
  m !== null && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length === 1 && (m as { kind?: unknown }).kind === 'stop';

export type CockpitOptions = WindowDeps & {
  ctx: Ctx;
  port: number;
  open: boolean;
  /** How to open when `open` is true; defaults to `cockpit.window` from the config. */
  window?: CockpitWindow;
  uiDir?: string;
  /** Loads the pseudo-terminal module; defaults to node-pty. Tests pass a fake. */
  loadPty?: typeof loadNodePty;
  /** Called by POST /api/quit. Without it the quit route closes the server itself. */
  onQuit?: () => void;
};

export type Started = { url: string; port: number; key: string; close: () => Promise<void> };

const USAGE = 'usage: strand cockpit [--port <0-65535>] [--no-open] [--window app|tab|none] [--ipc]';

const defaultOpener: Opener = async (url) => (await import('open')).default(url, { wait: false });

const defaultFindApp = () => findDesktopApp({ appRoot: REPO_ROOT, platform: process.platform, exists: existsSync });

/**
 * Print the cockpit link and open it as configured. `app` launches the Strand desktop app, which gets the key
 * from the key file itself, so the printed link carries no key. With no app found, and in `tab` and `none`
 * modes, the link carries the key (the risk ADR 0016 accepted, kept for these modes by ADR 0022).
 * A failure to open only prints a hint.
 */
async function showCockpit(label: string, port: number, key: string, ctx: Ctx, mode: CockpitWindow, deps: WindowDeps): Promise<void> {
  if (mode === 'app') {
    const app = (deps.findApp ?? defaultFindApp)();
    if (app) {
      ctx.out(`${label}: ${bareLink(port)}`);
      const warn = () => ctx.err('Could not start the Strand app. Run strand cockpit --window tab to open the cockpit in a browser.');
      try {
        launchDesktop(app, { appRoot: REPO_ROOT, env: ctx.env, spawn: deps.spawn, onError: warn });
      } catch {
        warn();
      }
      return;
    }
  }
  const url = linkOf(port, key);
  ctx.out(`${label}: ${url}`);
  if (mode === 'none') return;
  const warn = () => ctx.err('Could not open a browser. Open the URL above yourself.');
  const watched = new WeakSet<object>();
  const watch = (child: unknown) => {
    // A missing opener (no xdg-open) surfaces as an async 'error' on the child, not a rejection.
    if (child && typeof (child as { on?: unknown }).on === 'function' && !watched.has(child)) {
      watched.add(child);
      (child as NodeJS.EventEmitter).on('error', warn);
    }
  };
  try {
    assertCockpitUrl(url);
    const result = (deps.opener ?? defaultOpener)(url);
    watch(result);
    watch(await result);
  } catch {
    warn();
  }
}

/** How long a server stop waits for its terminals to exit and their transcripts to be archived. */
const ARCHIVE_WAIT_MS = 1500;

/**
 * The cockpit's terminal manager. A terminal that ends, or is stopped with the server, gets its session's end
 * recorded in the index at once: a kill ends the SessionEnd hook too, and an unended session cannot be resumed.
 * The end carries the transcript path when Claude Code's file exists. The transcript is archived on a later tick
 * once the process has exited, so Claude is no longer writing it. With the artefacts under git it is left for
 * `strand archive` (the next SessionStart), so a stop does no git work.
 * `settle` waits, at most `ms`, for stopped terminals to exit and for archives in flight. After it no archive
 * starts: a terminal that exits later keeps its path and stays unarchived, for `strand archive`.
 */
export function cockpitTerminals(ctx: Ctx, spawn: SpawnPty, onExit?: () => void): { terminals: Terminals; settle: (ms: number) => Promise<void> } {
  const pending = new Set<Promise<void>>();
  /** Terminals whose sessions are ended but whose process has not exited yet, by session id, with what to archive. */
  const waiting = new Map<string, { entries: SessionEntry[]; exited: () => void; done: Promise<void> }>();
  let closed = false;
  const archive = (e: SessionEntry) => {
    if (closed || !e.transcriptPath || ctx.config.artefactsVcs !== 'none') return;
    const p = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => archiveTranscript(ctx.config.trackerDir, e, { vcs: 'none', comment: (id, text) => ctx.beads.comment(id, text) }))
      .then(
        () => undefined,
        (err: unknown) => console.error(`strand: archive ${e.sessionId} failed: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => pending.delete(p));
    pending.add(p);
  };
  const terminals = new Terminals({
    spawn,
    nodePath: process.execPath,
    cliPath: join(REPO_ROOT, 'src', 'cli', 'strand.ts'),
    maxSessions: ctx.config.cockpit.maxSessions,
    env: ctx.env,
    onEnded: (t) => {
      const entries = endTerminalSession(ctx.config.trackerDir, t, (sid) => findTranscript(ctx.env, sid));
      let exited = () => {};
      const done = new Promise<void>((resolve) => (exited = resolve));
      waiting.set(t.sessionId, { entries, exited, done });
    },
    onExited: (t) => {
      onExit?.();
      const w = waiting.get(t.sessionId);
      if (!w) return;
      waiting.delete(t.sessionId);
      for (const e of w.entries) archive(e);
      w.exited();
    },
  });
  const settle = async (ms: number) => {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref();
    });
    const work = (async () => {
      await Promise.allSettled([...waiting.values()].map((w) => w.done));
      await Promise.allSettled([...pending]);
    })();
    await Promise.race([work, limit]);
    clearTimeout(timer);
    closed = true;
  };
  return { terminals, settle };
}

/**
 * The work queue (ADR 0023): queued Backlog beads start in Specify terminals while fewer than `wip.build` beads
 * are in progress. It runs only while this server runs.
 */
export function cockpitQueue(ctx: Ctx, terminals: Terminals, model: Pick<Model, 'invalidate'>): WorkQueue {
  return new WorkQueue({
    file: queueFile(ctx.env, process.platform, homeDir(ctx.env)),
    limit: () => ctx.config.wip.build,
    beads: async () => (await loadSnapshot(ctx.beads)).beads,
    cwdFor: (b) => repoDirFor(ctx.config.workspaceRoot, b),
    terminals,
    comment: (id, text) => ctx.beads.comment(id, text),
    onChange: () => model.invalidate(),
    warn: ctx.err,
  });
}

/** Start the server on 127.0.0.1 and return the launch URL, its port and key, plus a close function. */
export async function startCockpit(o: CockpitOptions): Promise<Started> {
  const token = newToken();
  const allowedHosts: string[] = [];
  // A missing or broken node-pty leaves the server up; the UI falls back to the copyable command.
  const pty = await (o.loadPty ?? loadNodePty)();
  // A terminal that exits may free a slot: the queue looks at once.
  let wakeQueue = () => {};
  const managed = 'spawn' in pty ? cockpitTerminals(o.ctx, pty.spawn, () => wakeQueue()) : undefined;
  const terminals = managed?.terminals;
  const terminalsUnavailable = 'error' in pty ? `node-pty could not load: ${pty.error}` : undefined;
  const model = new Model(o.ctx);
  const queue = terminals && cockpitQueue(o.ctx, terminals, model);
  if (queue) wakeQueue = () => void queue.tick();
  const close = async () => {
    queue?.stop();
    // killAll records each end and asks each process to stop; it does not wait for the exits.
    terminals?.killAll();
    // Wait a bounded moment for the exits and the archives that follow them. node-pty on Windows can take
    // about 5 s to finish a kill; a session not exited by then keeps its path for `strand archive`.
    await managed?.settle(ARCHIVE_WAIT_MS);
    return app.close();
  };
  const onQuit = o.onQuit ?? (() => void close());
  const app = await createServer({ ctx: o.ctx, token, uiDir: o.uiDir, allowedHosts, model, terminals, terminalsUnavailable, queue, onQuit });
  try {
    await app.listen({ host: '127.0.0.1', port: o.port });
  } catch (e) {
    await app.close();
    // Usually a running cockpit whose probe failed: never suggest a second server on another port.
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw Object.assign(new Error(`port ${o.port} is in use; a cockpit may already be running`), { code: 'EADDRINUSE' });
    }
    throw e;
  }
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : o.port;
  allowedHosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
  // Only a listening server advances the queue: a second cockpit that failed to bind must not start beads.
  queue?.start();
  const url = linkOf(port, token);
  if (!existsSync(join(o.uiDir ?? DEFAULT_UI_DIR, 'index.html'))) o.ctx.err(uiNotBuiltHint());
  if (o.open) await showCockpit('Cockpit', port, token, o.ctx, o.window ?? o.ctx.config.cockpit.window, o);
  return { url, port, key: token, close };
}

function bareLink(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

function linkOf(port: number, key: string): string {
  return `${bareLink(port)}?key=${key}`;
}

export type MainOptions = WindowDeps & {
  signal?: AbortSignal;
  /** Starts the server; tests inject one to prove a second run starts nothing. */
  start?: (o: CockpitOptions) => Promise<Started>;
  /** The channel for `--ipc`; defaults to this process's. `null` means none (tests). */
  ipc?: IpcChannel | null;
};

/** Signals that stop the server cleanly. On Windows a closed console is SIGHUP and Ctrl+Break is SIGBREAK. */
const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? (['SIGBREAK'] as const) : [])];

export async function main(args: string[], ctx: Ctx, opts: MainOptions = {}): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { port: { type: 'string' }, 'no-open': { type: 'boolean' }, window: { type: 'string' }, ipc: { type: 'boolean' } },
  });
  // STRAND_COCKPIT_PORT sets the default, so a demo app can run beside the real cockpit; --port wins.
  const portRaw = values.port ?? ctx.env.STRAND_COCKPIT_PORT;
  const port = portRaw === undefined ? 4747 : /^\d+$/.test(portRaw) ? Number(portRaw) : NaN;
  if (!(port >= 0 && port <= 65535)) throw new Error(USAGE);
  if (values.window !== undefined && !(COCKPIT_WINDOWS as readonly string[]).includes(values.window)) throw new Error(USAGE);
  // Started by the desktop app: the key goes back over IPC, and the app is the window.
  const ipc = values.ipc ? (opts.ipc === undefined ? processIpc() : opts.ipc ?? undefined) : undefined;
  if (values.ipc && !ipc) throw new Error('strand cockpit: --ipc needs an IPC channel (the Strand desktop app starts it so)');
  const mode: CockpitWindow =
    ipc || values['no-open'] || ctx.env.STRAND_COCKPIT_NO_OPEN === '1'
      ? 'none'
      : ((values.window as CockpitWindow | undefined) ?? ctx.config.cockpit.window);

  const platform = process.platform;
  const home = homeDir(ctx.env, platform);
  const file = instanceFile(ctx.env, platform, home);

  // One server per user: a live one found through the key file gets a window, nothing else.
  const attach = async (): Promise<boolean> => {
    const found = readInstance(file);
    if (!found || !(await probeInstance(found))) return false;
    if (ipc) {
      ctx.out(`Cockpit already running: ${bareLink(found.port)}`);
      try {
        ipc.send({ kind: 'attached', port: found.port, key: found.key });
      } finally {
        ipc.close();
      }
      return true;
    }
    await showCockpit('Cockpit already running', found.port, found.key, ctx, mode, opts);
    return true;
  };
  if (await attach()) return 0;

  let wake = () => {};
  let stopping = false;
  const requestStop = () => {
    stopping = true;
    wake();
  };
  let started: Started;
  try {
    started = await (opts.start ?? startCockpit)({ ctx, port, open: false, onQuit: requestStop });
  } catch (e) {
    // A busy port: a slow probe, or two starts racing before the file was written. Look once more.
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE' && (await attach())) return 0;
    throw e;
  }
  const pid = process.pid;
  const removeFile = () => removeInstance(file, pid);
  // An uncaught error still emits 'exit': the file must not outlive the server.
  process.on('exit', removeFile);
  const signal = opts.signal;
  try {
    // A stale or forged file is simply overwritten.
    writeInstance(file, { port: started.port, pid, key: started.key });
    if (ipc) {
      // Listen before telling the app, so a stop sent at once is not missed. A gone app stops the server.
      ipc.onMessage((m) => isStop(m) && requestStop());
      ipc.onDisconnect(requestStop);
      ctx.out(`Cockpit: ${bareLink(started.port)}`);
      ipc.send({ kind: 'started', port: started.port, key: started.key });
    } else {
      await showCockpit('Cockpit', started.port, started.key, ctx, mode, opts);
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
      if (stopping || signal?.aborted) return resolve();
      for (const s of STOP_SIGNALS) process.once(s, requestStop);
      signal?.addEventListener('abort', requestStop);
    });
  } finally {
    for (const s of STOP_SIGNALS) process.off(s, requestStop);
    signal?.removeEventListener('abort', requestStop);
    ipc?.close();
    removeFile();
    process.off('exit', removeFile);
    await started.close();
  }
  return 0;
}
