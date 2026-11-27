/**
 * Seed a demo workspace for checking the cockpit by hand: `node scripts/seed-demo.ts <dir>`.
 * Creates `<dir>/tracker` (Beads, prefix `demo`), `<dir>/orders-service` (one commit) and artefacts.
 * Refuses to run twice into the same folder.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, gzipSync } from 'node:zlib';
import { Beads } from '../src/core/bd.ts';
import { createBead } from '../src/core/create-bead.ts';
import { criteriaHash } from '../src/core/criteria-hash.ts';
import { run } from '../src/core/exec.ts';
import { recordEnd, recordStart } from '../src/core/sessions.ts';

const CUSTOM_TYPES = 'dpia,eula-review,deck,supplier-spec,security-review,rfc,incident,retro';
const ENV = { BD_NON_INTERACTIVE: '1' };
/** The strand checkout, which is also the plugin folder. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');

/** One bead per stage: bug (backlog), specify, build, verify, review, chore (done), plus a blocked bead and a decision. */
export type DemoIds = {
  epic: string;
  bug: string;
  blocked: string;
  decision: string;
  specify: string;
  build: string;
  verify: string;
  review: string;
  chore: string;
};

async function must(cmd: string, args: string[], cwd: string): Promise<string> {
  const r = await run(cmd, args, { cwd, env: ENV });
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** A small valid RGB PNG (a colour gradient), built from bytes. */
export function tinyPng(w = 24, h = 16): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour, deflate, no filter, no interlace
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) raw.set([122, Math.round((x / w) * 255), Math.round((y / h) * 255)], row + 1 + x * 3);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const MOCKUP = `<!doctype html><meta charset="utf-8"><title>Export dialog</title>
<style>body{font:14px system-ui;margin:24px;background:#f6f7f9}.d{background:#fff;border:1px solid #ccd;border-radius:8px;padding:16px;width:320px}</style>
<div class="d"><h3>Export orders</h3><label>Format <select><option>CSV</option></select></label><p><button>Export</button></p></div>`;

const SPEC_GWT = `Feature: export orders as CSV

Scenario: export the current filter
  Given 3 orders match the filter
  When I click Export
  Then a CSV with a header and 3 rows downloads

Scenario: empty result
  Given no orders match
  When I click Export
  Then the CSV holds only the header`;

