import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/core/exec.ts';
import { ToolMissingError } from '../src/core/tools.ts';

test('run returns stdout and code 0', async () => {
  const r = await run(process.execPath, ['-e', "process.stdout.write('ok')"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'ok');
});

test('run resolves with non-zero code and stderr', async () => {
  const r = await run(process.execPath, ['-e', "process.stderr.write('bad');process.exit(3)"]);
  assert.equal(r.code, 3);
  assert.equal(r.stderr, 'bad');
});

test('run passes input and env', async () => {
  const r = await run(
    process.execPath,
    ['-e', "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s+process.env.STRAND_X))"],
    { input: 'in-', env: { STRAND_X: 'x' } },
  );
  assert.equal(r.stdout, 'in-x');
});

test('run works with a cwd containing a space', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strand-exec-'));
  const dir = path.join(base, 'with space');
  fs.mkdirSync(dir);
  try {
    const r = await run(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: dir });
    assert.equal(r.code, 0);
    assert.equal(fs.realpathSync(r.stdout), fs.realpathSync(dir));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('run on a missing command rejects with ToolMissingError', async () => {
  const cmd = 'strand-no-such-command-xyz';
  await assert.rejects(run(cmd, []), (e: unknown) => {
    assert.ok(e instanceof ToolMissingError);
    assert.equal(e.name, 'ToolMissingError');
    assert.equal(e.tool, cmd);
    assert.match(e.hint, /Install strand-no-such-command-xyz and make sure it is on PATH/);
    return true;
  });
});

test('run with a missing cwd rejects with a plain Error naming the directory', async () => {
  const missing = path.join(os.tmpdir(), 'strand-missing-dir-xyz');
  await assert.rejects(run(process.execPath, ['-e', '0'], { cwd: missing }), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.ok(!(e instanceof ToolMissingError));
    assert.match(e.message, /working directory not found/);
    assert.ok(e.message.includes(missing));
    return true;
  });
});

test('run rejects and kills the child when timeoutMs elapses', async () => {
  const started = Date.now();
  await assert.rejects(
    run(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 300 }),
    (err: Error) => {
      assert.equal(err.message, `${process.execPath} did not answer within 0.3 s`);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5000);
});

test('run with timeoutMs resolves normally when the command is quick', async () => {
  const r = await run(process.execPath, ['-e', "process.stdout.write('ok')"], { timeoutMs: 10000 });
  assert.equal(r.stdout, 'ok');
});

test('a timed-out child and its own child are both gone', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strand-tree-'));
  const parentPidFile = path.join(base, 'parent.pid');
  const childPidFile = path.join(base, 'child.pid');
  const grandchild = `require('fs').writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid)); setTimeout(()=>{}, 60000)`;
  const parent =
    `const {spawn}=require('child_process');` +
    `require('fs').writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid));` +
    `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:'ignore',detached:${process.platform === 'win32'}});` +
    `setTimeout(()=>{}, 60000)`;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await assert.rejects(run(process.execPath, ['-e', parent], { timeoutMs: 1500 }), /did not answer/);
    const parentPid = Number(fs.readFileSync(parentPidFile, 'utf8'));
    const childPid = Number(fs.readFileSync(childPidFile, 'utf8'));
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && (alive(parentPid) || alive(childPid))) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(alive(parentPid), false, 'child is still running');
    assert.equal(alive(childPid), false, 'grandchild is still running');
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('run with exactEnv gives the child only that environment', async () => {
  process.env.STRAND_EXEC_LEAK_PROBE = 'leaked';
  try {
    const r = await run(process.execPath, ['-e', "process.stdout.write(String(process.env.STRAND_EXEC_LEAK_PROBE)+'|'+process.env.STRAND_X)"], {
      exactEnv: { STRAND_X: 'x' },
    });
    assert.equal(r.stdout, 'undefined|x');
  } finally {
    delete process.env.STRAND_EXEC_LEAK_PROBE;
  }
});

test('run calls onOutput with stdout and stderr as they arrive', async () => {
  const seen: string[] = [];
  const r = await run(process.execPath, ['-e', "process.stdout.write('a');process.stderr.write('b')"], { onOutput: (c) => seen.push(c) });
  assert.equal(r.code, 0);
  assert.deepEqual(seen.join('').split('').sort(), ['a', 'b']);
});
