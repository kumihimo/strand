import type { CiState, PullInfo } from './gitea.ts';

/** What `strand pr` and the cockpit need from a forge. Gitea and GitHub both provide it. */
export type Forge = {
  name: 'Gitea' | 'GitHub';
  findPullForBranch(owner: string, repo: string, branch: string): Promise<PullInfo | undefined>;
  ciState(owner: string, repo: string, sha: string): Promise<CiState>;
  createPull(owner: string, repo: string, p: { head: string; base: string; title: string; body: string }): Promise<PullInfo>;
};

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The forge for a repo, by the lower-cased host of its origin: github.com is GitHub, the configured Gitea's host is
 * Gitea, and an unknown host (undefined) stays with Gitea as before. With no Gitea URL, a Gitea client given here
 * (only tests inject one) answers for every host but github.com. Any other host has no forge.
 */
export function pickForge(host: string | undefined, o: { giteaUrl?: string; gitea?: Forge; github?: Forge }): Forge | undefined {
  if (host === undefined) return o.gitea;
  if (host === 'github.com') return o.github;
  if (o.giteaUrl === undefined || host === hostOf(o.giteaUrl)) return o.gitea;
  return undefined;
}
