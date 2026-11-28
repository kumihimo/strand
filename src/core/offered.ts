// The tools Strand offers to install rather than bundle (RFC 0004 section 2, ADR 0029), and the installer that
// runs each one's official plan. A request names only the tool; the URL, hosts and command line come from here.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ENV_PREFIX, LEGACY_ENV_PREFIX } from './config.ts';
import { run as defaultRun, type RunOptions, type RunResult } from './exec.ts';
import { probeTool, type ToolName } from './tools.ts';

export type OfferedTool = 'but' | 'claude' | 'gh';
export const OFFERED_TOOLS: readonly OfferedTool[] = ['but', 'claude', 'gh'];

export function isOfferedTool(v: unknown): v is OfferedTool {
  return typeof v === 'string' && (OFFERED_TOOLS as readonly string[]).includes(v);
}

/** Download one file and run it: `{file}` in argv is the downloaded file's path. */
export type RunPlan = { kind: 'run'; url: string; hosts: readonly string[]; file: string; argv: readonly string[] };
/** The latest `gh` release archive for this OS and arch, checked against the release's checksums file, then unpacked. */
export type GhPlan = { kind: 'gh-release'; api: string; hosts: readonly string[]; os: string; arch: string; ext: 'zip' | 'tar.gz' };
export type Plan = RunPlan | GhPlan;

export type Offer = {
  tool: OfferedTool;
  title: string;
  licence: { name: string; url: string };
  /** The official source, as shown beside the consent box. */
  source: string;
  /** What will run, in words, as shown beside the consent box. */
  action: string;
  /** What the user does after the install; the app never signs in for them. */
  after: string;
  /** How to upgrade a copy that is too old: setup never reinstalls over an installed tool. */
  upgrade: string;
  /** Undefined when there is no official installer for this OS and arch. */
  plan?: Plan;
};

const GH_HOSTS = ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];

function systemExe(env: NodeJS.ProcessEnv, ...rel: string[]): string {
  return path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', ...rel);
}

/** The offer for one tool on this OS and arch. */
export function offerFor(tool: OfferedTool, platform: NodeJS.Platform, arch: string, env: NodeJS.ProcessEnv = process.env): Offer {
  const win = platform === 'win32';
  switch (tool) {
    case 'claude':
      return {
        tool,
        title: 'Claude Code',
        licence: { name: "Anthropic's Commercial Terms", url: 'https://code.claude.com/docs/en/legal-and-compliance' },
        source: 'claude.ai (Anthropic)',
        action: win ? "Runs Anthropic's installer, install.ps1, in PowerShell. No admin rights." : "Runs Anthropic's installer, install.sh, with bash. No admin rights.",
        after: 'Sign in to Claude Code yourself when your first session starts.',
        upgrade: 'Run claude update.',
        plan: win
          ? {
              kind: 'run',
              url: 'https://claude.ai/install.ps1',
              hosts: ['claude.ai', 'downloads.claude.ai'],
              file: 'install.ps1',
              argv: [systemExe(env, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', '{file}'],
            }
          : { kind: 'run', url: 'https://claude.ai/install.sh', hosts: ['claude.ai', 'downloads.claude.ai'], file: 'install.sh', argv: ['bash', '{file}'] },
      };
    case 'but':
      return {
        tool,
        title: 'GitButler',
        licence: { name: 'FSL-1.1-MIT', url: 'https://github.com/gitbutlerapp/gitbutler/blob/master/LICENSE.md' },
        source: 'gitbutler.com',
        action: win
          ? "Runs GitButler's Windows installer (MSI). Windows asks for admin rights."
          : "Runs GitButler's installer, install.sh, with sh. No admin rights.",
        after: 'Nothing more to do.',
        upgrade: 'Run but update.',
        plan: win
          ? arch === 'x64'
            ? {
                kind: 'run',
                url: 'https://app.gitbutler.com/downloads/release/windows/x86_64/msi',
                hosts: ['app.gitbutler.com', 'releases.gitbutler.com'],
                file: 'GitButler.msi',
                argv: [systemExe(env, 'msiexec.exe'), '/i', '{file}', '/passive', '/norestart'],
              }
            : undefined
          : { kind: 'run', url: 'https://gitbutler.com/install.sh', hosts: ['gitbutler.com'], file: 'install.sh', argv: ['sh', '{file}'] },
      };
    case 'gh': {
      const ghArch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : undefined;
      const os = win ? 'windows' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'linux' : undefined;
      return {
        tool,
        title: 'GitHub CLI (gh)',
        licence: { name: 'MIT', url: 'https://github.com/cli/cli/blob/trunk/LICENSE' },
        source: 'github.com/cli/cli releases',
        action: "Downloads the latest gh release, checks its SHA-256 against the release's checksums, and unpacks it into Strand's tools folder. No admin rights.",
        after: 'Run gh auth login yourself to sign in to GitHub.',
        upgrade: 'Install a newer gh from github.com/cli/cli/releases, or upgrade it with the package manager it came from.',
        plan:
          ghArch && os
            ? { kind: 'gh-release', api: 'https://api.github.com/repos/cli/cli/releases/latest', hosts: GH_HOSTS, os, arch: ghArch, ext: os === 'linux' ? 'tar.gz' : 'zip' }
            : undefined,
      };
    }
  }
}

/** Names that may carry a secret: never passed to an installer (ADR 0029). */
const SECRET = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_KEY|PRIVATE_KEY|AUTH)/i;
const DROPPED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'CLAUDECODE', ENV_PREFIX, LEGACY_ENV_PREFIX, 'BEADS_'];

