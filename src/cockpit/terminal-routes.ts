import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Ctx } from '../cli/ctx.ts';
import { repoDirFor } from '../cli/commands/work.ts';
import { BEAD_ID } from '../core/create-bead.ts';
import { loadSnapshot, localStage } from '../core/snapshot.ts';
import { isHeld } from '../core/stage.ts';
import { BdError } from '../core/bd.ts';
import { SESSION_ID, TERMINAL_MODES, validCols, validRows } from '../core/naming.ts';
import { MAX_INPUT_BYTES, TerminalBusyError, TerminalLimitError, oneLine, type TerminalMode, type Terminals } from './pty.ts';

/** A socket that holds more unsent output than this is closed; the client reattaches and gets the scrollback. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
/** Open sockets per terminal. Each one holds a listener and a send buffer of up to MAX_BUFFERED_BYTES. */
export const MAX_VIEWERS = 8;
const MODES: readonly string[] = TERMINAL_MODES;

const CLOSE_NORMAL = 1000;
const CLOSE_UNSUPPORTED = 1003;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;
const CLOSE_SERVER_ERROR = 1011;
const CLOSE_TRY_AGAIN = 1013;

type Body = { mode: TerminalMode; sessionId?: string };

/** The session request, or the reason it is refused. Only `mode` and, for resume, `sessionId` are accepted. */
function parseBody(b: unknown): Body | string {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return 'body must be { mode, sessionId? }';
  const o = b as Record<string, unknown>;
  // Never echo the key back: it is whatever the caller sent.
  for (const k of Object.keys(o)) if (k !== 'mode' && k !== 'sessionId') return 'unknown field in body';
  if (typeof o.mode !== 'string' || !MODES.includes(o.mode)) return 'mode must be work, specify or resume';
  const mode = o.mode as TerminalMode;
  if (mode !== 'resume') {
    if (o.sessionId !== undefined) return 'sessionId is only for resume';
    return { mode };
  }
  if (typeof o.sessionId !== 'string' || !SESSION_ID.test(o.sessionId)) return 'resume needs a session id';
  return { mode, sessionId: o.sessionId };
}

/** A client frame, or undefined when it is not one of the two accepted shapes. */
function parseFrame(text: string): { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number } | undefined {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return undefined;
  const o = m as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (o.type === 'input' && keys === 'data,type' && typeof o.data === 'string') return { type: 'input', data: o.data };
  if (o.type === 'resize' && keys === 'cols,rows,type' && validCols(o.cols) && validRows(o.rows)) {
    return { type: 'resize', cols: o.cols, rows: o.rows };
  }
  return undefined;
}

// The manager's ranges, checked here too so a bad resize closes the socket instead of being ignored.

/**
 * Terminal routes. Every input that reaches `Terminals.start` is checked here first: the bead id
 * against `BEAD_ID` and the tracker, the mode against a fixed list, the session id against
 * `SESSION_ID`. The folder comes from the bead's `repo:` label, never from the request.
 */
