import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { liveSessions, recordEnd, recordStart } from '../src/core/sessions.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ToolMissingError } from '../src/core/exec.ts';
import type { ListedBead } from '../src/core/bd.ts';
import { readBinding } from '../src/core/binding.ts';
import type { Config } from '../src/core/config.ts';
import { launchInteractive, type SpawnFn } from '../src/cli/launch.ts';
import { main as work } from '../src/cli/commands/work.ts';
import { errorMessage } from '../src/cli/strand.ts';
import type { Ctx } from '../src/cli/ctx.ts';

test('a missing tool prints its hint exactly once', () => {
  const hint = 'Install claude and make sure it is on PATH';
  assert.equal(errorMessage(new ToolMissingError('claude', hint)), `claude not found — ${hint}`);
  const old = new ToolMissingError('bd', 'Upgrade bd to 2.0.0 or newer', 'bd 1.0.0 is older than the required minimum 2.0.0');
  assert.equal(errorMessage(old), 'bd 1.0.0 is older than the required minimum 2.0.0 — Upgrade bd to 2.0.0 or newer');
  assert.equal(errorMessage(new Error('plain')), 'plain');
});

test('launch ignores SIGINT only while the child runs and returns its exit code', async () => {
  const before = process.listenerCount('SIGINT');
  const beforeTerm = process.listenerCount('SIGTERM');
  const child = new EventEmitter() as ChildProcess;
  child.kill = () => true;
  const spawnFn: SpawnFn = () => child;
  const p = launchInteractive('claude', [], tmpdir(), {}, spawnFn);
  assert.equal(process.listenerCount('SIGINT'), before + 1);
  process.emit('SIGINT', 'SIGINT');
  child.emit('close', 7, null);
  assert.equal(await p, 7);
  assert.equal(process.listenerCount('SIGINT'), before);
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
});

test('launch removes its handlers when the child fails to start', async () => {
  const before = process.listenerCount('SIGINT');
  const child = new EventEmitter() as ChildProcess;
  const p = launchInteractive('claude', [], tmpdir(), {}, () => child);
  child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(p, ToolMissingError);
  assert.equal(process.listenerCount('SIGINT'), before);
});

test('Ctrl+C to the foreground group leaves the parent waiting for the child', {
  skip: process.platform === 'win32' ? 'POSIX process groups only' : false,
}, async () => {
  const launch = pathToFileURL(join(import.meta.dirname, '..', 'src', 'cli', 'launch.ts')).href;
  const childScript = "process.on('SIGINT',()=>{});process.stderr.write('ready\\n');setTimeout(()=>process.exit(7),1500)";
  const driver = `import { launchInteractive } from ${JSON.stringify(launch)};
process.exitCode = await launchInteractive(process.execPath, ['-e', ${JSON.stringify(childScript)}], process.cwd(), process.env);`;
  // detached: the driver leads its own process group, like a shell job in the foreground.
  const parent = nodeSpawn(process.execPath, ['--input-type=module', '-e', driver], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await new Promise<void>((resolve) => parent.stderr!.on('data', (d) => String(d).includes('ready') && resolve()));
  process.kill(-parent.pid!, 'SIGINT');
  const [code, signal] = await new Promise<[number | null, string | null]>((r) => parent.on('close', (c, s) => r([c, s])));
  assert.equal(signal, null);
  assert.equal(code, 7);
});

// --- strand work ------------------------------------------------------------------------------

function bead(id: string, over: Partial<ListedBead> = {}): ListedBead {
  return { id, title: `title ${id}`, status: 'open', priority: 2, issue_type: 'task', labels: ['repo:svc'], dependencies: [], ...over };
}

const APPROVED = 'plan-approved 2026-11-20T10:00:00.000Z';
const IN_REVIEW = { notes: APPROVED, acceptance_criteria: '- [x] a (verified: ok)', labels: ['pr:acme/svc#1'] };

function workCtx(list: ListedBead[], over: Partial<Config> = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'strand-work-'));
  mkdirSync(join(ws, 'svc'));
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const config: Config = {
    workspaceRoot: ws,
    trackerDir: join(ws, 'tracker'),
    docsRepo: join(ws, 'docs'),
    wip: { build: 3, review: 3, mode: 'warn' },
    artefactsVcs: 'none',
    cockpit: { window: 'app', maxSessions: 4 },
    ...over,
  };
  const beads = {
    async listAll() {
      calls.push('listAll');
      return list;
    },
    async claim(id: string) {
      calls.push(`claim ${id}`);
    },
    async comment(id: string, text: string) {
      calls.push(`comment ${id} ${text.replace(/[0-9a-f-]{36}/, '<sid>')}`);
    },
  };
  const ctx = {
    config,
    beads,
    out: (s: string) => void out.push(s),
    err: (s: string) => void err.push(s),
    env: { STRAND_DRY_RUN_CLAUDE: '1' },
    cwd: ws,
  } as unknown as Ctx;
  return { ctx, calls, out, err, ws, done: () => rmSync(ws, { recursive: true, force: true }) };
}