/** The environment an installer runs with: the user's, minus anything that may hold a token or credential. */
export function installerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || SECRET.test(k) || DROPPED_PREFIXES.some((p) => k.toUpperCase().startsWith(p))) continue;
    out[k] = v;
  }
  return out;
}

const MAX_REDIRECTS = 5;
const MAX_BYTES = 300 * 1024 * 1024;

function checkUrl(url: string, hosts: readonly string[]): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`refused ${url}: not a valid address`);
  }
  if (u.protocol !== 'https:') throw new Error(`refused ${u.href}: not https`);
  if (u.username || u.password) throw new Error(`refused ${u.host}: carries a user name`);
  if (!hosts.includes(u.hostname)) throw new Error(`refused the download: ${u.hostname} is not an allowed host`);
  return u;
}

/** Fetch `url` over HTTPS, following redirects only to `hosts`. Returns the body. */
async function fetchAllowed(url: string, hosts: readonly string[], fetchImpl: typeof fetch): Promise<Buffer> {
  let u = checkUrl(url, hosts);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await fetchImpl(u.href, { redirect: 'manual', headers: { 'user-agent': 'strand-setup' } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`${u.hostname} redirected with no address`);
      u = checkUrl(new URL(loc, u).href, hosts);
      continue;
    }
    if (!res.ok) throw new Error(`download from ${u.hostname} failed: HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) throw new Error(`download from ${u.hostname} is too large`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_BYTES) throw new Error(`download from ${u.hostname} is too large`);
    return body;
  }
  throw new Error(`too many redirects from ${new URL(url).hostname}`);
}

/** Download `url` to `dest`, over HTTPS and only through `hosts`. Nothing is written when any check fails. */
export async function downloadTo(url: string, hosts: readonly string[], dest: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const body = await fetchAllowed(url, hosts, fetchImpl);
  writeFileSync(dest, body, { mode: 0o600 });
}

export type InstallDeps = {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  home: string;
  /** Strand's tools folder (`tools` beside the config file). Temp folders are made inside it and removed. */
  toolsDir: string;
  log: (line: string) => void;
  fetch?: typeof fetch;
  run?: (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;
  /** For the probe after the install (tests inject these). */
  exists?: (p: string) => boolean;
  version?: (exe: string) => Promise<string | undefined>;
};

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

function lines(log: (l: string) => void): (chunk: string) => void {
  let rest = '';
  return (chunk) => {
    rest += chunk;
    const parts = rest.split(/\r?\n/);
    rest = parts.pop() ?? '';
    for (const p of parts) if (p.trim()) log(p);
  };
}

/** The last part of a path, whichever separator it uses. */
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Run one step. The log shows the program's name and the args as run, with files in `tmp` shortened to their names. */
async function runChecked(d: InstallDeps, argv: readonly string[], what: string, tmp: string): Promise<void> {
  const run = d.run ?? defaultRun;
  const [cmd, ...args] = argv as [string, ...string[]];
  d.log(`$ ${[baseName(cmd), ...args.map((a) => (a.startsWith(tmp) ? baseName(a) : a))].join(' ')}`);
  const r = await run(cmd, args, { exactEnv: installerEnv(d.env), timeoutMs: INSTALL_TIMEOUT_MS, onOutput: lines(d.log) });
  if (r.code !== 0) throw new Error(`${what} exited with code ${r.code}`);
}

type GhAsset = { name: string; browser_download_url: string };

async function installGh(plan: GhPlan, d: InstallDeps, tmp: string): Promise<void> {
  const f = d.fetch ?? fetch;
  const rel = JSON.parse((await fetchAllowed(plan.api, plan.hosts, f)).toString('utf8')) as { tag_name?: unknown; assets?: unknown };
  const tag = typeof rel.tag_name === 'string' ? rel.tag_name : '';
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !Array.isArray(rel.assets)) throw new Error('the gh release answer has no version');
  const v = tag.slice(1);
  const assets = rel.assets as GhAsset[];
  const want = `gh_${v}_${plan.os}_${plan.arch}.${plan.ext}`;
  const archive = assets.find((a) => a?.name === want);
  const sums = assets.find((a) => a?.name === `gh_${v}_checksums.txt`);
  if (!archive || !sums) throw new Error(`the gh ${v} release has no ${want} or no checksums file`);
  d.log(`Downloading ${want}`);
  const file = path.join(tmp, want);
  await downloadTo(archive.browser_download_url, plan.hosts, file, f);
  const sumText = (await fetchAllowed(sums.browser_download_url, plan.hosts, f)).toString('utf8');
  const expected = sumText
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .find((parts) => parts[1] === want)?.[0]
    ?.toLowerCase();
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (!expected || expected !== actual) {
    rmSync(file, { force: true });
    throw new Error(`the gh archive's checksum does not match the release's checksums file; nothing was unpacked`);
  }
  d.log('Checksum matches.');
  const out = path.join(tmp, 'x');
  mkdirSync(out);
  const tar = d.platform === 'win32' ? systemExe(d.env, 'tar.exe') : 'tar';
  await runChecked(d, [tar, '-xf', file, '-C', out], 'tar', tmp);
  // The Windows zip holds bin\ at its root; the Linux and macOS archives hold one gh_<v>_<os>_<arch>/ folder.
  const isDir = (p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const top = readdirSync(out).filter((n) => isDir(path.join(out, n)));
  const root = isDir(path.join(out, 'bin')) ? out : top.length === 1 && isDir(path.join(out, top[0]!, 'bin')) ? path.join(out, top[0]!) : undefined;
  if (!root) throw new Error('the gh archive has no bin folder');
  const target = path.join(d.toolsDir, 'gh');
  rmSync(target, { recursive: true, force: true });
  cpSync(root, target, { recursive: true });
}

/**
 * Run the official plan for `tool`, then find the installed program. Returns its absolute path and version.
 * The caller checks consent and that the tool is missing (ADR 0029). Throws with a one-line reason on failure.
 */
export async function installTool(tool: OfferedTool, d: InstallDeps): Promise<{ path: string; found?: string }> {
  const offer = offerFor(tool, d.platform, d.arch, d.env);
  const plan = offer.plan;
  if (!plan) throw new Error(`there is no official ${offer.title} installer for ${d.platform} ${d.arch}`);
  mkdirSync(d.toolsDir, { recursive: true });
  const tmp = mkdtempSync(path.join(d.toolsDir, '.install-'));
  try {
    if (plan.kind === 'run') {
      d.log(`Downloading from ${new URL(plan.url).hostname}`);
      const file = path.join(tmp, plan.file);
      await downloadTo(plan.url, plan.hosts, file, d.fetch ?? fetch);
      await runChecked(d, plan.argv.map((a) => (a === '{file}' ? file : a)), `the ${offer.title} installer`, tmp);
    } else {
      await installGh(plan, d, tmp);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const state = await probeTool(tool as ToolName, {
    platform: d.platform,
    env: d.env,
    home: d.home,
    toolsDir: d.toolsDir,
    exists: d.exists,
    version: d.version,
  });
  if (!state.path) throw new Error(`the installer finished, but strand cannot find ${tool}`);
  d.log(`Found ${tool}${state.found ? ` ${state.found}` : ''} at ${state.path}`);
  return { path: state.path, found: state.found };
}