export function registerTerminalRoutes(app: FastifyInstance, ctx: Ctx, terminals: Terminals | undefined, unavailable?: string): void {
  const reason = unavailable ?? 'terminals are not available';
  /** Open sockets per terminal id. An entry is removed when its count reaches 0. */
  const viewers = new Map<string, number>();

  app.get('/api/terminals', async () =>
    terminals ? { available: true, terminals: terminals.list() } : { available: false, reason, terminals: [] },
  );

  app.post('/api/beads/:id/session', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!BEAD_ID.test(id)) return reply.code(404).send({ error: 'bead not found' });
    const body = parseBody(req.body);
    if (typeof body === 'string') return reply.code(400).send({ error: body });
    if (!terminals) return reply.code(503).send({ error: reason });
    let bead;
    try {
      bead = (await loadSnapshot(ctx.beads)).beads.get(id);
    } catch (e) {
      // Any bd trouble is an outage, as in the other routes. A timeout reaches the error handler's 503 too.
      if (e instanceof BdError) return reply.code(503).send({ error: `Beads unavailable: ${e.firstStderrLine}` });
      throw e;
    }
    if (!bead) return reply.code(404).send({ error: `bead ${id} not found` });
    // The board can be 15 s old: only a bead that is in Backlog now may start specifying. Other modes are not gated.
    if (body.mode === 'specify') {
      if (localStage(bead) !== 'backlog') return reply.code(409).send({ error: `bead ${id} is not in Backlog` });
      if (isHeld(bead.status)) return reply.code(409).send({ error: `bead ${id} is on hold` });
    }
    let cwd: string;
    try {
      cwd = repoDirFor(ctx.config.workspaceRoot, bead);
    } catch (e) {
      return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) });
    }
    try {
      const terminal = terminals.start({ beadId: id, cwd, mode: body.mode, sessionId: body.sessionId });
      return reply.code(201).send({ terminal });
    } catch (e) {
      if (e instanceof TerminalLimitError || e instanceof TerminalBusyError) return reply.code(409).send({ error: e.message });
      // The pty could not spawn: the pane shows why, as it does when node-pty does not load.
      ctx.err(`cockpit: terminal for ${id} did not start: ${oneLine(e)}`);
      return reply.code(503).send({ error: `could not start the terminal: ${oneLine(e)}` });
    }
  });

  app.delete('/api/terminals/:tid', async (req, reply) => {
    const tid = (req.params as { tid: string }).tid;
    if (!terminals?.get(tid)) return reply.code(404).send({ error: 'terminal not found' });
    terminals.kill(tid);
    return { stopping: true };
  });

  app.get('/api/terminals/:tid/io', { websocket: true }, (socket: WebSocket, req) => {
    const tid = (req.params as { tid: string }).tid;
    if (!terminals) return void socket.close(CLOSE_POLICY, 'terminals are not available');
    if ((viewers.get(tid) ?? 0) >= MAX_VIEWERS) return void socket.close(CLOSE_TRY_AGAIN, 'too many viewers');
    viewers.set(tid, (viewers.get(tid) ?? 0) + 1);
    let done = false;
    let detach = () => {};
    // Stop listening for good: on close, on error, and before any close we start. Runs once.
    const finish = () => {
      if (done) return;
      done = true;
      detach();
      const n = (viewers.get(tid) ?? 1) - 1;
      if (n > 0) viewers.set(tid, n);
      else viewers.delete(tid);
    };
    const end = (code: number, why?: string) => {
      finish();
      socket.close(code, why);
    };
    socket.on('close', finish);
    socket.on('error', finish);

    socket.on('message', (raw, isBinary) => {
      if (done) return;
      // A throw from a ws listener is an uncaught exception that would end the cockpit. Close this socket instead.
      try {
        if (isBinary) return end(CLOSE_UNSUPPORTED, 'text frames only');
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.concat(raw as Buffer[]).toString('utf8');
        const frame = parseFrame(text);
        if (!frame) return end(CLOSE_UNSUPPORTED, 'unknown frame');
        if (frame.type === 'resize') return void terminals.resize(tid, frame.cols, frame.rows);
        // Keep this check above the write: `write` throws on oversize input, and the close code must be 1009.
        if (Buffer.byteLength(frame.data, 'utf8') > MAX_INPUT_BYTES) return end(CLOSE_TOO_BIG, 'input too large');
        terminals.write(tid, frame.data);
      } catch (e) {
        ctx.err(`cockpit: terminal input failed: ${e instanceof Error ? e.message : String(e)}`);
        end(CLOSE_SERVER_ERROR, 'server error');
      }
    });

    // `attach` calls onExit at once for a terminal that has already ended; hold it until the scrollback is sent.
    let attached = false;
    let exitCode: number | undefined;
    const sendExit = (code: number) => {
      if (done) return;
      socket.send(JSON.stringify({ type: 'exit', code }));
      end(CLOSE_NORMAL);
    };
    const a = terminals.attach(
      tid,
      (chunk) => {
        if (done) return;
        // The manager calls this synchronously and ws buffers without limit: a slow reader is dropped.
        if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return end(CLOSE_TRY_AGAIN, 'output is too fast; reconnect');
        socket.send(chunk, { binary: true });
      },
      (code) => {
        if (attached) sendExit(code);
        else exitCode = code;
      },
    );
    if (!a) return end(CLOSE_POLICY, 'unknown terminal');
    attached = true;
    if (done) return a.detach();
    detach = a.detach;
    socket.send(a.scrollback, { binary: true });
    if (exitCode !== undefined) sendExit(exitCode);
  });
}
