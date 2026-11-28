import { addToolDirs, loadConfig, type Config } from '../core/config.ts';
import { Beads } from '../core/bd.ts';
import type { Forge } from '../core/forge.ts';
import { createGitea } from '../core/gitea.ts';
import { createGitHub } from '../core/github.ts';
import { getGiteaToken } from '../core/secrets.ts';

export type Gitea = ReturnType<typeof createGitea>;

/** Everything a command needs, built once per invocation so tests can run commands in-process. */
export type Ctx = {
  config: Config;
  beads: Beads;
  gitea?: Gitea;
  /** GitHub through `gh`; it signs in on its own, so it is always there. */
  github?: Forge;
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /** The folder the command runs in (strand new binds a bead to it when it is a workspace repo). */
  cwd: string;
};

export function buildCtx(
  env: NodeJS.ProcessEnv = process.env,
  io: { out?: (line: string) => void; err?: (line: string) => void } = {},
): Ctx {
  const config = loadConfig({ env });
  // The tools first-run setup installed off PATH (ADR 0029): every run('but'), run('gh') and child finds them.
  addToolDirs(env, config);
  const ctx: Ctx = {
    config,
    beads: new Beads(config.trackerDir),
    out: io.out ?? ((s) => process.stdout.write(s + '\n')),
    err: io.err ?? ((s) => process.stderr.write(s + '\n')),
    env,
    cwd: process.cwd(),
    github: createGitHub(),
  };
  if (config.giteaUrl) {
    // Only touch the keychain when Gitea is configured at all.
    const token = env.STRAND_GITEA_TOKEN || getGiteaToken();
    if (token) ctx.gitea = createGitea({ baseUrl: config.giteaUrl, token });
  }
  return ctx;
}
