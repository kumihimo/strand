import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { Ctx } from '../cli/ctx.ts';
import { createRepoCache, type RepoCache } from '../core/repos.ts';
import type { Model } from './model.ts';
import { registerActionRoutes, registerReadRoutes } from './routes.ts';
import { registerTerminalRoutes } from './terminal-routes.ts';
import { registerQueueRoutes } from './queue-routes.ts';
import { registerSettingsRoutes } from './settings-routes.ts';
import { registerSetupRoutes, type SetupDeps } from './setup-routes.ts';
import type { WorkQueue } from './queue-runner.ts';
import { MAX_INPUT_BYTES, type Terminals } from './pty.ts';
import type { TargetOpener } from './open.ts';
import { COOKIE_NAME, HEADER_NAME, readCookie, sessionCookie, tokenMatches } from './auth.ts';

const UNAUTHORIZED_PAGE = 'Open the cockpit using the link printed by strand cockpit';
/** The strand checkout, without a trailing separator. */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]+$/, '');
/** Where `npm run build:ui` writes the UI. */
export const DEFAULT_UI_DIR = join(REPO_ROOT, 'dist', 'ui');

/** One line for both the not-built page and `strand cockpit`'s stderr (works in PowerShell too). */
export function uiNotBuiltHint(): string {
  return `UI not built yet — run: cd "${REPO_ROOT}" && npm run build:ui`;
}

const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NOT_BUILT_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Cockpit</title>' +
  `<h1>The cockpit UI is not built yet</h1><p><code>${escapeHtml(uiNotBuiltHint())}</code></p><p>Then reload this page.</p>`;

