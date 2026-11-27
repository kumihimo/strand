import { parseArgs } from 'node:util';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { homeDir } from '../../core/config.ts';
import { run } from '../../core/exec.ts';
import { applyMigration, formatPlan, MigrationError, planMigration, readOldBindings } from '../../core/migrate.ts';
import type { ImportedSession, MigrationPlan, MigrationProgress } from '../../core/migrate.ts';
import { findTranscript } from '../../core/archive.ts';
import { readBinding } from '../../core/binding.ts';
import { beadForSession } from '../../core/sessions.ts';
import { loadSnapshot } from '../../core/snapshot.ts';
import { repoOfUrl } from '../../hooks/runtime.ts';
import type { Ctx } from '../ctx.ts';

const byName = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Direct child folders of the workspace that are git repos, in case-insensitive sorted order. */
function workspaceRepos(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(root, e.name, '.git')))
    .map((e) => e.name)
    .sort(byName);
}

async function gitOut(dir: string, args: string[]): Promise<string | undefined> {
  try {
    const r = await run('git', args, { cwd: dir });
    return r.code === 0 ? r.stdout : undefined;
  } catch {
    return undefined;
  }
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return homeDir(env);
}

function countLines(p: MigrationProgress): string[] {
  const line = (name: string, c: { done: number; total: number }) => `${name}: ${c.done} of ${c.total} applied`;
  return [
    line('repo labels', p.addRepo),
    line('in-review removals', p.removeInReview),
    line('plan-approved notes', p.approve),
    line('session bindings', p.bindings),
    line('sessions listed', p.sessions),
  ];
}

/** `strand migrate [--apply] [--json]`: move an existing tracker onto the label workflow. Dry run unless `--apply`. */
export async function main(args: string[], ctx: Ctx): Promise<number> {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean' }, json: { type: 'boolean' } } });
  const root = ctx.config.workspaceRoot;
  const snapshot = await loadSnapshot(ctx.beads);

  // One rule for remotes and branches: the first folder in sorted order wins.
  const remotes = new Map<string, string>();
  const sharing = new Map<string, string[]>();
  const branchHome = new Map<string, string>();
  for (const folder of workspaceRepos(root)) {
    const dir = path.join(root, folder);
    const url = await gitOut(dir, ['remote', 'get-url', 'origin']);
    const repo = url === undefined ? undefined : repoOfUrl(url);
    if (repo) {
      const key = repo.toLowerCase();
      if (!remotes.has(key)) remotes.set(key, folder);
      sharing.set(key, [...(sharing.get(key) ?? []), folder]);
    }
    const heads = await gitOut(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    for (const name of (heads ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      if (!branchHome.has(name)) branchHome.set(name, folder);
    }
  }
  // Only sessions with no new-style binding yet are imported.
  const everyOld = readOldBindings(homeOf(ctx.env));
  const oldBindings = everyOld.filter((b) => {
    const now = readBinding(ctx.config.trackerDir, b.sessionId);
    return now.bead === undefined && !now.none;
  });
  // The cockpit lists a bead's sessions from the index, not from bindings. Every old session bound to a
  // known bead gets an entry, whether its binding is imported in this run or was in an earlier one.
  const sessions: ImportedSession[] = [];
  for (const b of everyOld) {
    const now = readBinding(ctx.config.trackerDir, b.sessionId);
    const beadId = now.none ? undefined : (now.bead ?? (b.bead === 'none' ? undefined : b.bead));
    if (!beadId || !snapshot.ids.has(beadId)) continue;
    if (beadForSession(ctx.config.trackerDir, b.sessionId) !== undefined) continue;
    const transcriptPath = findTranscript(ctx.env, b.sessionId);
    if (!transcriptPath) continue;
    let times: { startedAt: string; endedAt: string };
    try {
      const st = statSync(transcriptPath);
      const born = st.birthtimeMs > 0 && st.birthtimeMs <= st.mtimeMs ? st.birthtime : st.mtime;
      times = { startedAt: born.toISOString(), endedAt: st.mtime.toISOString() };
    } catch {
      continue;
    }
    sessions.push({ sessionId: b.sessionId, beadId, ...times, transcriptPath });
  }
  sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const plan: MigrationPlan = planMigration(snapshot, {
    workspaceRoot: root,
    remotes,
    branchRepo: (name) => branchHome.get(name),
    oldBindings,
  });
  const shared = [...sharing].filter(([, folders]) => folders.length > 1).map(([repo, folders]) => ({ repo, folders }));
  if (shared.length > 0) plan.sharedOrigins = shared;
  if (sessions.length > 0) plan.sessions = sessions;

  // Says which tracker this run reads, so a wrong config shows before anything is read as truth.
  if (!values.json) ctx.out(`Tracker: ${ctx.config.trackerDir} (${snapshot.beads.size} beads)`);
  if (!values.apply) {
    ctx.out(values.json ? JSON.stringify(plan, null, 2) : formatPlan(plan, snapshot, ctx.config.trackerDir));
    return 0;
  }
  try {
    const done = await applyMigration(plan, {
      beads: ctx.beads,
      trackerDir: ctx.config.trackerDir,
      beadCount: snapshot.beads.size,
    });
    if (values.json) {
      ctx.out(JSON.stringify({ plan, export: done.exportFile, applied: done.progress }, null, 2));
    } else {
      for (const l of countLines(done.progress)) ctx.out(l);
      if (plan.unassigned.length > 0) ctx.out(`Still needs a repo: label, assign by hand: ${plan.unassigned.join(', ')}`);
      ctx.out(`Safety export: ${done.exportFile}`);
    }
    return 0;
  } catch (e) {
    if (!(e instanceof MigrationError)) throw e;
    if (values.json) {
      ctx.out(JSON.stringify({ plan, export: e.exportFile, applied: e.progress, error: e.message }, null, 2));
    } else {
      for (const l of countLines(e.progress)) ctx.out(l);
      if (e.stage === 'apply') {
        ctx.out(`Safety export: ${e.exportFile}`);
        ctx.err(`Stopped: ${e.message}. Nothing was lost. Rerun strand migrate --apply to finish.`);
      } else {
        ctx.err(e.message);
      }
    }
    return 1;
  }
}
