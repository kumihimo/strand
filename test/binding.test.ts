import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { bindingsFor, clearBinding, clearHandover, patchBinding, readBinding, readHandover, writeBinding, writeHandover } from '../src/core/binding.ts';

function tracker() {
  return mkdtempSync(join(tmpdir(), 'strand-binding-'));
}

test('a binding round-trips and leaves no temp file behind', () => {
  const dir = tracker();
  try {
    writeBinding(dir, 's1', { bead: 't-1', approved: true, nagged: 'abc' });
    assert.deepEqual(readBinding(dir, 's1'), { bead: 't-1', approved: true, nagged: 'abc' });
    assert.deepEqual(readdirSync(join(dir, '.strand', 'bindings')), ['s1.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an absent or malformed binding reads as an empty object', () => {
  const dir = tracker();
  try {
    assert.deepEqual(readBinding(dir, 'nope'), {});
    mkdirSync(join(dir, '.strand', 'bindings'), { recursive: true });
    writeFileSync(join(dir, '.strand', 'bindings', 'bad.json'), '{not json');
    assert.deepEqual(readBinding(dir, 'bad'), {});
    writeFileSync(join(dir, '.strand', 'bindings', 'arr.json'), '[1]');
    assert.deepEqual(readBinding(dir, 'arr'), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patchBinding merges and returns the result; clearBinding removes the file', () => {
  const dir = tracker();
  try {
    patchBinding(dir, 's1', { bead: 't-1' });
    const next = patchBinding(dir, 's1', { dirty: true });
    assert.deepEqual(next, { bead: 't-1', dirty: true });
    assert.deepEqual(readBinding(dir, 's1'), { bead: 't-1', dirty: true });
    clearBinding(dir, 's1');
    assert.equal(existsSync(join(dir, '.strand', 'bindings', 's1.json')), false);
    clearBinding(dir, 's1');
    assert.deepEqual(readBinding(dir, 's1'), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bindingsFor finds every session bound to a bead', () => {
  const dir = tracker();
  try {
    writeBinding(dir, 'a', { bead: 't-1' });
    writeBinding(dir, 'b', { bead: 't-1', approved: true });
    writeBinding(dir, 'c', { bead: 't-2' });
    writeBinding(dir, 'd', { none: true });
    const found = bindingsFor(dir, 't-1').sort((x, y) => x.sessionId.localeCompare(y.sessionId));
    assert.deepEqual(found, [
      { sessionId: 'a', binding: { bead: 't-1' } },
      { sessionId: 'b', binding: { bead: 't-1', approved: true } },
    ]);
    assert.deepEqual(bindingsFor(join(dir, 'missing'), 't-1'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unsafe session ids are refused', () => {
  const dir = tracker();
  try {
    assert.throws(() => writeBinding(dir, '../x', {}), /invalid session id/);
    assert.throws(() => readBinding(dir, 'a/b'), /invalid session id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const WRITER = join(import.meta.dirname, 'fixtures', 'binding-writer.ts');

/** Run the writer helper in `n` processes at once; resolve with each one's exit code and stderr. */
function writers(dir: string, kind: 'binding' | 'handover', n: number, count: number): Promise<{ code: number | null; err: string }[]> {
  return Promise.all(
    Array.from(
      { length: n },
      () =>
        new Promise<{ code: number | null; err: string }>((resolve) => {
          const p = spawn(process.execPath, [WRITER, dir, kind, String(count)], { stdio: ['ignore', 'ignore', 'pipe'] });
          let err = '';
          p.stderr.on('data', (d) => (err += String(d)));
          p.on('close', (code) => resolve({ code, err }));
        }),
    ),
  );
}

test('two processes writing one binding at once both succeed and leave no temp file', async () => {
  const dir = tracker();
  try {
    const results = await writers(dir, 'binding', 2, 200);
    assert.deepEqual(results, [{ code: 0, err: '' }, { code: 0, err: '' }]);
    assert.deepEqual(readdirSync(join(dir, '.strand', 'bindings')), ['s1.json']);
    assert.match(readBinding(dir, 's1').bead ?? '', /^t-\d+-199$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two processes writing one handover at once both succeed and leave no temp file', async () => {
  const dir = tracker();
  try {
    const results = await writers(dir, 'handover', 2, 200);
    assert.deepEqual(results, [{ code: 0, err: '' }, { code: 0, err: '' }]);
    assert.equal(readdirSync(join(dir, '.strand', 'bindings')).filter((f) => f.endsWith('.tmp')).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handovers are kept per folder and are never listed as bindings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strand-handover-'));
  try {
    writeHandover(dir, { cwd: String.raw`C:\dev\a`, bead: 't-1', at: '2026-11-23T12:00:00.000Z' });
    writeHandover(dir, { cwd: String.raw`C:\dev\b`, bead: 't-1', at: '2026-11-23T12:00:01.000Z' });
    assert.equal(readHandover(dir, String.raw`c:\DEV\a`)?.at, '2026-11-23T12:00:00.000Z');
    assert.equal(readHandover(dir, 'C:/dev/b')?.at, '2026-11-23T12:00:01.000Z');
    assert.equal(readHandover(dir, String.raw`C:\dev\c`), undefined);
    assert.deepEqual(bindingsFor(dir, 't-1'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a binding only in the old .sdlc/bindings is read; a patch writes .strand and a clear removes both', () => {
  const dir = tracker();
  try {
    const old = join(dir, '.sdlc', 'bindings');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 's1.json'), JSON.stringify({ bead: 't-1', approved: true }));
    assert.deepEqual(readBinding(dir, 's1'), { bead: 't-1', approved: true });
    assert.deepEqual(bindingsFor(dir, 't-1').map((x) => x.sessionId), ['s1']);
    patchBinding(dir, 's1', { dirty: true });
    assert.deepEqual(readdirSync(join(dir, '.strand', 'bindings')), ['s1.json']);
    assert.ok(existsSync(join(old, 's1.json')), 'the old file is kept');
    assert.deepEqual(readBinding(dir, 's1'), { bead: 't-1', approved: true, dirty: true });
    assert.deepEqual(bindingsFor(dir, 't-1').map((x) => x.binding.dirty), [true], 'each session once, .strand wins');
    clearBinding(dir, 's1');
    assert.deepEqual(readBinding(dir, 's1'), {}, 'a cleared binding does not come back from .sdlc');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a handover only in the old .sdlc/bindings is read, and a clear removes it', () => {
  const dir = tracker();
  try {
    writeHandover(dir, { cwd: '/w/repo', bead: 't-1', at: '2026-11-01T00:00:00.000Z' });
    const [file] = readdirSync(join(dir, '.strand', 'bindings'));
    mkdirSync(join(dir, '.sdlc', 'bindings'), { recursive: true });
    writeFileSync(join(dir, '.sdlc', 'bindings', file!), readFileSync(join(dir, '.strand', 'bindings', file!)));
    rmSync(join(dir, '.strand'), { recursive: true });
    assert.equal(readHandover(dir, '/w/repo')?.bead, 't-1');
    clearHandover(dir, '/w/repo');
    assert.equal(readHandover(dir, '/w/repo'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
