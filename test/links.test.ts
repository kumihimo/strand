import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalUrl } from '../src/core/links.ts';

test('externalUrl accepts http and https URLs and returns them normalised', () => {
  assert.equal(externalUrl('https://github.com/o/r/pull/1'), 'https://github.com/o/r/pull/1');
  assert.equal(externalUrl('http://example.com'), 'http://example.com/');
  assert.equal(externalUrl('HTTPS://Example.com/a?b=c#d'), 'https://example.com/a?b=c#d');
});

test('externalUrl refuses every other scheme', () => {
  for (const u of [
    'file:///etc/passwd',
    'file://C:/Windows/System32/cmd.exe',
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'vscode://file/x',
    'ms-settings:',
    'mailto:a@b.c',
    'ftp://example.com/',
    'blob:https://example.com/x',
  ]) {
    assert.equal(externalUrl(u), undefined, u);
  }
});

test('externalUrl refuses URLs with credentials, garbage and non-strings', () => {
  assert.equal(externalUrl('https://user:pw@example.com/'), undefined);
  assert.equal(externalUrl('https://user@example.com/'), undefined);
  assert.equal(externalUrl('not a url'), undefined);
  assert.equal(externalUrl(''), undefined);
  assert.equal(externalUrl('https://'), undefined);
  assert.equal(externalUrl(undefined as unknown as string), undefined);
  assert.equal(externalUrl(42 as unknown as string), undefined);
  assert.equal(externalUrl(`https://example.com/${'a'.repeat(9000)}`), undefined);
});
