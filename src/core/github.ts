import { run, ToolMissingError } from './exec.ts';
import type { CiState, PullInfo } from './gitea.ts';

/** Runs `gh` with these arguments: the seam tests replace. */
export type GhRunner = (
  args: string[],
  opts: { input?: string; timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

type RawPull = {
  number: number;
  state: 'open' | 'closed';
  merged?: boolean;
  merged_at?: string | null;
  html_url: string;
  head: { ref: string; sha: string };
};

type RawCheckRun = { status: string; conclusion: string | null };

const TIMEOUT_MS = 3000;
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);
const WAITING = new Set(['queued', 'waiting', 'requested', 'pending']);

/** One CI state for a commit: any failure wins, then running, then pending; `neutral` and `skipped` count as success. */
export function combineCheckRuns(runs: RawCheckRun[]): CiState {
  if (runs.length === 0) return 'none';
  if (runs.some((r) => r.conclusion !== null && FAILED.has(r.conclusion))) return 'failure';
  if (runs.some((r) => r.status === 'in_progress')) return 'running';
  if (runs.some((r) => WAITING.has(r.status))) return 'pending';
  return 'success';
}

function toPull(p: RawPull): PullInfo {
  return {
    number: p.number,
    state: p.state,
    merged: p.merged ?? (p.merged_at !== null && p.merged_at !== undefined),
    headSha: p.head.sha,
    headRef: p.head.ref,
    url: p.html_url,
  };
}

const defaultGh: GhRunner = (args, opts) => run('gh', args, opts);

/**
 * A GitHub forge client that drives `gh api`, so `gh` owns sign-in and no token is stored. github.com only.
 * Like the Gitea client, a missing `gh` or a timeout is remembered and later calls fail at once.
 */
export function createGitHub(o: { gh?: GhRunner; timeoutMs?: number } = {}) {
  const gh = o.gh ?? defaultGh;
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  let unreachable: Error | undefined;

  async function api<T>(args: string[], input?: string): Promise<T> {
    if (unreachable) throw unreachable;
    const path = args.find((a) => a.startsWith('repos/'))!;
    let r: { code: number; stdout: string; stderr: string };
    try {
      r = await gh(['api', ...args], input === undefined ? { timeoutMs } : { input, timeoutMs });
    } catch (e) {
      unreachable =
        e instanceof ToolMissingError || (e as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error('GitHub CLI (gh) not found: install it and run gh auth login')
          : new Error(`gh api ${path} failed: ${(e as Error).message}`);
      throw unreachable;
    }
    if (r.code !== 0) {
      const first = r.stderr.trim().split('\n')[0] ?? '';
      if (/gh auth login|HTTP 401|Bad credentials/i.test(r.stderr)) throw new Error('gh is not signed in: run gh auth login');
      throw new Error(`gh api ${path} failed: ${first}`);
    }
    return JSON.parse(r.stdout) as T;
  }

  const repoPath = (owner: string, repo: string) => `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  return {
    name: 'GitHub' as const,

    /** The branch's open PR if any; else its merged PR; else a closed one. */
    async findPullForBranch(owner: string, repo: string, branch: string): Promise<PullInfo | undefined> {
      const head = encodeURIComponent(`${owner}:${branch}`);
      const pulls = await api<RawPull[]>([`${repoPath(owner, repo)}/pulls?state=all&head=${head}&per_page=50`]);
      const pick =
        pulls.find((p) => p.state === 'open') ??
        pulls.find((p) => p.merged === true || (p.merged_at !== null && p.merged_at !== undefined)) ??
        pulls[0];
      return pick && toPull(pick);
    },

    async ciState(owner: string, repo: string, sha: string): Promise<CiState> {
      const res = await api<{ check_runs?: RawCheckRun[] }>([
        `${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
      ]);
      return combineCheckRuns(res.check_runs ?? []);
    },

    /** The body goes in as JSON on stdin, so a title or body starting with `-` or `@` reaches GitHub as typed. */
    async createPull(
      owner: string,
      repo: string,
      p: { head: string; base: string; title: string; body: string },
    ): Promise<PullInfo> {
      const body = JSON.stringify({ head: p.head, base: p.base, title: p.title, body: p.body });
      return toPull(await api<RawPull>(['-X', 'POST', `${repoPath(owner, repo)}/pulls`, '--input', '-'], body));
    },
  };
}
