import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseEnv } from './fixtures/env.ts';

const DIR = import.meta.dirname;

/** Each test file, by name, under test/ (subfolders included). */
function testFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const name = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...testFiles(join(dir, d.name), name));
    else if (d.name.endsWith('.test.ts')) out.push(name);
  }
  return out;
}

test('no test copies process.env except through baseEnv()', () => {
  // A spread, or the whole object handed on as an env. Reads and writes of one variable are fine.
  const copy = /\.\.\.\s*process\.env\b|\benv\s*:\s*process\.env\b(?!\.)/;
  const offenders = testFiles(DIR).filter((f) => copy.test(readFileSync(join(DIR, f), 'utf8')));
  assert.deepEqual(offenders, [], 'use baseEnv() from test/fixtures/env.ts');
});

test('no test passes an env to run(): it merges over process.env, so use runWith()', () => {
  // A call of run with an env option before the end of its statement. exec.test.ts tests run itself; this
  // file names it in its text.
  const call = /\brun\([^;]*?\benv\b/;
  const skip = ['exec.test.ts', 'env-guard.test.ts'];
  const offenders = testFiles(DIR).filter((f) => !skip.includes(f) && call.test(readFileSync(join(DIR, f), 'utf8')));
  assert.deepEqual(offenders, [], 'use runWith() from test/fixtures/env.ts');
});

test('every spawn or spawnSync of bd or of the strand CLI in a test passes an env', () => {
  // The whole statement, from the call to its end; a child with no env inherits the shell's BEADS_DIR.
  const call = /\bspawn(?:Sync)?\(\s*(?:'bd'|"bd"|process\.execPath\s*,\s*\[\s*STRAND\b)[^;]*/g;
  const offenders: string[] = [];
  for (const f of testFiles(DIR)) {
    if (f === 'env-guard.test.ts') continue;
    for (const m of readFileSync(join(DIR, f), 'utf8').matchAll(call)) {
      if (!/\benv\b/.test(m[0])) offenders.push(`${f}: ${m[0].split('\n')[0]}`);
    }
  }
  assert.deepEqual(offenders, [], 'pass env: { ...baseEnv(), ... } (and BEADS_DIR for bd)');
});

test('baseEnv drops STRAND_CONFIG_DIR and every SDLC_* in any case and keeps the rest', () => {
  const keys = ['STRAND_CONFIG_DIR', 'SDLC_CONFIG_DIR', 'sdlc_workspace', 'STRAND_GUARD_PROBE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.STRAND_CONFIG_DIR = 'C:/demo/.config';
    process.env.SDLC_CONFIG_DIR = 'C:/demo/.config';
    process.env.sdlc_workspace = 'C:/real';
    process.env.STRAND_GUARD_PROBE = 'kept';
    const env = baseEnv();
    assert.equal(Object.keys(env).some((k) => ['STRAND_CONFIG_DIR', 'BEADS_DIR', 'BEADS_ACTOR'].includes(k.toUpperCase())), false);
    assert.equal(Object.keys(env).some((k) => k.toUpperCase().startsWith('SDLC_')), false);
    assert.equal(env.STRAND_GUARD_PROBE, 'kept');
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
