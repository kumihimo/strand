import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queueFile, readQueue, writeQueue } from '../src/core/queue-store.ts';

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'strand-queue-')), 'strand', 'queue.json');
}

test('queueFile sits beside config.json', () => {
  assert.equal(queueFile({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Roaming\\strand\\queue.json');
  assert.equal(queueFile({}, 'linux', '/home/u'), '/home/u/.config/strand/queue.json');
  assert.equal(queueFile({ STRAND_CONFIG_DIR: '/tmp/cfg' }, 'linux', '/home/u'), '/tmp/cfg/queue.json');
});

test('AT-3 a written queue reads back with the same ids in the same order', () => {
  const file = tempFile();
  writeQueue(file, ['b-2', 'a-1', 'c-3']);
  assert.deepEqual(readQueue(file), ['b-2', 'a-1', 'c-3']);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, ids: ['b-2', 'a-1', 'c-3'] });
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  writeQueue(file, []);
  assert.deepEqual(readQueue(file), []);
});

test('AT-3 a missing file reads as empty, silently', () => {
  const warnings: string[] = [];
  assert.deepEqual(readQueue(tempFile(), (w) => warnings.push(w)), []);
  assert.deepEqual(warnings, []);
});

test('AT-3 a corrupt file reads as empty, with a warning, and does not throw', () => {
  const file = tempFile();
  mkdirSync(join(file, '..'), { recursive: true });
  for (const text of ['{not json', '[]', '{"version":2,"ids":[]}', '{"version":1,"ids":"a"}', '{"version":1,"ids":["ok","--help"]}', '{"version":1,"ids":["a","a"]}']) {
    writeFileSync(file, text);
    const warnings: string[] = [];
    assert.deepEqual(readQueue(file, (w) => warnings.push(w)), [], text);
    assert.equal(warnings.length, 1, text);
    assert.match(warnings[0], /queue/);
  }
});

test('writeQueue refuses ids that are not bead ids', () => {
  assert.throws(() => writeQueue(tempFile(), ['--help']), /bead id/);
});
