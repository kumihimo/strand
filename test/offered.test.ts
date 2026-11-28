import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OFFERED_TOOLS, downloadTo, installTool, installerEnv, isOfferedTool, offerFor, type InstallDeps } from '../src/core/offered.ts';
import type { RunOptions, RunResult } from '../src/core/exec.ts';

type Call = { cmd: string; args: string[]; opts: RunOptions };

/** A fake web: each URL answers a body, or a redirect to another URL. Every request is recorded. */
function web(routes: Record<string, { body?: string | Buffer; status?: number; location?: string }>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    asked.push(url);
    const r = routes[url];
    if (!r) return new Response('not found', { status: 404 });
    if (r.location) return new Response(null, { status: r.status ?? 302, headers: { location: r.location } });
    return new Response((r.body ?? '') as BodyInit, { status: r.status ?? 200 });
  }) as typeof fetch;
  return { asked, fetchImpl };
}

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'strand-offered-'));
  const toolsDir = path.join(dir, 'tools');
  return { dir, toolsDir, home: path.join(dir, 'home') };
}

function deps(over: Partial<InstallDeps> & { calls: Call[] }): InstallDeps {
  const { calls, ...rest } = over;
  return {
    platform: 'linux',
    arch: 'x64',
    env: { PATH: '/usr/bin', HOME: '/home/u' },
    home: '/home/u',
    toolsDir: '/unused',
    log: () => {},
    run: async (cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
      calls.push({ cmd, args, opts });
      return { code: 0, stdout: 'installed\n', stderr: '' };
    },
    version: async () => '9.9.9',
    exists: () => false,
    ...rest,
  };
}

test('every offered tool has a licence link, an official source and what will run', () => {
  assert.deepEqual([...OFFERED_TOOLS], ['but', 'claude', 'gh']);
  for (const tool of OFFERED_TOOLS) {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const o = offerFor(tool, platform, 'x64');
      assert.match(o.licence.url, /^https:\/\//, `${tool} ${platform}`);
      assert.ok(o.licence.name.length > 0);
      assert.ok(o.source.length > 0);
      assert.ok(o.action.length > 0);
      assert.ok(o.plan, `${tool} has a plan on ${platform}`);
    }
  }
  assert.equal(isOfferedTool('gh'), true);
  assert.equal(isOfferedTool('git'), false);
  assert.equal(isOfferedTool('__proto__'), false);
});

test('AT-5 Claude Code runs Anthropic\'s installer script, saved to a file and run without a shell', async () => {
  const s = sandbox();
  const { fetchImpl, asked } = web({
    'https://claude.ai/install.sh': { location: 'https://downloads.claude.ai/claude-code-releases/bootstrap.sh' },
    'https://downloads.claude.ai/claude-code-releases/bootstrap.sh': { body: '#!/bin/bash\necho hi\n' },
  });
  const calls: Call[] = [];
  const claude = '/home/u/.local/bin/claude';
  await installTool('claude', deps({ calls, fetch: fetchImpl, toolsDir: s.toolsDir, exists: (p) => p === claude }));
  assert.deepEqual(asked, ['https://claude.ai/install.sh', 'https://downloads.claude.ai/claude-code-releases/bootstrap.sh']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.cmd, 'bash');
  assert.equal(calls[0]!.args.length, 1);
  assert.match(calls[0]!.args[0]!, /install\.sh$/);
  // The downloaded file is gone afterwards.
  assert.equal(existsSync(calls[0]!.args[0]!), false);
});

test('AT-5 the argv per tool and OS is exactly the plan', () => {
  const env = { SystemRoot: 'C:\\Windows' };
  assert.deepEqual(offerFor('claude', 'win32', 'x64', env).plan, {
    kind: 'run',
    url: 'https://claude.ai/install.ps1',
    hosts: ['claude.ai', 'downloads.claude.ai'],
    file: 'install.ps1',
    argv: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', '{file}'],
  });
  assert.deepEqual(offerFor('but', 'darwin', 'arm64').plan, {
    kind: 'run',
    url: 'https://gitbutler.com/install.sh',
    hosts: ['gitbutler.com'],
    file: 'install.sh',
    argv: ['sh', '{file}'],
  });
  assert.deepEqual(offerFor('but', 'win32', 'x64', env).plan, {
    kind: 'run',
    url: 'https://app.gitbutler.com/downloads/release/windows/x86_64/msi',
    hosts: ['app.gitbutler.com', 'releases.gitbutler.com'],
    file: 'GitButler.msi',
    argv: ['C:\\Windows\\System32\\msiexec.exe', '/i', '{file}', '/passive', '/norestart'],
  });
  const gh = offerFor('gh', 'linux', 'arm64').plan;
  assert.equal(gh?.kind, 'gh-release');
  assert.equal(offerFor('but', 'win32', 'arm64', env).plan, undefined, 'no GitButler MSI for Windows on Arm');
});

