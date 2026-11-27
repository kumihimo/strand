import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256sums, writeSha256sums } from '../scripts/checksums.ts';
import { baseEnv, runWith } from './fixtures/env.ts';

const script = join(import.meta.dirname, '..', 'scripts', 'checksums.ts');
const hex = (s: string) => createHash('sha256').update(s).digest('hex');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'strand-sums-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('sha256sums lists each file as "<hex>  <basename>", LF, sorted by name', () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.dir, 'sub'));
    writeFileSync(join(s.dir, 'b.deb'), 'bee');
    writeFileSync(join(s.dir, 'sub', 'a.exe'), 'ay');
    const out = sha256sums([join(s.dir, 'b.deb'), join(s.dir, 'sub', 'a.exe')]);
    assert.equal(out, `${hex('ay')}  a.exe\n${hex('bee')}  b.deb\n`);
  } finally {
    s.done();
  }
});

test('sha256sums rejects no files, a missing file, a directory, a duplicate name and a name sha256sum would escape', () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.dir, 'x'));
    mkdirSync(join(s.dir, 'y'));
    writeFileSync(join(s.dir, 'x', 'same'), '1');
    writeFileSync(join(s.dir, 'y', 'same'), '2');
    writeFileSync(join(s.dir, 'back\\slash'), '3');
    assert.throws(() => sha256sums([]), /no files/);
    assert.throws(() => sha256sums([join(s.dir, 'nope')]), /not a file/);
    assert.throws(() => sha256sums([join(s.dir, 'x')]), /not a file/);
    assert.throws(() => sha256sums([join(s.dir, 'x', 'same'), join(s.dir, 'y', 'same')]), /twice/);
    if (process.platform !== 'win32') {
      assert.throws(() => sha256sums([join(s.dir, 'back\\slash')]), /cannot be listed/);
    }
  } finally {
    s.done();
  }
});

test('the script writes SHA256SUMS that sha256sum -c accepts', async () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.dir, 'Strand-Setup-1.0.0.exe'), 'win');
    writeFileSync(join(s.dir, 'strand_1.0.0_amd64.deb'), 'deb');
    const out = join(s.dir, 'SHA256SUMS');
    const r = await runWith(process.execPath, [script, '--out', out, join(s.dir, 'strand_1.0.0_amd64.deb'), join(s.dir, 'Strand-Setup-1.0.0.exe')], { env: baseEnv() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(out, 'utf8'), `${hex('win')}  Strand-Setup-1.0.0.exe\n${hex('deb')}  strand_1.0.0_amd64.deb\n`);
    const has = spawnSync('sha256sum', ['--version'], { shell: false });
    if (has.status === 0) {
      const check = spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: s.dir, shell: false, encoding: 'utf8' });
      assert.equal(check.status, 0, check.stdout + check.stderr);
      assert.match(check.stdout, /Strand-Setup-1\.0\.0\.exe: OK/);
    }
  } finally {
    s.done();
  }
});

test('the script refuses to run without --out or without files, and writes nothing', async () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.dir, 'f'), 'x');
    const a = await runWith(process.execPath, [script, join(s.dir, 'f')], { env: baseEnv() });
    assert.notEqual(a.code, 0);
    assert.match(a.stderr, /usage/);
    const b = await runWith(process.execPath, [script, '--out', join(s.dir, 'SUMS')], { env: baseEnv() });
    assert.notEqual(b.code, 0);
    assert.throws(() => readFileSync(join(s.dir, 'SUMS')));
  } finally {
    s.done();
  }
});

test('writeSha256sums writes the file it returns', () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.dir, 'f'), 'x');
    const out = join(s.dir, 'SHA256SUMS');
    const text = writeSha256sums(out, [join(s.dir, 'f')]);
    assert.equal(readFileSync(out, 'utf8'), text);
  } finally {
    s.done();
  }
});
