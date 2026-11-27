import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../cli/ctx.ts';
import { SpecProblemsError, approveSpec, requestChanges } from '../core/approve.ts';
import { BdError } from '../core/bd.ts';
import { BEAD_ID, createBead } from '../core/create-bead.ts';
import { releaseClaim } from '../core/release.ts';
import { StaleEditError, beadVersion, editBead, editProblem, type BeadEdit } from '../core/edit-bead.ts';
import type { RepoCache } from '../core/repos.ts';
import { checkUrl, contentTypeFor, resolveArtefact } from './actions.ts';
import { openTarget, type TargetOpener } from './open.ts';
import type { Terminals } from './pty.ts';
import type { CockpitModel } from './server.ts';

/** Register the read-only JSON API over the model. */
export function registerReadRoutes(app: FastifyInstance, model: CockpitModel): void {
  app.get('/api/board', async () => model.board());
  app.get('/api/beads/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    // Never forward or echo odd input (`--help`, long strings) to bd.
    if (!BEAD_ID.test(id)) return reply.code(404).send({ error: 'bead not found' });
    return model.detail(id);
  });
  app.get('/api/epics', async () => model.epics());
  app.get('/api/review', async () => model.reviewQueue());
  app.get('/api/brief', async () => model.brief());
}

/** The messages createBead and editBead throw for bad input, the capture and spec rules, and repo names. */
function isFilingMessage(m: string): boolean {
  return (
    /^(title|--type|--priority|invalid |needs |criterion |unknown repo |a bead with context folders )/.test(m) ||
    /^\d+ acceptance lines? (is|are) not in the form/.test(m) ||
    m.includes('is required') ||
    m.startsWith('description must open')
  );
}

const STALE = 'This bead changed since you opened it.';

const asObject = (b: unknown): Record<string, unknown> => (typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : {});

