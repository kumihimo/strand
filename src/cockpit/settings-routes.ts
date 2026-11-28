import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../cli/ctx.ts';
import { loadConfig } from '../core/config.ts';
import { SettingsError, applyLiveSettings, readSettings, writeSettings, type SettingsView } from '../core/settings.ts';

/** A config file the server cannot read or parse: the screen shows the reason, and nothing is written over it. */
const isFileProblem = (e: unknown): e is Error => e instanceof Error && /^(Malformed|Cannot read) config file /.test(e.message);

/**
 * The Settings screen's routes (ADR 0028), behind the server's Host, Origin and key checks. PUT writes through
 * the core writer, then reloads the values that apply at once into the running config.
 */
export function registerSettingsRoutes(app: FastifyInstance, ctx: Ctx): void {
  const opts = { env: ctx.env };
  // Whether a Gitea token is in use, from the client built at start: no keychain read here.
  const view = (v: SettingsView) => ({ ...v, giteaToken: ctx.gitea !== undefined });

  app.get('/api/settings', async (_req, reply) => {
    try {
      return view(readSettings(opts));
    } catch (e) {
      if (isFileProblem(e)) return reply.code(409).send({ error: e.message });
      if (e instanceof Error) return reply.code(409).send({ error: `The config file has a value strand cannot use: ${e.message}` });
      throw e;
    }
  });

  app.put('/api/settings', async (req, reply) => {
    try {
      const saved = writeSettings(req.body as Record<string, unknown>, opts);
      applyLiveSettings(ctx.config, loadConfig(opts));
      return view(saved);
    } catch (e) {
      if (e instanceof SettingsError) return reply.code(400).send({ error: e.message, fields: e.fields });
      if (isFileProblem(e)) return reply.code(409).send({ error: e.message });
      throw e;
    }
  });
}