const CLAUDE_EXE = String.raw`C:\Users\me\.local\bin\claude.exe`;

test('work claims an open bead, records and binds the session, and writes no notes', async () => {
  const t = workCtx([bead('sub-a1')], { claudePath: CLAUDE_EXE });
  try {
    assert.equal(await work(['sub-a1', '--json'], t.ctx), 0);
    assert.deepEqual(t.calls, ['listAll', 'claim sub-a1', 'comment sub-a1 session <sid> started']);
    const data = JSON.parse(t.out[0]!);
    assert.equal(data.command, CLAUDE_EXE);
    assert.equal(data.stage, 'backlog');
    assert.equal(data.cwd, join(t.ws, 'svc'));
    const entry = JSON.parse(readFileSync(join(t.ws, 'tracker', '.strand', 'sessions', `${data.sessionId}.json`), 'utf8'));
    assert.equal(entry.beadId, 'sub-a1');
    // The stage after the claim, so the first prompt after an approval says the stage changed.
    assert.deepEqual(readBinding(join(t.ws, 'tracker'), data.sessionId), { bead: 'sub-a1', lastStage: 'specify' });
  } finally {
    t.done();
  }
});

test('work prints the claude command, with claude as the default', async () => {
  const t = workCtx([bead('sub-a1', { status: 'in_progress' })]);
  try {
    assert.equal(await work(['sub-a1'], t.ctx), 0);
    assert.match(t.out[0]!, /^claude --session-id [0-9a-f-]{36} --model opus --effort high --name "sub-a1 title sub-a1"$/);
    assert.equal(t.out[1], `cwd: ${join(t.ws, 'svc')}`);
    assert.ok(!t.calls.includes('claim sub-a1'), 'already in progress');
  } finally {
    t.done();
  }
});

const SID_A = '11111111-2222-3333-4444-555555555555';

test('work args: plain, --specify and --resume', async () => {
  const t = workCtx([bead('sub-a1', { status: 'in_progress' }), bead('sub-b2', { status: 'in_progress' })]);
  try {
    await work(['sub-a1', '--json'], t.ctx);
    const plain = JSON.parse(t.out.pop()!);
    assert.deepEqual(plain.args, ['--session-id', plain.sessionId, '--model', 'opus', '--effort', 'high', '--name', 'sub-a1 title sub-a1']);

    await work(['sub-a1', '--specify', '--json'], t.ctx);
    const spec = JSON.parse(t.out.pop()!);
    // No plan mode: the Specify session saves the spec to the bead and stops for approval.
    assert.deepEqual(spec.args, ['--session-id', spec.sessionId, '--model', 'opus', '--effort', 'high', '--name', 'sub-a1 title sub-a1', '/strand:work sub-a1']);
    assert.ok(!spec.args.includes('--permission-mode'));

    recordStart(join(t.ws, 'tracker'), { sessionId: SID_A, beadId: 'sub-a1' });
    const before = readdirSync(join(t.ws, 'tracker', '.strand', 'sessions')).sort();
    await work(['sub-a1', '--resume', SID_A, '--json'], t.ctx);
    const res = JSON.parse(t.out.pop()!);
    assert.deepEqual(res.args, ['--resume', SID_A, '--model', 'opus', '--effort', 'high', '--name', 'sub-a1 title sub-a1']);
    assert.equal(res.sessionId, SID_A);
    assert.ok(!res.args.includes('--session-id'));
    assert.deepEqual(readdirSync(join(t.ws, 'tracker', '.strand', 'sessions')).sort(), before, 'no new session record');
    assert.deepEqual(readBinding(join(t.ws, 'tracker'), SID_A), { bead: 'sub-a1', lastStage: 'specify' });
  } finally {
    t.done();
  }
});