function version(): string {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The public face of Model, so tests can pass a fake. */
export type CockpitModel = Pick<Model, 'board' | 'detail' | 'epics' | 'reviewQueue' | 'brief' | 'invalidate'>;

export type ServerOptions = {
  ctx: Ctx;
  token: string;
  /** Built UI folder; defaults to `<repo>/dist/ui`. */
  uiDir?: string;
  /** Read model behind the API routes; none are registered without it. */
  model?: CockpitModel;
  /** Accepted lowercase `Host` values (`127.0.0.1:<port>`, `localhost:<port>`), read per request so the caller may fill it after listening. Required: `'any'` disables the check (tests only). */
  allowedHosts: string[] | 'any';
  /** Launches files and links for POST /api/open; defaults to the OS default app. */
  opener?: TargetOpener;
  /** Registers API routes before the server starts. */
  routes?: (app: FastifyInstance) => void | Promise<void>;
  /** The terminal manager. Without it the terminal routes answer that terminals are unavailable. */
  terminals?: Terminals;
  /** Why terminals are unavailable (node-pty did not load), shown by GET /api/terminals. */
  terminalsUnavailable?: string;
  /** The work queue (ADR 0023). Without it GET /api/queue says it is unavailable and edits are 503. */
  queue?: WorkQueue;
  /** The workspace repo list; defaults to one read from the config's workspace root. */
  repos?: RepoCache;
  /** Stops the cockpit. Registers POST /api/quit, which calls it once its answer is sent. */
  onQuit?: () => void;
  /** How first-run setup probes and installs; defaults to the real tools (ADR 0029). */
  setup?: SetupDeps;
};

export async function createServer(o: ServerOptions): Promise<FastifyInstance> {
  const uiDir = o.uiDir ?? DEFAULT_UI_DIR;
  const built = existsSync(join(uiDir, 'index.html'));
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } });
  // JSON only: drop Fastify's text/plain parser so other bodies are 415.
  app.removeContentTypeParser('text/plain');
  app.decorate('cockpit', { ctx: o.ctx, model: o.model });

  app.setErrorHandler((err, req, reply) => {
    const message = err instanceof Error ? err.message : String(err);
    const e = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; statusCode?: unknown };
    if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: message });
    // A bd call that timed out in a write route (create, approve) is the same outage as a slow read.
    const unavailable = /^bd did not answer within /.test(message) ? `Beads unavailable: ${message}` : message;
    if (unavailable.startsWith('Beads unavailable:')) {
      o.ctx.err(`cockpit: ${req.method} ${req.url.split('?')[0]} failed: ${unavailable}`);
      return reply.code(503).send({ error: unavailable });
    }
    // Client errors raised by Fastify itself (bad JSON body, missing route) keep their status.
    const fastifyOwn = (typeof e.code === 'string' && e.code.startsWith('FST_ERR_')) || 'validation' in e;
    if (fastifyOwn && typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: message });
    }
    o.ctx.err(`cockpit: ${req.method} ${req.url.split('?')[0]} failed: ${message}`);
    return reply.code(500).send({ error: 'internal error' });
  });

  // Registered before the auth hook and every route. An upgrade request is routed through the
  // onRequest hook below like any request, and only a route handler upgrades it, so a failed Host,
  // Origin or key check answers 403 or 401 before any upgrade. The plugin's own onRequest hook must
  // run first: it marks the request so that the socket of a refused upgrade is destroyed.
  await app.register(fastifyWebsocket, {
    // A frame over the input cap closes with 1009.
    options: { maxPayload: MAX_INPUT_BYTES },
    // On a protocol error (1009, 1002) or a dropped client, ws is already closing with its own code:
    // keep it. Only a handler that threw on an open socket is a server fault.
    errorHandler: (err, socket) => {
      if (socket.readyState !== socket.OPEN) return;
      o.ctx.err(`cockpit: terminal socket failed: ${err instanceof Error ? err.message : String(err)}`);
      socket.close(1011, 'server error');
    },
  });

  app.addHook('onRequest', async (req, reply) => {
    // Cookies ignore ports, so another local service must not be able to drive this one.
    const apiPath = req.url.split('?')[0];
    const isApi = apiPath === '/api' || apiPath.startsWith('/api/');
    // No other page (e.g. another 127.0.0.1 port) may frame the cockpit to click its gate buttons.
    // The artefact route relaxes this to same-origin for the cockpit's own preview iframe.
    reply.header('x-frame-options', 'DENY');
    if (isApi) reply.header('cache-control', 'no-store');
    else reply.header('content-security-policy', "frame-ancestors 'none'");
    const hosts = o.allowedHosts;
    if (hosts !== 'any') {
      if (!hosts.includes(String(req.headers.host).toLowerCase())) return reply.code(403).send({ error: 'forbidden host' });
      const origin = req.headers.origin;
      if (origin !== undefined && !hosts.some((h) => origin.toLowerCase() === `http://${h}`)) {
        return reply.code(403).send({ error: 'forbidden origin' });
      }
      // A browser always sends Origin on a WebSocket handshake, so an upgrade without one is not the cockpit page.
      if (origin === undefined && String(req.headers.upgrade ?? '').toLowerCase() === 'websocket') {
        return reply.code(403).send({ error: 'forbidden origin' });
      }
    }
    const [path, query = ''] = req.url.split('?');
    const cookie = readCookie(req.headers.cookie, COOKIE_NAME);
    const header = req.headers[HEADER_NAME];
    const authed = tokenMatches(cookie, o.token) || tokenMatches(typeof header === 'string' ? header : undefined, o.token);
    if (path === '/api' || path.startsWith('/api/')) {
      if (!authed) return reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    // Bootstrap: a valid ?key= sets the cookie and redirects so the key leaves the address bar.
    const key = new URLSearchParams(query).get('key');
    if (path === '/' && key !== null) {
      if (!tokenMatches(key, o.token)) return reply.code(401).type('text/plain').send(UNAUTHORIZED_PAGE);
      return reply.header('set-cookie', sessionCookie(o.token)).redirect('/', 302);
    }
    if (!authed) return reply.code(401).type('text/plain').send(UNAUTHORIZED_PAGE);
  });

  if (o.model) {
    registerReadRoutes(app, o.model);
    // Read once at startup and kept in memory (POST /api/repos/refresh reads it again).
    // The tracker holds `.beads` and is a git repo, but it is not a repo a bead works in.
    const repos = o.repos ?? createRepoCache(o.ctx.config.workspaceRoot, undefined, [o.ctx.config.trackerDir].filter(Boolean));
    registerActionRoutes(app, o.model, o.ctx, repos, o.opener, o.terminals);
  }
  registerTerminalRoutes(app, o.ctx, o.terminals, o.terminalsUnavailable);
  registerQueueRoutes(app, o.queue);
  registerSettingsRoutes(app, o.ctx);
  registerSetupRoutes(app, o.ctx, o.setup);
  await o.routes?.(app);
  app.get('/api/health', async () => ({ ok: true, version: version() }));
  // A second `strand cockpit` checks that the port in the key file is this process.
  app.get('/api/ping', async () => ({ pid: process.pid }));
  const onQuit = o.onQuit;
  if (onQuit) {
    // Its own scope so the route takes no body: any body is drained unread instead of parsed or refused.
    await app.register(async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser('*', (_req, payload, done) => {
        payload.resume();
        payload.once('end', () => done(null, undefined));
        payload.once('error', (e) => done(e, undefined));
      });
      scope.post('/api/quit', async (_req, reply) => {
        const ending = (o.terminals?.list() ?? []).filter((t) => !t.exited).length;
        // Stop only after the answer is on its way.
        let fired = false;
        const quit = () => {
          if (fired) return;
          fired = true;
          setImmediate(onQuit);
        };
        reply.raw.once('finish', quit);
        reply.raw.once('close', quit);
        return { ending };
      });
    });
  }

  if (built) {
    await app.register(fastifyStatic, { root: uiDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send(NOT_BUILT_PAGE));
  }
  await app.ready();
  return app;
}