/** Write and launch endpoints: approve, create, open, artefact bytes. */
export function registerActionRoutes(
  app: FastifyInstance,
  model: CockpitModel,
  ctx: Ctx,
  repos: RepoCache,
  opener?: TargetOpener,
  terminals?: Pick<Terminals, 'typeLine' | 'liveFor'>,
): void {
  // The repo list, read at startup and held in memory; refresh reads the workspace again.
  app.get('/api/repos', async () => repos.list());
  app.post('/api/repos/refresh', async () => repos.refresh());

  /** Type a line into the bead's live terminals. The gate is already written, so a failure here is logged and counts as 0. */
  const typeInto = (id: string, line: string): number => {
    if (!terminals) return 0;
    try {
      return terminals.typeLine(id, line);
    } catch (e) {
      ctx.err(`cockpit: could not type into the terminal: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    }
  };

  app.post('/api/beads/:id/approve', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!BEAD_ID.test(id)) return reply.code(404).send({ error: 'bead not found' });
    // The version the engineer looked at. Optional, so other callers are unchanged; when sent, a bead that
    // moved since (Claude rewrote the criteria beside the button) is not approved.
    const { version } = asObject(req.body);
    if (version !== undefined && (typeof version !== 'string' || !version)) return reply.code(400).send({ error: 'version must be text' });
    try {
      if (version !== undefined && beadVersion(await ctx.beads.show(id)) !== version) {
        return reply.code(409).send({ error: STALE, current: await model.detail(id) });
      }
      const r = await approveSpec(ctx, id, { by: 'cockpit' });
      const typed = typeInto(id, 'Spec approved. Start Build.');
      return r.warn ? { approved: true, warn: r.warn, typed } : { approved: true, typed };
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (m === `bead ${id} not found` || (e instanceof BdError && /no issue found matching/.test(e.message + e.stderr))) {
        return reply.code(404).send({ error: `bead ${id} not found` });
      }
      if (e instanceof SpecProblemsError || m === `bead ${id} is closed` || m === `bead ${id} is already approved` || /WIP limit/.test(m)) {
        return reply.code(409).send({ error: m });
      }
      throw e;
    } finally {
      model.invalidate();
    }
  });

  app.post('/api/beads/:id/release', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!BEAD_ID.test(id)) return reply.code(404).send({ error: 'bead not found' });
    try {
      // Ask the terminal manager: the client's idea of "no session" is not trusted.
      const { failed } = await releaseClaim(ctx, id, { hasLiveTerminal: terminals?.liveFor(id) !== undefined });
      return failed > 0 ? { released: true, warning: `Released. ${failed} session binding(s) could not be cleared.` } : { released: true };
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (m === `bead ${id} not found`) return reply.code(404).send({ error: m });
      if (m === `bead ${id} is not in Specify` || m === `bead ${id} has a live session`) return reply.code(409).send({ error: m });
      throw e;
    } finally {
      model.invalidate();
    }
  });

  app.put('/api/beads/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!BEAD_ID.test(id)) return reply.code(404).send({ error: 'bead not found' });
    const b = asObject(req.body);
    const edit: BeadEdit = {};
    for (const k of ['title', 'description', 'acceptance', 'design', 'type', 'priority', 'parent', 'repo', 'context'] as const) {
      if (b[k] !== undefined) (edit as Record<string, unknown>)[k] = b[k];
    }
    try {
      if (typeof b.version !== 'string' || !b.version) return reply.code(400).send({ error: 'version is required' });
      const bad = editProblem(edit);
      if (bad) return reply.code(400).send({ error: bad });
      const { changed, rebaselined, warning } = await editBead(ctx, id, edit, { version: b.version, known: repos.list().repos });
      return warning ? { changed, rebaselined, warning } : { changed, rebaselined };
    } catch (e) {
      if (e instanceof StaleEditError) {
        model.invalidate();
        return reply.code(409).send({ error: STALE, current: await model.detail(id) });
      }
      const m = e instanceof Error ? e.message : String(e);
      if (m === `bead ${id} is closed` || m.startsWith(`bead ${id} has a branch in `)) return reply.code(409).send({ error: m });
      if (e instanceof BdError) {
        if (/no issue found matching/.test(e.message + e.stderr)) return reply.code(404).send({ error: `bead ${id} not found` });
        // bd refused the engineer's input (an unknown parent): its own reason. Any other bd trouble is not their doing.
        if (/parent issue .* not found/.test(e.stderr)) return reply.code(400).send({ error: e.firstStderrLine });
        return reply.code(503).send({ error: `Beads unavailable: ${e.firstStderrLine}` });
      }
      if (isFilingMessage(m)) return reply.code(400).send({ error: m });
      throw e;
    } finally {
      model.invalidate();
    }
  });

  app.post('/api/beads/:id/request-changes', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!BEAD_ID.test(id)) return reply.code(404).send({ error: 'bead not found' });
    const { note } = asObject(req.body);
    if (typeof note !== 'string' || note.length < 1 || note.length > 2000) {
      return reply.code(400).send({ error: 'note must be 1 to 2000 characters' });
    }
    try {
      await requestChanges(ctx, id, note);
      return { ok: true, typed: typeInto(id, `Changes requested: ${note}`) };
    } catch (e) {
      if (e instanceof BdError && /no issue found matching/.test(e.message + e.stderr)) return reply.code(404).send({ error: `bead ${id} not found` });
      throw e;
    } finally {
      model.invalidate();
    }
  });

  app.post('/api/beads', async (req, reply) => {
    const b = asObject(req.body);
    let bead;
    try {
      bead = await createBead(
        ctx,
        {
          title: b.title,
          type: b.type,
          priority: b.priority,
          repo: b.repo,
          context: b.context,
          parent: b.parent,
          description: b.description,
          acceptance: b.acceptance,
        },
        repos.list().repos,
      );
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (isFilingMessage(m)) return reply.code(400).send({ error: m });
      // bd refused (unknown parent, bad input): its own reason, not a 500.
      if (e instanceof BdError) return reply.code(400).send({ error: e.firstStderrLine });
      throw e;
    } finally {
      model.invalidate();
    }
    const { id, title, issue_type, priority, labels } = bead;
    return reply.code(201).send({ id, title, type: issue_type, priority, labels });
  });

  app.post('/api/open', async (req, reply) => {
    const b = asObject(req.body);
    const hasPath = b.path !== undefined;
    const hasUrl = b.url !== undefined;
    if (hasPath === hasUrl) return reply.code(400).send({ error: 'pass exactly one of path or url' });
    let target: string;
    try {
      if (hasUrl) {
        if (typeof b.url !== 'string') return reply.code(400).send({ error: 'url must be text' });
        target = checkUrl(b.url).href;
      } else {
        if (typeof b.path !== 'string' || typeof b.beadId !== 'string') return reply.code(400).send({ error: 'path needs a beadId' });
        target = resolveArtefact(ctx.config.trackerDir, b.beadId, b.path, { forOpen: true });
      }
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : 'refused' });
    }
    if (ctx.env.STRAND_COCKPIT_DRY_OPEN === '1') return { ok: true, target, dryRun: true };
    try {
      await openTarget(target, opener);
    } catch {
      return reply.code(500).send({ error: 'could not open' });
    }
    return { ok: true };
  });

  app.get('/api/beads/:id/artefact', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rel = (req.query as { rel?: unknown }).rel;
    let file: string;
    try {
      file = resolveArtefact(ctx.config.trackerDir, id, typeof rel === 'string' ? rel : '');
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : 'refused' });
    }
    const type = contentTypeFor(file);
    reply.header('content-type', type).header('content-disposition', 'inline').header('x-content-type-options', 'nosniff');
    // A mockup (or SVG) must not run scripts with the cockpit's origin; only the cockpit itself may frame it.
    const sandbox = type === 'text/html' || type === 'image/svg+xml' ? 'sandbox; ' : '';
    reply.header('content-security-policy', `${sandbox}frame-ancestors 'self'`).header('x-frame-options', 'SAMEORIGIN');
    return reply.send(createReadStream(file));
  });
}