test('work --resume makes an ended session live again in the index', async () => {
  const t = workCtx([bead('sub-a1', { status: 'in_progress' })]);
  try {
    const tracker = join(t.ws, 'tracker');
    recordStart(tracker, { sessionId: SID_A, beadId: 'sub-a1' });
    recordEnd(tracker, { sessionId: SID_A });
    await work(['sub-a1', '--resume', SID_A, '--json'], t.ctx);
    assert.deepEqual(liveSessions(tracker).map((s) => s.sessionId), [SID_A]);
  } finally {
    t.done();
  }
});

test('work passes each existing context folder as --add-dir, before the plan prompt, and warns once for missing ones', async () => {
  const labels = ['repo:svc', 'context:docs', 'context:gone', 'context:lib', 'context:svc', 'context:..', 'context:old'];
  const t = workCtx([bead('sub-a1', { status: 'in_progress', labels })]);
  mkdirSync(join(t.ws, 'docs'));
  mkdirSync(join(t.ws, 'lib'));
  try {
    await work(['sub-a1', '--json'], t.ctx);
    const plain = JSON.parse(t.out.pop()!);
    const docs = join(t.ws, 'docs');
    const lib = join(t.ws, 'lib');
    assert.deepEqual(plain.args, ['--session-id', plain.sessionId, '--model', 'opus', '--effort', 'high', '--add-dir', docs, '--add-dir', lib, '--name', 'sub-a1 title sub-a1']);
    assert.deepEqual(t.err, ['warning: context folders not found, skipped: gone, old']);

    await work(['sub-a1', '--specify', '--json'], t.ctx);
    const spec = JSON.parse(t.out.pop()!);
    // --add-dir takes several values: another option must follow it, or it would swallow the prompt. With
    // context folders and no plugin dir, --name (one value) sits between them.
    assert.deepEqual(spec.args, ['--session-id', spec.sessionId, '--model', 'opus', '--effort', 'high', '--add-dir', docs, '--add-dir', lib, '--name', 'sub-a1 title sub-a1', '/strand:work sub-a1']);
    assert.notEqual(spec.args.at(-3), lib, 'no --add-dir value just before the prompt');
  } finally {
    t.done();
  }
});

test('work on win32 skips a context folder that names the primary in another case, and repeats in another case', {
  skip: process.platform === 'win32' ? false : 'case-insensitive names on win32 only',
}, async () => {
  const t = workCtx([bead('sub-a1', { status: 'in_progress', labels: ['repo:svc', 'context:SVC', 'context:Docs', 'context:docs'] })]);
  mkdirSync(join(t.ws, 'docs'));
  try {
    await work(['sub-a1', '--json'], t.ctx);
    const r = JSON.parse(t.out.pop()!);
    assert.deepEqual(r.args.slice(6, 8), ['--add-dir', join(t.ws, 'Docs')]);
    assert.equal(r.args.length, 10);
    assert.deepEqual(t.err, []);
  } finally {
    t.done();
  }
});

