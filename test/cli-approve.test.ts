import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { baseEnv, runWith } from './fixtures/env.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/core/exec.ts';
import { Beads } from '../src/core/bd.ts';
import { buildCtx } from '../src/cli/ctx.ts';
import { criteriaBaseline, planApprovedAt } from '../src/core/facts.ts';
import { criteriaHash } from '../src/core/criteria-hash.ts';
import { runCli } from '../src/cli/strand.ts';

const hasBd = await run('bd', ['--version']).then((r) => r.code === 0, () => false);
const skip = hasBd ? false : 'bd not on PATH';

let ws = '';
let tracker = '';
let beads: Beads;
let epic = '';
let env: NodeJS.ProcessEnv = {};

const STORY = 'As a dev, I want a thing, so that it works.';
const CRIT = '- [ ] It works (check: make test)\n- [ ] It fails safely (check: make test)';

before(async () => {
  ws = mkdtempSync(join(tmpdir(), 'strand-cli-approve-'));
  tracker = join(ws, 'tracker');
  const cfg = join(ws, 'config');
  mkdirSync(tracker);
  mkdirSync(cfg);
  // Every config location points into the sandbox on all three OSes.
  env = { ...baseEnv(), STRAND_WORKSPACE: ws, XDG_CONFIG_HOME: cfg, APPDATA: cfg, HOME: cfg, USERPROFILE: cfg, STRAND_DRY_RUN_CLAUDE: '1' };
  delete env.STRAND_GITEA_URL;
  delete env.STRAND_GITEA_TOKEN;
  delete env.BEADS_DIR;
  delete env.BEADS_ACTOR;
  if (!hasBd) return;
  await run('git', ['init', '-q'], { cwd: tracker });
  await run('git', ['config', 'user.name', 'T'], { cwd: tracker });
  await run('git', ['config', 'user.email', 't@example.com'], { cwd: tracker });
  await run('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: tracker });
  const init = await runWith('bd', ['init', '--prefix', 't'], { cwd: tracker, env: { ...baseEnv(), BD_NON_INTERACTIVE: '1' } });
  assert.equal(init.code, 0, init.stderr);
  beads = new Beads(tracker);
  epic = (await beads.create({ title: 'Epic', type: 'epic' })).id;
});

after(() => {
  if (ws) rmSync(ws, { recursive: true, force: true });
});

async function cli(args: string[], cwd = ws) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx = buildCtx(env, { out: (s) => out.push(s), err: (s) => err.push(s) });
  ctx.cwd = cwd;
  const code = await runCli(args, ctx);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('strand gate1 is an unknown command and is gone from the usage text', async () => {
  const r = await cli(['gate1', 't-1']);
  assert.equal(r.code, 1);
  assert.equal(r.err, 'error: unknown command gate1');
  const help = await cli(['help']);
  assert.ok(!help.out.includes('gate1'));
  assert.ok(help.out.includes('criteria accept'));
});

test('strand new without a parent or with a long title names the problem', async () => {
  const noParent = await cli(['new', 'Do a thing', '--type', 'task']);
  assert.equal(noParent.code, 1);
  assert.equal(noParent.err, 'error: needs a parent epic');
  const long = await cli(['new', 'x'.repeat(61), '--type', 'task', '--parent', 't-epic']);
  assert.equal(long.err, 'error: title is over 60 characters');
  const orphan = await cli(['new', 'Do a thing', '--type', 'task', '--parent', 't-epic', '--context', 'docs']);
  assert.equal(orphan.err, 'error: a bead with context folders needs a primary repo');
});

test('strand help lists each command once', async () => {
  const help = (await cli(['help'])).out;
  for (const name of ['new', 'work', 'approve', 'criteria', 'pr', 'none', 'audit', 'keep', 'brief', 'archive', 'cockpit', 'migrate']) {
    const lines = help.split('\n').filter((l) => new RegExp(`^  ${name}( |$)`).test(l));
    assert.equal(lines.length, 1, name);
  }
});

test('strand new help shows the story and criterion forms as suggestions', async () => {
  const help = await cli(['help']);
  assert.ok(help.out.includes('As a ..., I want ..., so that ...'), help.out);
  assert.ok(help.out.includes('- [ ] <text> (check: <command>)'), help.out);
  assert.ok(help.out.includes('--context <folder>'), help.out);
});

test('strand new with a title only creates the bead', { skip }, async () => {
  const r = await cli(['new', 'Just a title', '--type', 'task', '--parent', epic]);
  assert.equal(r.code, 0, r.err);
  const b = await beads.show(r.out.trim());
  assert.equal(b.title, 'Just a title');
  assert.equal(b.description ?? '', '');
  assert.equal(b.acceptance_criteria ?? '', '');
});

test('strand new keeps free-text criteria, and writes the repo and context labels', { skip }, async () => {
  const r = await cli(['new', 'Loose', '--type', 'task', '--parent', epic, '--acceptance', 'it should be quick', '--repo', 'app', '--context', 'docs', '--context', 'lib', '--context', 'app']);
  assert.equal(r.code, 0, r.err);
  const b = await beads.show(r.out.trim());
  assert.equal(b.acceptance_criteria, 'it should be quick');
  assert.deepEqual([...b.labels].sort(), ['context:docs', 'context:lib', 'repo:app']);
});

test('strand new rejects both an inline value and a file for the same field', async () => {
  const f = join(ws, 'accept.md');
  writeFileSync(f, CRIT);
  const r = await cli(['new', 'Do a thing', '--type', 'task', '--acceptance', CRIT, '--acceptance-file', f]);
  assert.equal(r.err, 'error: pass --acceptance or --acceptance-file, not both');
  const missing = await cli(['new', 'Do a thing', '--type', 'task', '--acceptance-file', join(ws, 'nope.md')]);
  assert.match(missing.err, /^error: cannot read --acceptance-file /);
});

test('strand new with every field creates the bead with its criteria', { skip }, async () => {
  const r = await cli(['new', 'Do a thing', '--type', 'task', '--description', STORY, '--acceptance', CRIT, '--parent', epic]);
  assert.equal(r.code, 0, r.err);
  const b = await beads.show(r.out.trim());
  assert.equal(b.description, STORY);
  assert.equal(b.acceptance_criteria, CRIT);
  assert.equal(b.issue_type, 'task');
});

test('strand new reads the description and criteria from files', { skip }, async () => {
  const d = join(ws, 'story.md');
  const a = join(ws, 'criteria.md');
  writeFileSync(d, `${STORY}\r\n\r\nMore context.\r\n`);
  writeFileSync(a, `${CRIT}\r\n`);
  const r = await cli(['new', 'From files', '--type', 'feature', '--description-file', d, '--acceptance-file', a, '--parent', epic]);
  assert.equal(r.code, 0, r.err);
  const b = await beads.show(r.out.trim());
  assert.equal(b.description, `${STORY}\n\nMore context.`);
  assert.equal(b.acceptance_criteria, CRIT);
});

test('strand approve writes the two notes; a second approve fails', { skip }, async () => {
  const b = await beads.create({ title: 'To approve', type: 'task', parent: epic, description: STORY, acceptance: CRIT });
  const r = await cli(['approve', b.id]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `approved ${b.id}`);
  const notes = (await beads.show(b.id)).notes;
  assert.ok(planApprovedAt(notes));
  assert.equal(criteriaBaseline(notes), criteriaHash(CRIT));
  const again = await cli(['approve', b.id]);
  assert.equal(again.code, 1);
  assert.equal(again.err, `error: bead ${b.id} is already approved`);
});

test('strand approve refuses a bead that does not meet the spec rules, listing what is missing', { skip }, async () => {
  const bare = await beads.create({ title: 'Bare', type: 'task', parent: epic });
  const r = await cli(['approve', bare.id]);
  assert.equal(r.code, 1);
  assert.equal(r.err, 'error: description must open "As a ..., I want ..., so that ..."; needs at least one acceptance criterion');
  assert.equal(planApprovedAt((await beads.show(bare.id)).notes), undefined);
  const loose = await beads.create({ title: 'Loose', type: 'task', parent: epic, description: STORY, acceptance: 'it works\n- [ ] it is fast' });
  const l = await cli(['approve', loose.id]);
  assert.equal(l.err, 'error: 2 acceptance lines are not in the form "- [ ] <text> (check: <command>)"');
  assert.equal(planApprovedAt((await beads.show(loose.id)).notes), undefined);
});

test('strand approve prints the WIP warning in warn mode', { skip }, async () => {
  const b = await beads.create({ title: 'Warned', type: 'task', parent: epic, description: STORY, acceptance: CRIT });
  const out: string[] = [];
  const ctx = buildCtx(env, { out: (s) => out.push(s), err: () => {} });
  ctx.config.wip = { build: 0, review: 3, mode: 'warn' };
  assert.equal(await runCli(['approve', b.id], ctx), 0);
  assert.equal(out[0], `approved ${b.id}`);
  assert.match(out[1]!, /^warning: Build is at its WIP limit \(\d+\/0\)$/);
  assert.equal(out.length, 2);
});

test('strand criteria accept moves the baseline to the edited criteria', { skip }, async () => {
  const b = await beads.create({ title: 'To edit', type: 'task', parent: epic, description: STORY, acceptance: CRIT });
  assert.equal((await cli(['approve', b.id])).code, 0);
  const edited = '- [ ] It works well (check: make test)';
  await beads.setAcceptance(b.id, edited);
  assert.notEqual(criteriaBaseline((await beads.show(b.id)).notes), criteriaHash(edited));
  const r = await cli(['criteria', 'accept', b.id]);
  assert.equal(r.code, 0, r.err);
  assert.equal(criteriaBaseline((await beads.show(b.id)).notes), criteriaHash(edited));
});

test('strand criteria needs the accept subcommand and an id', async () => {
  assert.equal((await cli(['criteria'])).err, 'error: usage: strand criteria accept <bead-id>');
  assert.equal((await cli(['criteria', 'accept'])).err, 'error: usage: strand criteria accept <bead-id>');
});
