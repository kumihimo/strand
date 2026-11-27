import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireTool, ToolMissingError, compareVersions, MINIMUM_VERSIONS } from '../src/core/tools.ts';

test('requireTool git resolves a version', async () => {
  const v = await requireTool('git', '2.0.0');
  assert.match(v, /^\d+\.\d+\.\d+$/);
});

test('requireTool rejects when too old', async () => {
  await assert.rejects(requireTool('git', '999.0.0'), (e: unknown) => {
    assert.ok(e instanceof ToolMissingError);
    assert.equal(e.tool, 'git');
    assert.match(e.message, /999\.0\.0/);
    assert.match(e.message, /git/);
    return true;
  });
});

test('requireTool rejects when the executable path is missing', async () => {
  await assert.rejects(
    requireTool('bd', '0.0.1', { path: '/nonexistent/strand-bd' }),
    (e: unknown) => e instanceof ToolMissingError && e.tool === 'bd',
  );
});

test('compareVersions is numeric per component', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('1.9.0', '1.10.0') < 0);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
});

test('MINIMUM_VERSIONS names but 0.23.5', () => {
  assert.equal(MINIMUM_VERSIONS.but, '0.23.5');
});