test('work loads the plugin from STRAND_PLUGIN_DIR when it holds .claude-plugin, before the plan prompt', async () => {
  const t = workCtx([bead('sub-a1', { status: 'in_progress' })]);
  const plugin = join(t.ws, 'plugin');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  try {
    t.ctx.env.STRAND_PLUGIN_DIR = plugin;
    await work(['sub-a1', '--specify', '--json'], t.ctx);
    const spec = JSON.parse(t.out.pop()!);
    assert.deepEqual(spec.args.slice(2), ['--model', 'opus', '--effort', 'high', '--plugin-dir', plugin, '--name', 'sub-a1 title sub-a1', '/strand:work sub-a1']);
    assert.deepEqual(t.err, []);

    delete t.ctx.env.STRAND_PLUGIN_DIR;
    await work(['sub-a1', '--json'], t.ctx);
    assert.ok(!JSON.parse(t.out.pop()!).args.includes('--plugin-dir'), 'unset: no flag');
  } finally {
    t.done();
  }
});

test('work warns once and carries on when STRAND_PLUGIN_DIR is missing or has no .claude-plugin', async () => {
  const t = workCtx([bead('sub-a1', { status: 'in_progress' })]);
  const bare = join(t.ws, 'bare');
  mkdirSync(bare);
  try {
    for (const dir of [join(t.ws, 'nope'), bare]) {
      t.err.length = 0;
      t.ctx.env.STRAND_PLUGIN_DIR = dir;
      assert.equal(await work(['sub-a1', '--json'], t.ctx), 0);
      assert.ok(!JSON.parse(t.out.pop()!).args.includes('--plugin-dir'), dir);
      assert.deepEqual(t.err, [`warning: STRAND_PLUGIN_DIR ${dir} has no .claude-plugin folder; the plugin is not loaded`]);
    }
  } finally {
    t.done();
  }
});

test('work ignores a relative STRAND_PLUGIN_DIR: it would resolve against the bead repo folder', async () => {
  const t = workCtx([bead('sub-a1', { status: 'in_progress' })]);
  try {
    // The test runs in this checkout, which has a .claude-plugin folder: '.' would load it.
    for (const dir of ['.', 'plugin']) {
      t.err.length = 0;
      t.ctx.env.STRAND_PLUGIN_DIR = dir;
      assert.equal(await work(['sub-a1', '--json'], t.ctx), 0);
      assert.ok(!JSON.parse(t.out.pop()!).args.includes('--plugin-dir'), dir);
      assert.deepEqual(t.err, [`warning: STRAND_PLUGIN_DIR ${dir} is not an absolute path; the plugin is not loaded`]);
    }
  } finally {
    t.done();
  }
});

test('work --specify with context folders and STRAND_PLUGIN_DIR: exact list, model and effort first, prompt last', async () => {
  const t = workCtx([bead('sub-a1', { status: 'in_progress', labels: ['repo:svc', 'context:docs', 'context:lib'] })]);
  mkdirSync(join(t.ws, 'docs'));
  mkdirSync(join(t.ws, 'lib'));
  const plugin = join(t.ws, 'plugin');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  try {
    t.ctx.env.STRAND_PLUGIN_DIR = plugin;
    await work(['sub-a1', '--specify', '--json'], t.ctx);
    const spec = JSON.parse(t.out.pop()!);
    assert.deepEqual(spec.args, [
      '--session-id', spec.sessionId, '--model', 'opus', '--effort', 'high',
      '--add-dir', join(t.ws, 'docs'), '--add-dir', join(t.ws, 'lib'),
      '--plugin-dir', plugin, '--name', 'sub-a1 title sub-a1', '/strand:work sub-a1',
    ]);
  } finally {
    t.done();
  }
});

