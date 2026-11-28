import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The Dependabot config and the auto-merge workflow are read as text: no YAML parser is a dependency.
// Each check looks at the block of one `- package-ecosystem:` entry, or at the workflow file.

const root = join(import.meta.dirname, '..');
const configPath = join(root, '.github', 'dependabot.yml');
const workflowPath = join(root, '.github', 'workflows', 'dependabot-automerge.yml');

function read(path: string): string {
  assert.ok(existsSync(path), `${path} is missing`);
  // Comment lines are dropped, so a check never matches the explanation of a setting.
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n').replace(/^\s*#.*\n/gm, '');
}

function ecosystem(name: string): string {
  const blocks = read(configPath).split(/\n(?=  - package-ecosystem:)/);
  const block = blocks.find((b) => new RegExp(`^  - package-ecosystem: "?${name}"?\\s*$`, 'm').test(b));
  assert.ok(block, `no ${name} entry in dependabot.yml`);
  return block;
}

function cooldown(block: string, key: string): number {
  const m = block.match(new RegExp(`^\\s+${key}: (\\d+)\\s*$`, 'm'));
  assert.ok(m, `no ${key} in the cooldown`);
  return Number(m[1]);
}

function group(block: string, name: string): string {
  const m = block.match(new RegExp(`^      ${name}:\\n((?:        .*\\n?|\\s*\\n)+)`, 'm'));
  assert.ok(m, `no group ${name}`);
  return m[1];
}

function types(groupBody: string): string[] {
  const m = groupBody.match(/update-types:\n((?:\s+- .*\n?)+)/);
  if (!m) return [];
  return [...m[1].matchAll(/- "?([a-z]+)"?/g)].map((x) => x[1]).sort();
}

test('the config is version 2, at the repo root, on a schedule', () => {
  const text = read(configPath);
  assert.match(text, /^version: 2\s*$/m);
  for (const name of ['npm', 'github-actions']) {
    const b = ecosystem(name);
    assert.match(b, /^    directory: "?\/"?\s*$/m);
    assert.match(b, /^      interval: "?(daily|weekly)"?\s*$/m);
  }
});

for (const name of ['npm', 'github-actions']) {
  test(`${name} updates wait 3 days for a patch, 14 for a minor and 30 for a major`, () => {
    const b = ecosystem(name);
    assert.equal(cooldown(b, 'semver-patch-days'), 3);
    assert.equal(cooldown(b, 'semver-minor-days'), 14);
    assert.equal(cooldown(b, 'semver-major-days'), 30);
    assert.ok(cooldown(b, 'default-days') >= 3, 'non-semver updates wait at least as long as a patch');
  });
}

test('npm minor and patch updates are one group, and majors another', () => {
  const b = ecosystem('npm');
  const minorPatch = group(b, 'npm-minor-patch');
  assert.match(minorPatch, /patterns:\n\s+- "\*"/);
  assert.deepEqual(types(minorPatch), ['minor', 'patch']);
  const major = group(b, 'npm-major');
  assert.match(major, /patterns:\n\s+- "\*"/);
  assert.deepEqual(types(major), ['major']);
});

test('GitHub Actions updates are one group of every update type', () => {
  const g = group(ecosystem('github-actions'), 'actions');
  assert.match(g, /patterns:\n\s+- "\*"/);
  assert.deepEqual(types(g), [], 'no update-types filter, so every type is in the group');
});

test('node-pty is never updated, and electron only within its major', () => {
  const b = ecosystem('npm');
  const ignore = b.match(/^    ignore:\n((?:      .*\n?)+)/m);
  assert.ok(ignore, 'no ignore list');
  const entries = ignore[1].split(/\n(?=      - dependency-name:)/);
  const pty = entries.find((e) => /dependency-name: "?node-pty"?/.test(e));
  assert.ok(pty, 'node-pty is not ignored');
  assert.doesNotMatch(pty, /update-types/, 'node-pty is ignored for every update type');
  const electron = entries.find((e) => /dependency-name: "?electron"?\s*$/m.test(e));
  assert.ok(electron, 'electron is not ignored');
  assert.match(electron, /update-types:\s*\[?\s*\n?\s*-?\s*"version-update:semver-major"/);
  assert.doesNotMatch(electron, /semver-(minor|patch)/);
});

test('the workflow enables rebase auto-merge on the pull request', () => {
  const w = read(workflowPath);
  assert.match(w, /^on:\n  pull_request:/m);
  assert.doesNotMatch(w, /pull_request_target/, 'forks must get a read-only token');
  assert.match(w, /gh pr merge --auto --rebase "\$PR_URL"/);
});

test('the auto-merge job runs only for pull requests Dependabot opened', () => {
  const w = read(workflowPath);
  assert.match(w, /^    if: github\.event\.pull_request\.user\.login == 'dependabot\[bot\]'\s*$/m);
  assert.doesNotMatch(w, /github\.actor/, 'a re-run changes the actor; the PR author is the guard');
});

test('the workflow has least permissions, no third-party action and passes the PR URL by env', () => {
  const w = read(workflowPath);
  const perms = [...w.matchAll(/^\s+(contents|pull-requests|[a-z-]+): (read|write|none)\s*$/gm)].map((m) => `${m[1]}: ${m[2]}`);
  assert.deepEqual(perms.sort(), ['contents: write', 'pull-requests: write']);
  assert.doesNotMatch(w, /write-all|read-all/);
  assert.doesNotMatch(w, /^\s+(- )?uses:/m, 'no actions at all');
  assert.match(w, /^\s+PR_URL: \$\{\{ github\.event\.pull_request\.html_url \}\}\s*$/m);
  assert.match(w, /^\s+GH_TOKEN: \$\{\{ github\.token \}\}\s*$/m);
  const runs = [...w.matchAll(/^\s+run: (.*)$/gm)].map((m) => m[1]);
  for (const r of runs) assert.doesNotMatch(r, /\$\{\{/, 'no expression inside a run script');
});
