export type CiState = 'none' | 'pending' | 'running' | 'success' | 'failure';

export type PullInfo = {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  headRef: string;
  url: string;
};

type RawPull = {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  html_url: string;
  head: { ref: string; sha: string };
};

type RawRun = {
  id: number;
  status: string;
  conclusion?: string | null;
  workflow_id?: number | string;
  path?: string;
  name?: string;
  display_title?: string;
};

const PAGE_SIZE = 50;
const TIMEOUT_MS = 3000;

/** Which workflow a run belongs to: workflow_id, else the workflow file (path without @ref), else its name. */
function workflowKey(r: RawRun): string {
  if (r.workflow_id !== undefined && r.workflow_id !== null) return `id:${r.workflow_id}`;
  if (r.path) return `path:${r.path.replace(/@.*$/, '')}`;
  return `name:${r.name ?? ''}`;
}

/** Latest run per workflow; any failure wins, then running, then pending; success only when all succeeded. */
export function combineRuns(runs: RawRun[]): CiState {
  if (runs.length === 0) return 'none';
  const latest = new Map<string, RawRun>();
  for (const r of runs) {
    const k = workflowKey(r);
    const cur = latest.get(k);
    if (!cur || r.id > cur.id) latest.set(k, r);
  }
  const states = [...latest.values()].map(mapRun);
  for (const s of ['failure', 'running', 'pending'] as const) if (states.includes(s)) return s;
  return 'success';
}

function toPull(p: RawPull): PullInfo {
  return {
    number: p.number,
    state: p.state,
    merged: Boolean(p.merged),
    headSha: p.head.sha,
    headRef: p.head.ref,
    url: p.html_url,
  };
}

function mapRun(run: RawRun): CiState {
  switch (run.status) {
    case 'completed':
      return run.conclusion === 'success' ? 'success' : 'failure';
    case 'in_progress':
    case 'running':
      return 'running';
    default:
      return 'pending';
  }
}

export function createGitea(o: { baseUrl: string; token: string; fetch?: typeof fetch; timeoutMs?: number }) {
  const base = o.baseUrl.replace(/\/+$/, '');
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;

  // Set on a timeout or network error: later calls fail at once, so one bad host costs one timeout per run.
  let unreachable: Error | undefined;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (unreachable) throw unreachable;
    const headers: Record<string, string> = { Authorization: `token ${o.token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await doFetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      unreachable = new Error(`Gitea ${method} ${path} ${timedOut ? `timed out after ${timeoutMs} ms` : `failed: ${(e as Error).message}`}`);
      throw unreachable;
    }
    if (!res.ok) throw new Error(`Gitea ${method} ${path} failed: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  const repoPath = (owner: string, repo: string) =>
    `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  return {
    name: 'Gitea' as const,

    /** The branch's open PR if any; else its merged PR; else a closed one. Open PRs are checked first (cheap). */
    async findPullForBranch(owner: string, repo: string, branch: string): Promise<PullInfo | undefined> {
      const pages = async function* (state: 'open' | 'all') {
        for (let page = 1; ; page++) {
          const pulls = await call<RawPull[]>(
            'GET',
            `${repoPath(owner, repo)}/pulls?state=${state}&limit=${PAGE_SIZE}&page=${page}`,
          );
          yield pulls.filter((p) => p.head.ref === branch);
          if (pulls.length < PAGE_SIZE) return;
        }
      };
      for await (const hits of pages('open')) {
        const open = hits.find((p) => p.state === 'open');
        if (open) return toPull(open);
      }
      let closed: RawPull | undefined;
      for await (const hits of pages('all')) {
        const merged = hits.find((p) => p.merged);
        if (merged) return toPull(merged);
        closed ??= hits[0];
      }
      return closed && toPull(closed);
    },

    async ciState(owner: string, repo: string, sha: string): Promise<CiState> {
      const res = await call<{ workflow_runs?: RawRun[] | null }>(
        'GET',
        `${repoPath(owner, repo)}/actions/runs?head_sha=${encodeURIComponent(sha)}`,
      );
      return combineRuns(res.workflow_runs ?? []);
    },

    async createPull(
      owner: string,
      repo: string,
      p: { head: string; base: string; title: string; body: string },
    ): Promise<PullInfo> {
      return toPull(await call<RawPull>('POST', `${repoPath(owner, repo)}/pulls`, p));
    },
  };
}

export function parseRemote(url: string): { baseUrl: string; owner: string; repo: string } {
  const fail = (): never => {
    throw new Error(`Cannot parse git remote URL: ${url}`);
  };
  const split = (path: string) => {
    const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '').split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return fail();
    return { owner: parts[0], repo: parts[1] };
  };

  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/)(.+)$/.exec(url);
  if (scp) return { baseUrl: `https://${scp[1]}`, ...split(scp[2]) };

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return fail();
  }
  if (u.protocol === 'ssh:') return { baseUrl: `https://${u.hostname}`, ...split(u.pathname) };
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    return { baseUrl: `${u.protocol}//${u.host}`, ...split(u.pathname) };
  }
  return fail();
}