test('work uses the configured model and effort, in all three modes', async () => {
  const t = workCtx([bead('sub-a1', { status: 'in_progress' })], { claudeModel: 'sonnet', claudeEffort: 'max' });
  try {
    recordStart(join(t.ws, 'tracker'), { sessionId: SID_A, beadId: 'sub-a1' });
    await work(['sub-a1', '--json'], t.ctx);
    assert.deepEqual(JSON.parse(t.out.pop()!).args.slice(2, 6), ['--model', 'sonnet', '--effort', 'max']);
    await work(['sub-a1', '--specify', '--json'], t.ctx);
    assert.deepEqual(JSON.parse(t.out.pop()!).args.slice(2, 6), ['--model', 'sonnet', '--effort', 'max']);
    await work(['sub-a1', '--resume', SID_A, '--json'], t.ctx);
    assert.deepEqual(JSON.parse(t.out.pop()!).args, ['--resume', SID_A, '--model', 'sonnet', '--effort', 'max', '--name', 'sub-a1 title sub-a1']);
  } finally {
    t.done();
  }
});

test('work passes no flag for a value of default, each one on its own', async () => {
  const t = workCtx([bead('sub-a1', { status: 'in_progress' })], { claudeModel: 'default', claudeEffort: 'default' });
  try {
    await work(['sub-a1', '--specify', '--json'], t.ctx);
    const both = JSON.parse(t.out.pop()!);
    assert.deepEqual(both.args, ['--session-id', both.sessionId, '--name', 'sub-a1 title sub-a1', '/strand:work sub-a1']);
    t.ctx.config.claudeEffort = 'low';
    await work(['sub-a1', '--json'], t.ctx);
    const effortOnly = JSON.parse(t.out.pop()!);
    assert.deepEqual(effortOnly.args, ['--session-id', effortOnly.sessionId, '--effort', 'low', '--name', 'sub-a1 title sub-a1']);
    t.ctx.config.claudeModel = 'opus';
    t.ctx.config.claudeEffort = 'default';
    await work(['sub-a1', '--json'], t.ctx);
    const modelOnly = JSON.parse(t.out.pop()!);
    assert.deepEqual(modelOnly.args, ['--session-id', modelOnly.sessionId, '--model', 'opus', '--name', 'sub-a1 title sub-a1']);
  } finally {
    t.done();
  }
});

test('work takes model and effort only from the config: no option or env reaches the command line', async () => {
  const t = workCtx([bead('sub-a1', { status: 'in_progress' })]);
  try {
    t.ctx.env.STRAND_CLAUDE_MODEL = 'sonnet';
    await assert.rejects(work(['sub-a1', '--model', 'sonnet'], t.ctx));
    await assert.rejects(work(['sub-a1', '--effort', 'low'], t.ctx));
    await work(['sub-a1', '--json'], t.ctx);
    assert.deepEqual(JSON.parse(t.out.pop()!).args.slice(2, 6), ['--model', 'opus', '--effort', 'high'], 'env is read by loadConfig only');
  } finally {
    t.done();
  }
});

test('work refuses --specify with --resume', async () => {
  const t = workCtx([bead('sub-a1', { status: 'in_progress' })]);
  try {
    await assert.rejects(work(['sub-a1', '--specify', '--resume', SID_A], t.ctx), /^Error: use --specify or --resume, not both$/);
    assert.deepEqual(t.calls, []);
  } finally {
    t.done();
  }
});

const SID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('work --session-id starts the new session under the given id, with or without --specify', async () => {
  const t = workCtx([bead('sub-a1', { status: 'in_progress' })]);
  try {
    const tracker = join(t.ws, 'tracker');
    await work(['sub-a1', '--session-id', SID_B, '--json'], t.ctx);
    const plain = JSON.parse(t.out.pop()!);
    assert.equal(plain.sessionId, SID_B);
    assert.deepEqual(plain.args, ['--session-id', SID_B, '--model', 'opus', '--effort', 'high', '--name', 'sub-a1 title sub-a1']);
    assert.deepEqual(liveSessions(tracker).map((s) => s.sessionId), [SID_B]);
    assert.deepEqual(readBinding(tracker, SID_B), { bead: 'sub-a1', lastStage: 'specify' });

    await work(['sub-a1', '--specify', '--session-id', SID_A, '--json'], t.ctx);
    const spec = JSON.parse(t.out.pop()!);
    assert.deepEqual(spec.args, ['--session-id', SID_A, '--model', 'opus', '--effort', 'high', '--name', 'sub-a1 title sub-a1', '/strand:work sub-a1']);
  } finally {
    t.done();
  }
});