/** Seed the demo workspace into dir; returns the bead ids. */
export async function seedDemo(dir: string): Promise<DemoIds> {
  const ws = resolve(dir);
  const tracker = join(ws, 'tracker');
  if (existsSync(join(tracker, '.beads'))) throw new Error(`${tracker}/.beads already exists — pick an empty folder`);
  const repo = join(ws, 'orders-service');
  mkdirSync(tracker, { recursive: true });
  mkdirSync(repo, { recursive: true });

  await must('git', ['init', '-q'], tracker);
  await must('bd', ['init', '--prefix', 'demo'], tracker);
  try {
    return await populate(tracker, repo);
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\nThe workspace is half-seeded: delete ${ws} and rerun.`);
  }
}

async function populate(tracker: string, repo: string): Promise<DemoIds> {
  await must('bd', ['config', 'set', 'types.custom', CUSTOM_TYPES], tracker);

  await must('git', ['init', '-q'], repo);
  writeFileSync(join(repo, 'README.md'), '# orders-service\n\nDemo repo for the Strand.\n');
  await must('git', ['add', 'README.md'], repo);
  await must('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', 'commit', '-q', '-m', 'initial commit'], repo);

  const bd = new Beads(tracker);
  const ctx = { beads: bd };
  const repoName = 'orders-service';
  const story = (want: string, why: string) => `As a buyer, I want ${want}, so that ${why}.`;
  const todo = (text: string, check: string) => `- [ ] ${text} (check: ${check})`;
  const done = (text: string, check: string, evidence: string) => `- [x] ${text} (check: ${check}) (verified: ${evidence})`;
  const plan = async (id: string, criteria: string) => {
    await bd.note(id, `plan-approved ${new Date().toISOString()}`);
    await bd.note(id, `criteria ${criteriaHash(criteria)}`);
  };

  const epic = (
    await createBead(ctx, {
      title: 'Orders export v2',
      type: 'epic',
      priority: 1,
      acceptance: todo('Every child bead is closed', 'bd list --parent'),
    })
  ).id;
  const child = async (title: string, type: string, priority: number, want: string, why: string, acceptance?: string) =>
    (await createBead(ctx, { title, type, priority, repo: type === 'decision' ? undefined : repoName, parent: epic, description: story(want, why), acceptance })).id;

  // Backlog: open, not claimed.
  const bug = await child('CSV header misses the currency column', 'bug', 0, 'the currency in the CSV header', 'I can read amounts without guessing', todo('Header lists currency', 'npm test -- export'));
  const decision = await child('ADR: cap export p95 at 2 s', 'decision', 2, 'a stated export time limit', 'we can test against it');
  const blocked = await child('Add export audit log', 'task', 2, 'a log of every export', 'I can answer who exported what', todo('Each export writes one log row', 'npm test -- audit'));

  // Specify: claimed, spec and criteria written, no approval yet.
  const specifyCriteria = [
    todo('Export downloads a CSV of the current filter', 'npm test -- export-current'),
    todo('An empty result gives a header-only CSV', 'npm test -- export-empty'),
  ].join('\n');
  const specify = await child('Export orders as CSV', 'feature', 1, 'to export the orders I filtered', 'I can sort them in a spreadsheet', specifyCriteria);
  await bd.setDesign(specify, SPEC_GWT);
  await bd.claim(specify);

  // Build: plan approved, criteria still open, a live session.
  const buildCriteria = [todo('Memory stays under 200 MB for 1M rows', 'npm run bench:export'), todo('Rows stream in chunks', 'npm test -- stream')].join('\n');
  const build = await child('Stream large exports', 'feature', 2, 'large exports to stream', 'the server does not run out of memory', buildCriteria);
  await bd.setDesign(build, 'Given an export of 1M rows\nWhen it runs\nThen memory stays under 200 MB and rows stream in chunks');
  await bd.claim(build);
  await plan(build, buildCriteria);

  // Verify: every criterion ticked with evidence, a branch, no PR yet.
  const verifyCriteria = [
    done('Pages hold at most 100 orders', 'npm test -- paging', 'npm test -- paging: 6 passed'),
    done('The last page says it is the last', 'npm test -- last-page', 'npm test -- last-page: 2 passed'),
  ].join('\n');
  const verify = await child('Page the orders API', 'task', 2, 'the orders API to return pages', 'big accounts load quickly', todo('placeholder', 'true'));
  await bd.setAcceptance(verify, verifyCriteria);
  await bd.claim(verify);
  await plan(verify, verifyCriteria);
  await bd.addLabel(verify, 'branch:demo/page-orders-api');

  // Review: verified, branch and an open PR (no forge in the demo, so CI is unknown).
  const reviewCriteria = done('The export format is documented', 'npm run docs:check', 'npm run docs:check: ok');
  const review = await child('Document the export format', 'task', 3, 'the export format written down', 'partners can read our files', todo('placeholder', 'true'));
  await bd.setAcceptance(review, reviewCriteria);
  await bd.claim(review);
  await plan(review, reviewCriteria);
  await bd.addLabel(review, 'branch:demo/export-format-docs');
  await bd.addLabel(review, 'pr:demo/orders-service#12');

  // Done: closed.
  const chore = await child('Bump Node to 24', 'chore', 3, 'Node 24', 'we stay on a supported runtime');

  // On hold: blocked status and a blocks dependency.
  await must('bd', ['update', blocked, '--status', 'blocked'], tracker);

  // Relations: blocks, discovered-from, related.
  await must('bd', ['dep', 'add', blocked, build], tracker);
  await must('bd', ['dep', 'add', bug, specify, '--type', 'discovered-from'], tracker);
  await must('bd', ['dep', 'add', decision, build, '--type', 'related'], tracker);
  await bd.setDesign(decision, 'Context: large exports time out.\nDecision: cap p95 at 2 s and stream beyond that.\nConsequences: clients must handle chunked downloads.');

  await bd.close(chore, 'done in demo seed');

  await bd.comment(specify, 'Should the CSV use ; for EU locales?');
  await bd.comment(specify, 'Keep , and quote fields. Excel handles it.');
  await bd.comment(build, 'Started on the streaming writer.');

  // Artefacts: kept files, a scratch iteration and an archived transcript.
  const art = join(tracker, 'artefacts', specify);
  mkdirSync(join(art, 'scratch'), { recursive: true });
  mkdirSync(join(art, 'sessions'), { recursive: true });
  writeFileSync(join(art, 'export-dialog.html'), MOCKUP);
  writeFileSync(join(art, 'screenshot.png'), tinyPng());
  writeFileSync(join(art, 'scratch', 'export-dialog-v1.html'), MOCKUP.replace('Export orders', 'Export orders (v1)'));
  const sid = 'demo-session-1';
  const transcript = `${JSON.stringify({ type: 'user', message: 'Write the export spec' })}\n${JSON.stringify({ type: 'assistant', message: 'Drafted two scenarios.' })}\n`;
  writeFileSync(join(art, 'sessions', `${sid}.jsonl.gz`), gzipSync(transcript));
  recordStart(tracker, { sessionId: sid, beadId: specify });
  recordEnd(tracker, { sessionId: sid });
  // A live session puts the green dot on the Build card.
  recordStart(tracker, { sessionId: 'demo-session-2', beadId: build });

  return { epic, bug, blocked, decision, specify, build, verify, review, chore };
}

const CLI = 'node src/cli/strand.ts cockpit --port 0 --no-open';

/** POSIX shell: single quotes, with embedded ' written as '\''. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** PowerShell: single quotes, with embedded ' doubled. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

function startEnv(ws: string): [string, string][] {
  return [
    ['STRAND_WORKSPACE', ws],
    // Moves only the strand config: a fake APPDATA or XDG_CONFIG_HOME would reach Claude Code in the terminals.
    ['STRAND_CONFIG_DIR', join(ws, '.config')],
    // Sessions load the plugin from this checkout, so the slash commands and hooks work without setup.
    ['STRAND_PLUGIN_DIR', REPO_ROOT],
    ['STRAND_COCKPIT_DRY_OPEN', '1'],
  ];
}

/** The command that starts the cockpit against ws, for a POSIX shell and for Windows PowerShell. */
export function startCommands(ws: string): { posix: string; powershell: string } {
  const env = startEnv(ws);
  return {
    posix: `${env.map(([k, v]) => `${k}=${shQuote(v)}`).join(' ')} ${CLI}`,
    powershell: `${env.map(([k, v]) => `$env:${k}=${psQuote(v)}`).join('; ')}; ${CLI}`,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('usage: node scripts/seed-demo.ts <dir>\n');
    process.exit(2);
  }
  try {
    const ids = await seedDemo(dir);
    const ws = resolve(dir);
    const cmd = startCommands(ws);
    process.stdout.write(
      `Demo workspace: ${ws}\nBeads: ${Object.entries(ids).map(([k, v]) => `${k}=${v}`).join(' ')}\n\n` +
        `Start the cockpit from the repo root:\n  POSIX shell:  ${cmd.posix}\n  PowerShell:   ${cmd.powershell}\n`,
    );
  } catch (e) {
    process.stderr.write(`seed-demo: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
