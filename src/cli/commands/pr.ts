import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { run } from '../../core/exec.ts';
import { butPush } from '../../core/but.ts';
import { beadIdsIn, branchesOf } from '../../core/facts.ts';
import { pickForge } from '../../core/forge.ts';
import { branchOpen } from '../../core/gitfacts.ts';
import { beadBranch } from '../../core/naming.ts';
import { loadSnapshot } from '../../core/snapshot.ts';
import type { Ctx } from '../ctx.ts';
import { originOf, repoDirFor } from './work.ts';

const USAGE = 'usage: strand pr <bead-id> --title <title> (--body <text> | --body-file <file>) [--base <branch>]';

/** The remote's default branch (origin/HEAD), falling back to `main`. */
async function defaultBase(repoDir: string): Promise<string> {
  const r = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoDir });
  const ref = r.code === 0 ? r.stdout.trim() : '';
  return ref ? ref.replace(/^origin\//, '') : 'main';
}

/** parseArgs refuses a value that starts with `-`, and a PR body may. Join --title and --body to their value. */
function joinValues(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if ((a === '--title' || a === '--body') && i + 1 < args.length) out.push(`${a}=${args[++i]}`);
    else out.push(a);
  }
  return out;
}

export type PrDeps = {
  push(repoDir: string, branch: string): Promise<void>;
  /** Default: gitfacts.branchOpen. */
  branchOpen?(repoDir: string, name: string): Promise<boolean>;
};

/**
 * `strand pr <id> --title <t> --body-file <f>`: push the bead's branch, open the PR and label the bead
 * `pr:<owner>/<repo>#<n>`. The title and body follow the target repo's rules and never name a bead.
 */
export async function main(args: string[], ctx: Ctx, deps: PrDeps = { push: butPush }): Promise<number> {
  const { values, positionals } = parseArgs({
    args: joinValues(args),
    allowPositionals: true,
    options: {
      title: { type: 'string' },
      body: { type: 'string' },
      'body-file': { type: 'string' },
      base: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const id = positionals[0];
  if (!id || positionals.length > 1 || !values.title?.trim()) throw new Error(USAGE);
  if (values.body !== undefined && values['body-file'] !== undefined) throw new Error('pass --body or --body-file, not both');
  if (values.body === undefined && values['body-file'] === undefined) throw new Error(USAGE);
  const title = values.title;
  let body = values.body;
  if (body === undefined) {
    try {
      body = readFileSync(values['body-file']!, 'utf8').replace(/\r\n/g, '\n').trimEnd();
    } catch {
      throw new Error(`cannot read --body-file ${values['body-file']}`);
    }
  }
  const snap = await loadSnapshot(ctx.beads);
  const bead = snap.beads.get(id);
  if (!bead) throw new Error(`bead ${id} not found`);
  for (const [what, text] of [['title', title], ['body', body]] as const) {
    const named = beadIdsIn(text, snap.prefixes, snap.ids);
    if (named.length > 0) throw new Error(`The PR ${what} names bead ${named[0]}. Bead ids stay on this PC.`);
  }
  const names = branchesOf(bead.labels);
  if (names.length === 0) throw new Error(`bead ${id} has no branch: label. Make the branch with but branch new first.`);
  const repoDir = repoDirFor(ctx.config.workspaceRoot, bead);
  // bd returns labels sorted by name, so the last label is not the newest: the open branch wins (RFC 0003 section 3).
  const open = new Set<string>();
  if (names.length > 1) {
    const isOpen = deps.branchOpen ?? branchOpen;
    for (const n of names) if (await isOpen(repoDir, n)) open.add(n);
  }
  const branch = beadBranch(bead, (n) => open.has(n))!;
  const origin = await originOf(repoDir);
  if (!origin) throw new Error(`repo folder ${repoDir} has no usable origin remote`);
  const forge = pickForge(origin.host, { giteaUrl: ctx.config.giteaUrl, gitea: ctx.gitea, github: ctx.github });
  if (!forge) {
    // The configured Gitea's own host with no client means its token is missing.
    if (ctx.config.giteaUrl && origin.host === new URL(ctx.config.giteaUrl).hostname.toLowerCase()) {
      throw new Error('Gitea is not configured (run the installer or set STRAND_GITEA_URL and a token)');
    }
    // With no Gitea configured the host might be one, so say how to set it up too.
    const gitea = ctx.config.giteaUrl ? '' : ', or, if it is your Gitea, run the installer or set STRAND_GITEA_URL and a token';
    throw new Error(`repo folder ${repoDir} is on ${origin.host}, which strand cannot open PRs on yet. Open its PR there by hand${gitea}.`);
  }
  const label = (n: number) => `pr:${origin.owner}/${origin.repo}#${n}`;

  const existing = await forge.findPullForBranch(origin.owner, origin.repo, branch);
  if (existing?.state === 'open') {
    // Idempotent: the PR is already open, so do not push or create again. Add the label if it is missing.
    if (!bead.labels.includes(label(existing.number))) await ctx.beads.addLabel(id, label(existing.number));
    if (values.json) ctx.out(JSON.stringify({ url: existing.url, number: existing.number, branch, existing: true }));
    else ctx.out(existing.url);
    return 0;
  }

  await deps.push(repoDir, branch);
  const base = values.base ?? (await defaultBase(repoDir));
  const pull = await forge.createPull(origin.owner, origin.repo, { head: branch, base, title, body });
  await ctx.beads.addLabel(id, label(pull.number));
  if (values.json) ctx.out(JSON.stringify({ url: pull.url, number: pull.number, branch, base }));
  else ctx.out(pull.url);
  return 0;
}
