import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { run } from '../../core/exec.ts';
import { clearBinding, writeBinding } from '../../core/binding.ts';
import { defaultSpecFormat, type SpecFormat } from '../../core/spec.ts';
import { contextOf } from '../../core/facts.ts';
import { sameRepoName } from '../../core/folders.ts';
import { CLAUDE_DEFAULT, DEFAULT_CLAUDE_EFFORT, DEFAULT_CLAUDE_MODEL, SESSION_ID, beadBranch, isSafeRepoName, repoOf } from '../../core/naming.ts';
import { parseRemote } from '../../core/gitea.ts';
import { beadForSession, recordEnd, recordResume, recordStart, sessionsFor } from '../../core/sessions.ts';
import { loadSnapshot, localStage, wipOf } from '../../core/snapshot.ts';
import { checkBuild } from '../../core/wip.ts';
import type { Ctx } from '../ctx.ts';
import { launchInteractive } from '../launch.ts';

export { isWorkItem } from '../../core/snapshot.ts';

const FORMATS: SpecFormat[] = ['checklist', 'gwt', 'ears', 'repro', 'document', 'brief'];

type HasRepo = { id: string; labels: string[] };

/** `<workspace>/<repo>` for the bead's repo label, or undefined when there is no label or it could escape the workspace. */
export function repoPath(workspaceRoot: string, bead: HasRepo): string | undefined {
  const repo = repoOf(bead);
  if (!repo || !isSafeRepoName(repo)) return undefined;
  return join(workspaceRoot, repo);
}

/** The bead's repo folder; throws the user-facing errors when the label or folder is missing. */
export function repoDirFor(workspaceRoot: string, bead: HasRepo): string {
  const repo = repoOf(bead);
  if (!repo) throw new Error(`bead ${bead.id} has no repo: label`);
  const dir = repoPath(workspaceRoot, bead);
  if (!dir) throw new Error(`bead ${bead.id} has an invalid repo label: repo:${repo}`);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`repo folder ${dir} not found`);
  return dir;
}

/**
 * The bead's context folders that exist, as `<workspace>/<folder>`. A missing one is skipped, with one warning
 * line for all of them. An unsafe name or the primary repo itself is left out.
 */
function contextDirs(ctx: Pick<Ctx, 'config' | 'err'>, bead: HasRepo): string[] {
  const out: string[] = [];
  const missing: string[] = [];
  const seen: string[] = [];
  for (const name of contextOf(bead.labels)) {
    const primary = repoOf(bead);
    if (!isSafeRepoName(name) || (primary !== undefined && sameRepoName(name, primary))) continue;
    if (seen.some((s) => sameRepoName(s, name))) continue;
    seen.push(name);
    const dir = join(ctx.config.workspaceRoot, name);
    if (existsSync(dir) && statSync(dir).isDirectory()) out.push(dir);
    else missing.push(name);
  }
  if (missing.length) ctx.err(`warning: context folders not found, skipped: ${missing.join(', ')}`);
  return out;
}

/**
 * The plugin folder from `STRAND_PLUGIN_DIR`, for a PC where the plugin is not installed (the demo). Read only
 * from the environment. A folder without `.claude-plugin` gets one warning line and no flag.
 */
function pluginDir(ctx: Pick<Ctx, 'env' | 'err'>): string | undefined {
  const raw = ctx.env.STRAND_PLUGIN_DIR;
  if (!raw) return undefined;
  // A relative path would resolve against the bead's repo folder (a cockpit terminal's cwd): never load from there.
  if (!isAbsolute(raw)) {
    ctx.err(`warning: STRAND_PLUGIN_DIR ${raw} is not an absolute path; the plugin is not loaded`);
    return undefined;
  }
  const dir = resolve(raw);
  if (existsSync(join(dir, '.claude-plugin'))) return dir;
  ctx.err(`warning: STRAND_PLUGIN_DIR ${raw} has no .claude-plugin folder; the plugin is not loaded`);
  return undefined;
}

/** owner/repo of the folder's `origin` remote, or undefined when there is none or it cannot be parsed. */
export async function originOf(repoDir: string): Promise<{ owner: string; repo: string; host: string } | undefined> {
  try {
    const r = await run('git', ['remote', 'get-url', 'origin'], { cwd: repoDir });
    if (r.code !== 0) return undefined;
    const { baseUrl, owner, repo } = parseRemote(r.stdout.trim());
    return { owner, repo, host: new URL(baseUrl).hostname.toLowerCase() };
  } catch {
    return undefined;
  }
}