test('AT-8 a redirect off the allowed hosts stops the install before anything runs', async () => {
  const s = sandbox();
  const { fetchImpl } = web({ 'https://claude.ai/install.sh': { location: 'https://evil.example/x.sh' } });
  const calls: Call[] = [];
  await assert.rejects(installTool('claude', deps({ calls, fetch: fetchImpl, toolsDir: s.toolsDir })), /evil\.example is not an allowed host/);
  assert.equal(calls.length, 0);
});

test('AT-8 a non-HTTPS address is refused, and a lookalike host is not allowed', async () => {
  const dest = path.join(sandbox().dir, 'f');
  const { fetchImpl, asked } = web({
    'https://claude.ai/a': { location: 'http://claude.ai/b' },
    'https://claude.ai/c': { location: 'https://claude.ai.evil.example/d' },
  });
  await assert.rejects(downloadTo('https://claude.ai/a', ['claude.ai'], dest, fetchImpl), /not https/);
  await assert.rejects(downloadTo('https://claude.ai/c', ['claude.ai'], dest, fetchImpl), /not an allowed host/);
  await assert.rejects(downloadTo('http://claude.ai/x', ['claude.ai'], dest, fetchImpl), /not https/);
  assert.deepEqual(asked, ['https://claude.ai/a', 'https://claude.ai/c']);
  assert.equal(existsSync(dest), false);
});

test('AT-8 a download that fails is reported with its status', async () => {
  const dest = path.join(sandbox().dir, 'f');
  const { fetchImpl } = web({ 'https://claude.ai/x': { status: 500, body: 'oops' } });
  await assert.rejects(downloadTo('https://claude.ai/x', ['claude.ai'], dest, fetchImpl), /HTTP 500/);
});

/** The gh release API answer and its files, for linux amd64. */
function ghRelease(archive: Buffer, sum: string) {
  const base = 'https://github.com/cli/cli/releases/download/v2.50.0';
  const name = 'gh_2.50.0_linux_amd64.tar.gz';
  return web({
    'https://api.github.com/repos/cli/cli/releases/latest': {
      body: JSON.stringify({
        tag_name: 'v2.50.0',
        assets: [
          { name, browser_download_url: `${base}/${name}` },
          { name: 'gh_2.50.0_checksums.txt', browser_download_url: `${base}/gh_2.50.0_checksums.txt` },
        ],
      }),
    },
    [`${base}/${name}`]: { location: 'https://release-assets.githubusercontent.com/a' },
    'https://release-assets.githubusercontent.com/a': { body: archive },
    [`${base}/gh_2.50.0_checksums.txt`]: { location: 'https://release-assets.githubusercontent.com/c' },
    'https://release-assets.githubusercontent.com/c': { body: `${sum}  ${name}\n0000  gh_2.50.0_windows_amd64.zip\n` },
  });
}

test('AT-9 a gh archive with a wrong SHA-256 is deleted and not unpacked', async () => {
  const s = sandbox();
  const archive = Buffer.from('archive bytes');
  const { fetchImpl } = ghRelease(archive, 'f'.repeat(64));
  const calls: Call[] = [];
  await assert.rejects(installTool('gh', deps({ calls, fetch: fetchImpl, toolsDir: s.toolsDir })), /checksum/);
  assert.equal(calls.length, 0, 'tar never ran');
  assert.deepEqual(existsSync(s.toolsDir) ? readdirSync(s.toolsDir) : [], [], 'nothing left in the tools folder');
});

test('AT-9 a gh archive with the right SHA-256 is unpacked into the tools folder', async () => {
  const s = sandbox();
  const archive = Buffer.from('archive bytes');
  const sum = createHash('sha256').update(archive).digest('hex');
  const { fetchImpl } = ghRelease(archive, sum);
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    calls.push({ cmd, args, opts });
    // tar -xf <archive> -C <dest>: lay out what the real archive holds.
    const dest = args[args.indexOf('-C') + 1]!;
    mkdirSync(path.join(dest, 'gh_2.50.0_linux_amd64', 'bin'), { recursive: true });
    writeFileSync(path.join(dest, 'gh_2.50.0_linux_amd64', 'bin', 'gh'), '');
    return { code: 0, stdout: '', stderr: '' };
  };
  const gh = path.join(s.toolsDir, 'gh', 'bin', 'gh');
  const r = await installTool('gh', deps({ calls, fetch: fetchImpl, toolsDir: s.toolsDir, run, exists: (p) => p === gh }));
  assert.equal(calls[0]!.cmd, 'tar');
  assert.equal(existsSync(gh), true);
  assert.equal(r.path, gh);
  assert.deepEqual(readdirSync(s.toolsDir), ['gh'], 'temp folders are cleaned up');
});

test('AT-10 an installer that exits non-zero fails with its exit code', async () => {
  const s = sandbox();
  const { fetchImpl } = web({ 'https://gitbutler.com/install.sh': { body: 'exit 3' } });
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    calls.push({ cmd, args, opts });
    opts.onOutput?.('it broke\n');
    return { code: 3, stdout: 'it broke\n', stderr: '' };
  };
  const lines: string[] = [];
  await assert.rejects(installTool('but', deps({ calls, fetch: fetchImpl, toolsDir: s.toolsDir, run, log: (l) => lines.push(l) })), /exited with code 3/);
  assert.ok(lines.some((l) => l.includes('it broke')));
});

