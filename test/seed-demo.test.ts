import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseEnv } from './fixtures/env.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { run } from '../src/core/exec.ts';
import { buildCtx } from '../src/cli/ctx.ts';
import { Model } from '../src/cockpit/model.ts';
import { seedDemo, startCommands, tinyPng } from '../scripts/seed-demo.ts';

const hasBd = await run('bd', ['--version']).then((r) => r.code === 0, () => false);

test('tinyPng is a well-formed PNG', () => {
  const png = tinyPng(4, 3);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 4);
  assert.equal(png.readUInt32BE(20), 3);
  const idatLen = png.readUInt32BE(33);
  assert.equal(png.subarray(37, 41).toString('ascii'), 'IDAT');
  assert.equal(inflateSync(png.subarray(41, 41 + idatLen)).length, (4 * 3 + 1) * 3);
  assert.equal(png.subarray(-8, -4).toString('ascii'), 'IEND');
});

test('startCommands quotes paths for POSIX shells and PowerShell', () => {
  const c = startCommands(join('/w', "it's here"));
  const p = join('/w', "it's here");
  assert.ok(c.posix.startsWith(`STRAND_WORKSPACE='${p.replace(/'/g, "'\\''")}' `), c.posix);
  assert.ok(c.posix.includes(" STRAND_COCKPIT_DRY_OPEN='1' node src/cli/strand.ts cockpit --port 0 --no-open"), c.posix);
  assert.ok(c.powershell.startsWith(`$env:STRAND_WORKSPACE='${p.replace(/'/g, "''")}'; `), c.powershell);
  // The config folder moves through STRAND_CONFIG_DIR, so the terminals keep the real APPDATA and XDG_CONFIG_HOME.
  assert.ok(c.powershell.includes(`$env:STRAND_CONFIG_DIR='${join(p, '.config').replace(/'/g, "''")}'`), c.powershell);
  assert.ok(c.posix.includes(` STRAND_CONFIG_DIR='${join(p, '.config').replace(/'/g, "'\\''")}' `), c.posix);
  for (const s of [c.posix, c.powershell]) assert.ok(!/APPDATA|XDG_CONFIG_HOME/.test(s), s);
  assert.ok(c.powershell.endsWith("; node src/cli/strand.ts cockpit --port 0 --no-open"), c.powershell);
  // The demo's sessions load the plugin from this checkout, so its commands and hooks work without setup.
  const root = join(import.meta.dirname, '..');
  assert.ok(c.posix.includes(` STRAND_PLUGIN_DIR='${root.replace(/'/g, "'\\''")}' `), c.posix);
  assert.ok(c.powershell.includes(`$env:STRAND_PLUGIN_DIR='${root.replace(/'/g, "''")}'; `), c.powershell);
});

test('seed-demo builds a workspace whose board shows the expected stages', { skip: hasBd ? false : 'bd not on PATH' }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'strand-seed-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const ids = await seedDemo(ws);
  await assert.rejects(seedDemo(ws), /already exists/);

  const cfg = join(ws, '.config');
  const env: NodeJS.ProcessEnv = { ...baseEnv(), STRAND_WORKSPACE: ws, XDG_CONFIG_HOME: cfg, APPDATA: cfg, HOME: cfg, USERPROFILE: cfg };
  delete env.STRAND_GITEA_URL;
  delete env.STRAND_GITEA_TOKEN;
  const model = new Model(buildCtx(env));
  const board = await model.board();
  const stage = Object.fromEntries(board.cards.map((c) => [c.id, c.stage]));
  assert.deepEqual(stage, {
    [ids.bug]: 'backlog',
    [ids.blocked]: 'backlog',
    [ids.decision]: 'backlog',
    [ids.specify]: 'specify',
    [ids.build]: 'build',
    [ids.verify]: 'verify',
    [ids.review]: 'review',
    [ids.chore]: 'done',
  });
  assert.equal(board.wip.build, 1);
  assert.equal(board.wip.review, 1);
  const byId = new Map(board.cards.map((c) => [c.id, c]));
  assert.equal(byId.get(ids.blocked)!.held, true);
  assert.deepEqual(byId.get(ids.blocked)!.blockedBy, [ids.build]);
  assert.equal(byId.get(ids.build)!.live, true);
  assert.equal(byId.get(ids.specify)!.parent, ids.epic);
  assert.equal(byId.get(ids.specify)!.awaitingApproval, true);
  assert.equal(byId.get(ids.build)!.awaitingApproval, false);
  assert.match(byId.get(ids.verify)!.branch ?? '', /^demo\//);
  assert.equal(byId.get(ids.verify)!.pr, undefined);
  assert.deepEqual(byId.get(ids.review)!.pr && { n: byId.get(ids.review)!.pr!.number }, { n: 12 });
  assert.equal(byId.get(ids.review)!.ciUnknown, true);

  const d = await model.detail(ids.specify);
  assert.ok(d.criteria.length >= 1 && d.criteria.every((c) => !c.ticked && c.check));
  assert.equal(d.planApprovedAt, undefined);
  assert.ok(d.description?.startsWith('As a '));
  assert.ok(d.design?.includes('Scenario'));
  assert.deepEqual(d.relations.spawned, [ids.bug]);
  assert.equal(d.comments.length, 2);
  assert.deepEqual(d.artefacts.kept.map((f) => f.kind).sort(), ['html', 'image']);
  assert.equal(d.artefacts.scratch.length, 1);
  assert.equal(d.artefacts.transcripts.length, 1);
  const b = await model.detail(ids.build);
  assert.ok(b.planApprovedAt);
  assert.ok(b.criteria.some((c) => !c.ticked));
  assert.deepEqual(b.relations.related, [ids.decision]);
  assert.deepEqual(b.relations.blocks, [ids.blocked]);
  for (const id of [ids.verify, ids.review]) {
    const v = await model.detail(id);
    assert.ok(v.criteria.length > 0 && v.criteria.every((c) => c.ticked && c.evidence), id);
  }
  assert.ok(!('gates' in b));
});