/** `strand work <id>`: claim the bead, start a Claude session for it in its repo folder, bound to it. */
export async function main(args: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      format: { type: 'string' },
      json: { type: 'boolean' },
      specify: { type: 'boolean' },
      resume: { type: 'string' },
      'session-id': { type: 'string' },
    },
  });
  const id = positionals[0];
  if (!id || positionals.length > 1) {
    throw new Error('usage: strand work <bead-id> [--specify] [--resume <session-id> | --session-id <session-id>] [--format <spec-format>]');
  }
  if (values.specify && values.resume !== undefined) throw new Error('use --specify or --resume, not both');
  // The id for a new session, given by the cockpit so it can end exactly this session later.
  const given = values['session-id'];
  if (given !== undefined && values.resume !== undefined) throw new Error('use --session-id or --resume, not both');
  if (given !== undefined && !SESSION_ID.test(given)) throw new Error(`invalid session id ${given}`);
  if (values.format !== undefined && !FORMATS.includes(values.format as SpecFormat)) {
    throw new Error(`unknown spec format ${values.format} (one of ${FORMATS.join(', ')})`);
  }

  const snap = await loadSnapshot(ctx.beads);
  const bead = snap.beads.get(id);
  if (!bead) throw new Error(`bead ${id} not found`);
  if (bead.status === 'closed') throw new Error(`bead ${id} is closed`);
  const repoDir = repoDirFor(ctx.config.workspaceRoot, bead);
  const stage = localStage(bead);
  if (stage === 'build') {
    const verdict = checkBuild(wipOf(snap, id), ctx.config.wip, ctx.config.wip.mode);
    if (!verdict.ok) throw new Error(verdict.reason);
    if (verdict.reason) ctx.out(`warning: ${verdict.reason}`);
  }

  const tracker = ctx.config.trackerDir;
  const resume = values.resume;
  if (resume !== undefined) {
    const known = SESSION_ID.test(resume) && sessionsFor(tracker, id).some((s) => s.sessionId === resume);
    if (!known) throw new Error(`session ${resume} is not a session of bead ${id}`);
  }
  if (given !== undefined && beadForSession(tracker, given) !== undefined) throw new Error(`session ${given} already exists`);

  if (bead.status === 'open') await ctx.beads.claim(id);
  const sessionId = resume ?? given ?? randomUUID();
  if (resume === undefined) recordStart(tracker, { sessionId, beadId: id, branch: beadBranch(bead) });
  else recordResume(tracker, sessionId);
  // lastStage is the stage after the claim, so the first prompt after an approval says the stage changed.
  const claimed = bead.status === 'open' ? { ...bead, status: 'in_progress' } : bead;
  writeBinding(tracker, sessionId, { bead: id, lastStage: localStage(claimed) });
  await ctx.beads.comment(id, `session ${sessionId} ${resume === undefined ? 'started' : 'resumed'}`);

  const format = (values.format as SpecFormat | undefined) ?? defaultSpecFormat(bead.issue_type);
  const claude = ctx.config.claudePath ?? 'claude';
  const name = `${id} ${bead.title}`;
  const claudeArgs = [resume === undefined ? '--session-id' : '--resume', sessionId];
  // Model and effort come from the config and the environment only, never from a request or a bead (ADR 0017).
  // `default` means no flag.
  const model = ctx.config.claudeModel ?? DEFAULT_CLAUDE_MODEL;
  const effort = ctx.config.claudeEffort ?? DEFAULT_CLAUDE_EFFORT;
  if (model !== CLAUDE_DEFAULT) claudeArgs.push('--model', model);
  if (effort !== CLAUDE_DEFAULT) claudeArgs.push('--effort', effort);
  // `--add-dir` takes several values, so it never sits just before the prompt: `--name` (one value) is always
  // the last option.
  for (const dir of contextDirs(ctx, bead)) claudeArgs.push('--add-dir', dir);
  const plugin = pluginDir(ctx);
  if (plugin) claudeArgs.push('--plugin-dir', plugin);
  claudeArgs.push('--name', name);
  // Specify starts with the skill and no plan mode: the session saves the spec to the bead and stops for approval.
  if (values.specify) claudeArgs.push(`/strand:work ${id}`);
  const env = { STRAND_BEAD_ID: id, STRAND_SPEC_FORMAT: format };

  if (ctx.env.STRAND_DRY_RUN_CLAUDE === '1') {
    if (values.json) {
      ctx.out(JSON.stringify({ command: claude, args: claudeArgs, cwd: repoDir, sessionId, stage, env }));
    } else {
      ctx.out(`${claude} ${claudeArgs.map((a) => (a === name ? `"${a}"` : a)).join(' ')}`);
      ctx.out(`cwd: ${repoDir}`);
    }
    return 0;
  }
  try {
    return await launchInteractive(claude, claudeArgs, repoDir, { ...ctx.env, ...env });
  } catch (e) {
    // The session is not running: close its index entry so brief does not show it live forever.
    // A new session also loses its binding; a resumed one keeps it, it ran before.
    recordEnd(tracker, { sessionId });
    if (resume === undefined) clearBinding(tracker, sessionId);
    await ctx.beads.comment(id, `session ${sessionId} failed to ${resume === undefined ? 'start' : 'resume'}`).catch(() => {});
    throw e;
  }
}
