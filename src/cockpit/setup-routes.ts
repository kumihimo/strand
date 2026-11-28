import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../cli/ctx.ts';
import { addToolDirs, homeDir, loadConfig, toolsDir } from '../core/config.ts';
import { OFFERED_TOOLS, installTool, isOfferedTool, offerFor, type Offer, type OfferedTool } from '../core/offered.ts';
import { SettingsError, applyLiveSettings, writeSettings } from '../core/settings.ts';
import { probeTool, probeTools, type ToolState } from '../core/tools.ts';

/** How the routes probe and install; tests inject fakes. */
export type SetupDeps = {
  probe?: () => Promise<ToolState[]>;
  install?: (tool: OfferedTool, log: (line: string) => void) => Promise<{ path: string; found?: string }>;
  platform?: NodeJS.Platform;
  arch?: string;
};

export type InstallState = {
  tool: OfferedTool;
  state: 'running' | 'done' | 'failed';
  log: string[];
  error?: string;
  path?: string;
};

/** What the screen shows for an offer: everything but the plan, which stays on the server. */
export type OfferView = Omit<Offer, 'plan'> & { available: boolean };

export type SetupView = { tools: ToolState[]; offers: OfferView[]; ready: boolean; install?: InstallState };

const MAX_LOG = 500;
const PATH_KEY: Record<OfferedTool, 'claudePath' | 'butPath' | 'ghPath'> = { claude: 'claudePath', but: 'butPath', gh: 'ghPath' };

/**
 * First-run setup (ADR 0029), behind the server's Host, Origin and key checks. GET /api/setup probes every tool;
 * POST /api/setup/install runs the official plan of one missing offered tool, only with `consent: true` and
 * one at a time. The request names only the tool: nothing else from it reaches a URL, a path or a command line.
 */
export function registerSetupRoutes(app: FastifyInstance, ctx: Ctx, deps: SetupDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const home = homeDir(ctx.env, platform);
  const tools = toolsDir(platform, ctx.env, home);
  const probeOpts = () => ({
    platform,
    env: ctx.env,
    home,
    toolsDir: tools,
    configured: { claude: ctx.config.claudePath, but: ctx.config.butPath, gh: ctx.config.ghPath },
  });
  const probe = deps.probe ?? (() => probeTools(probeOpts()));
  const probeOne = async (tool: OfferedTool) =>
    deps.probe ? (await deps.probe()).find((t) => t.name === tool) : await probeTool(tool, probeOpts());
  const install =
    deps.install ?? ((tool: OfferedTool, log: (l: string) => void) => installTool(tool, { platform, arch, env: ctx.env, home, toolsDir: tools, log }));

  const byTool = new Map<OfferedTool, InstallState>();
  let last: InstallState | undefined;
  const running = () => last?.state === 'running';

  const offers = (): OfferView[] =>
    OFFERED_TOOLS.map((t) => {
      const { plan, ...rest } = offerFor(t, platform, arch, ctx.env);
      return { ...rest, available: plan !== undefined };
    });

  /** Save the found path (unless the env sets it) and put its folder on PATH for this process and its terminals. */
  const record = (st: InstallState, path: string) => {
    try {
      writeSettings({ [PATH_KEY[st.tool]]: path }, { env: ctx.env });
      applyLiveSettings(ctx.config, loadConfig({ env: ctx.env }));
    } catch (e) {
      const why = e instanceof SettingsError ? Object.values(e.fields).join('; ') || e.message : (e as Error).message;
      st.log.push(`Not saved to the config: ${why}`);
      ctx.config[PATH_KEY[st.tool]] = path;
    }
    addToolDirs(ctx.env, ctx.config, platform);
  };

  app.get('/api/setup', async (): Promise<SetupView> => {
    const states = await probe();
    const view: SetupView = { tools: states, offers: offers(), ready: states.every((t) => !t.required || t.status === 'ok') };
    if (last) view.install = last;
    return view;
  });

  app.get('/api/setup/install/:tool', async (req, reply) => {
    const { tool } = req.params as { tool: string };
    const st = isOfferedTool(tool) ? byTool.get(tool) : undefined;
    if (!st) return reply.code(404).send({ error: 'no install for that tool' });
    return st;
  });

  app.post('/api/setup/install', async (req, reply) => {
    const body = req.body as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return reply.code(400).send({ error: 'expected { tool, consent }' });
    const { tool, consent } = body as { tool?: unknown; consent?: unknown };
    // Never echo the tool: it is whatever the caller sent.
    if (!isOfferedTool(tool)) return reply.code(400).send({ error: `unknown tool; setup offers ${OFFERED_TOOLS.join(', ')}` });
    if (consent !== true) return reply.code(400).send({ error: 'an install needs your consent: tick the box beside the licence first' });
    if (running()) return reply.code(409).send({ error: `an install of ${last!.tool} is running; wait for it to finish` });
    const offer = offerFor(tool, platform, arch, ctx.env);
    if (!offer.plan) return reply.code(409).send({ error: `there is no official ${offer.title} installer for this computer` });
    const now = await probeOne(tool);
    if (running()) return reply.code(409).send({ error: `an install of ${last!.tool} is running; wait for it to finish` });
    if (now && now.status !== 'missing') {
      const v = now.found ? ` (${now.found})` : '';
      const extra = now.status === 'old' ? ` It is older than ${now.min}. ${offer.upgrade}` : '';
      return reply.code(409).send({ error: `${offer.title} is already installed${v}; setup does not reinstall it.${extra}` });
    }
    const st: InstallState = { tool, state: 'running', log: [] };
    const log = (line: string) => {
      st.log.push(line);
      if (st.log.length > MAX_LOG) st.log.splice(0, st.log.length - MAX_LOG);
    };
    byTool.set(tool, st);
    last = st;
    void install(tool, log).then(
      (r) => {
        st.path = r.path;
        record(st, r.path);
        st.state = 'done';
      },
      (e: unknown) => {
        st.error = e instanceof Error ? e.message : String(e);
        st.state = 'failed';
      },
    );
    return reply.code(202).send({ install: st });
  });
}