test('work --session-id refuses a malformed id, an id already in the index, and --resume, before claiming', async () => {
  const t = workCtx([bead('sub-a1'), bead('sub-b2')]);
  try {
    for (const bad of ['../x', '-' + 'a'.repeat(35), SID_B.toUpperCase(), `${SID_B}x`, '']) {
      await assert.rejects(work(['sub-a1', `--session-id=${bad}`], t.ctx), new RegExp(`^Error: invalid session id`), bad);
    }
    recordStart(join(t.ws, 'tracker'), { sessionId: SID_B, beadId: 'sub-b2' });
    await assert.rejects(work(['sub-a1', '--session-id', SID_B], t.ctx), new RegExp(`^Error: session ${SID_B} already exists$`));
    await assert.rejects(work(['sub-a1', '--session-id', SID_A, '--resume', SID_A], t.ctx), /^Error: use --session-id or --resume, not both$/);
    assert.ok(!t.calls.some((c) => c.startsWith('claim') || c.startsWith('comment')));
  } finally {
    t.done();
  }
});

test('work --resume refuses a malformed id and a session of another bead, before claiming', async () => {
  const t = workCtx([bead('sub-a1'), bead('sub-b2')]);
  try {
    recordStart(join(t.ws, 'tracker'), { sessionId: SID_A, beadId: 'sub-b2' });
    await assert.rejects(work(['sub-a1', '--resume', '../x'], t.ctx), /^Error: session \.\.\/x is not a session of bead sub-a1$/);
    // A leading dash passes a loose 36-character check, so it must be refused even when recorded.
    const dashed = '-' + 'a'.repeat(35);
    recordStart(join(t.ws, 'tracker'), { sessionId: dashed, beadId: 'sub-a1' });
    await assert.rejects(work(['sub-a1', `--resume=${dashed}`], t.ctx), new RegExp(`^Error: session ${dashed} is not a session of bead sub-a1$`));
    await assert.rejects(work(['sub-a1', '--resume', SID_A], t.ctx), new RegExp(`^Error: session ${SID_A} is not a session of bead sub-a1$`));
    assert.ok(!t.calls.some((c) => c.startsWith('claim') || c.startsWith('comment')));
  } finally {
    t.done();
  }
});

test('work on a build bead at a WIP limit warns in warn mode', async () => {
  const t = workCtx([bead('sub-a1', { status: 'in_progress', notes: APPROVED }), bead('sub-r1', IN_REVIEW)], { wip: { build: 3, review: 1, mode: 'warn' } });
  try {
    assert.equal(await work(['sub-a1'], t.ctx), 0);
    assert.equal(t.out[0], 'warning: Review is at its WIP limit (1/1)');
  } finally {
    t.done();
  }
});

test('work on a build bead at a WIP limit throws in refuse mode and starts nothing', async () => {
  const t = workCtx([bead('sub-a1', { status: 'in_progress', notes: APPROVED }), bead('sub-r1', IN_REVIEW)], { wip: { build: 3, review: 1, mode: 'refuse' } });
  try {
    await assert.rejects(work(['sub-a1'], t.ctx), /^Error: Review is at its WIP limit \(1\/1\)$/);
    assert.deepEqual(t.calls, ['listAll']);
  } finally {
    t.done();
  }
});

test('work refuses a closed, unknown or repo-less bead', async () => {
  const t = workCtx([bead('sub-c1', { status: 'closed' }), bead('sub-n1', { labels: [] })]);
  try {
    await assert.rejects(work(['sub-c1'], t.ctx), /bead sub-c1 is closed/);
    await assert.rejects(work(['sub-zz'], t.ctx), /bead sub-zz not found/);
    await assert.rejects(work(['sub-n1'], t.ctx), /bead sub-n1 has no repo: label/);
    assert.deepEqual(t.calls.filter((c) => c !== 'listAll'), []);
  } finally {
    t.done();
  }
});