test('AT-11 after install the tool is found and its absolute path returned', async () => {
  const s = sandbox();
  const { fetchImpl } = web({ 'https://gitbutler.com/install.sh': { body: 'ok' } });
  const calls: Call[] = [];
  const but = '/home/u/.local/bin/but';
  const r = await installTool('but', deps({ calls, fetch: fetchImpl, toolsDir: s.toolsDir, exists: (p) => p === but }));
  assert.equal(r.path, but);
  assert.equal(r.found, '9.9.9');
});

test('AT-11 an install that leaves no program to find fails', async () => {
  const s = sandbox();
  const { fetchImpl } = web({ 'https://gitbutler.com/install.sh': { body: 'ok' } });
  await assert.rejects(installTool('but', deps({ calls: [], fetch: fetchImpl, toolsDir: s.toolsDir })), /cannot find but/);
});

test('AT-13 the installer gets no tokens or credentials from the environment', async () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    ANTHROPIC_API_KEY: 'k',
    ANTHROPIC_AUTH_TOKEN: 't',
    CLAUDE_CODE_OAUTH_TOKEN: 'o',
    GH_TOKEN: 'g',
    GITHUB_TOKEN: 'g',
    GH_ENTERPRISE_TOKEN: 'g',
    STRAND_GITEA_TOKEN: 's',
    SDLC_GITEA_TOKEN: 's',
    AWS_SECRET_ACCESS_KEY: 'a',
    NPM_TOKEN: 'n',
  };
  const clean = installerEnv(env);
  assert.deepEqual(Object.keys(clean).sort(), ['HOME', 'PATH']);

  const s = sandbox();
  const { fetchImpl } = web({ 'https://claude.ai/install.sh': { body: 'ok' } });
  const calls: Call[] = [];
  const claude = '/home/u/.local/bin/claude';
  await installTool('claude', deps({ calls, fetch: fetchImpl, toolsDir: s.toolsDir, env, exists: (p) => p === claude }));
  assert.deepEqual(calls[0]!.opts.exactEnv, { PATH: '/usr/bin', HOME: '/home/u' });
  // No sign-in step: the one command run is the installer.
  assert.equal(calls.length, 1);
});

test('AT-11 a gh zip with bin at its root (the Windows layout) lands in tools/gh/bin', async () => {
  const s = sandbox();
  const archive = Buffer.from('zip bytes');
  const sum = createHash('sha256').update(archive).digest('hex');
  const base = 'https://github.com/cli/cli/releases/download/v2.50.0';
  const name = 'gh_2.50.0_windows_amd64.zip';
  const { fetchImpl } = web({
    'https://api.github.com/repos/cli/cli/releases/latest': {
      body: JSON.stringify({
        tag_name: 'v2.50.0',
        assets: [
          { name, browser_download_url: `${base}/${name}` },
          { name: 'gh_2.50.0_checksums.txt', browser_download_url: `${base}/gh_2.50.0_checksums.txt` },
        ],
      }),
    },
    [`${base}/${name}`]: { body: archive },
    [`${base}/gh_2.50.0_checksums.txt`]: { body: `${sum}  ${name}\n` },
  });
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    calls.push({ cmd, args, opts });
    const dest = args[args.indexOf('-C') + 1]!;
    mkdirSync(path.join(dest, 'bin'), { recursive: true });
    writeFileSync(path.join(dest, 'bin', 'gh.exe'), '');
    writeFileSync(path.join(dest, 'LICENSE'), '');
    return { code: 0, stdout: '', stderr: '' };
  };
  // The probe joins Windows paths; on this host the folder is a POSIX one.
  const gh = path.win32.join(s.toolsDir, 'gh', 'bin', 'gh.exe');
  await installTool('gh', deps({ calls, fetch: fetchImpl, toolsDir: s.toolsDir, run, platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, exists: (p) => p === gh }));
  assert.equal(existsSync(path.join(s.toolsDir, 'gh', 'bin', 'gh.exe')), true);
});

test('the log shows the command with its flags as run, and only the downloaded file shortened', async () => {
  const s = sandbox();
  const { fetchImpl } = web({ 'https://app.gitbutler.com/downloads/release/windows/x86_64/msi': { body: 'msi' } });
  const lines: string[] = [];
  const but = path.win32.join('C:\\Program Files', 'GitButler', 'but.exe');
  await installTool('but', deps({ calls: [], fetch: fetchImpl, toolsDir: s.toolsDir, platform: 'win32', env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, exists: (p) => p === but, log: (l) => lines.push(l) }));
  assert.ok(lines.includes('$ msiexec.exe /i GitButler.msi /passive /norestart'), lines.join('\n'));
});
