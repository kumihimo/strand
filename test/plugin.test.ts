import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** Tiny YAML front-matter parser: flat `key: value` lines between the first two `---` fences. */
function frontMatter(text: string): Record<string, string> | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return undefined;
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.trim();
  }
  return out;
}

const pluginPaths = (text: string) =>
  [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"'`\\]+)/g)].map((m) => m[1]!);

const skillFiles = () => readdirSync(join(root, 'skills/strand-work')).map((f) => `skills/strand-work/${f}`);
const commandFiles = () => readdirSync(join(root, 'commands')).map((f) => `commands/${f}`);

/** The command names the CLI dispatches, read from the COMMANDS table in src/cli/strand.ts. */
const cliCommands = () => [...read('src/cli/strand.ts').matchAll(/^\s+([a-z]+): \(\) => import\(/gm)].map((m) => m[1]!);

/** The sentence every skill file that touches git carries. */
const NO_IDS = 'No bead id in a branch name, commit message, PR title or PR body.';

test('plugin.json names the plugin strand', () => {
  const p = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(p.name, 'strand');
  assert.equal(p.version, '0.1.0');
  assert.ok(p.description);
  assert.deepEqual(Object.keys(p.author), ['name']);
});

test('hooks.json registers the three hooks and every file exists', () => {
  const h = JSON.parse(read('hooks/hooks.json')).hooks;
  const want = { SessionStart: 'session-start', UserPromptSubmit: 'user-prompt-submit', SessionEnd: 'session-end' };
  for (const [event, file] of Object.entries(want)) {
    const cmd = h[event][0].hooks[0];
    assert.equal(cmd.type, 'command');
    assert.equal(cmd.command, `node "\${CLAUDE_PLUGIN_ROOT}/src/hooks/${file}.ts"`);
    assert.equal(cmd.timeout, event === 'SessionEnd' ? 2 : 10);
    assert.ok(existsSync(join(root, 'src/hooks', `${file}.ts`)));
  }
});

test('hooks.json registers exactly the six events of RFC 0003 section 5, plus Notification for the needs-you mark', () => {
  const h = JSON.parse(read('hooks/hooks.json')).hooks;
  assert.deepEqual(Object.keys(h), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd', 'Notification']);
  assert.equal(h.Notification.length, 1);
  assert.equal(h.Notification[0].matcher, undefined);
  assert.deepEqual(h.Notification[0].hooks, [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/src/hooks/notification.ts"', timeout: 2 }]);
  assert.ok(existsSync(join(root, 'src/hooks/notification.ts')));
  const post = h.PostToolUse[0];
  assert.equal(post.hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/src/hooks/post-tool-use.ts"');
  assert.ok(existsSync(join(root, 'src/hooks/post-tool-use.ts')));
});

test('hooks.json registers the PreToolUse gate for edits, shell commands, plan approval and questions', () => {
  const entries = JSON.parse(read('hooks/hooks.json')).hooks.PreToolUse;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].matcher, 'Edit|Write|NotebookEdit|Bash|PowerShell|ExitPlanMode|AskUserQuestion');
  const cmd = entries[0].hooks[0];
  assert.equal(cmd.type, 'command');
  assert.equal(cmd.command, 'node "${CLAUDE_PLUGIN_ROOT}/src/hooks/pre-tool-use.ts"');
  assert.equal(cmd.timeout, 5);
  assert.ok(existsSync(join(root, 'src/hooks/pre-tool-use.ts')));
});

test('hooks.json registers the Stop hook with a 20 s timeout', () => {
  const entries = JSON.parse(read('hooks/hooks.json')).hooks.Stop;
  assert.equal(entries.length, 1);
  const cmd = entries[0].hooks[0];
  assert.equal(cmd.type, 'command');
  assert.equal(cmd.command, 'node "${CLAUDE_PLUGIN_ROOT}/src/hooks/stop-entry.ts"');
  assert.equal(cmd.timeout, 20);
  assert.ok(existsSync(join(root, 'src/hooks/stop-entry.ts')));
});

test('every commands/*.md and SKILL.md has a description', () => {
  const files = readdirSync(join(root, 'commands')).map((f) => `commands/${f}`);
  assert.deepEqual(files.sort(), ['commands/approve.md', 'commands/brief.md', 'commands/new.md', 'commands/work.md']);
  for (const f of [...files, 'skills/strand-work/SKILL.md']) {
    assert.ok(frontMatter(read(f))?.description, `${f} needs description front matter`);
  }
  assert.equal(frontMatter(read('skills/strand-work/SKILL.md'))?.name, 'strand-work');
});

test('every ${CLAUDE_PLUGIN_ROOT} path in commands and hooks exists', () => {
  const texts = [read('hooks/hooks.json'), ...readdirSync(join(root, 'commands')).map((f) => read(`commands/${f}`))];
  const paths = texts.flatMap(pluginPaths);
  assert.ok(paths.length >= 5);
  for (const p of paths) assert.ok(existsSync(join(root, p)), `${p} is missing`);
});

test('every command file names a CLI command that exists', () => {
  const cli = cliCommands();
  assert.ok(cli.includes('new') && cli.includes('criteria'), 'COMMANDS table not found in src/cli/strand.ts');
  for (const f of commandFiles()) {
    const name = f.slice('commands/'.length, -'.md'.length);
    assert.ok(cli.includes(name), `${f}: no CLI command ${name}`);
  }
  for (const f of [...commandFiles(), ...skillFiles()]) {
    const text = read(f);
    for (const m of text.matchAll(/strand\.ts"? ([a-z]+)/g)) assert.ok(cli.includes(m[1]!), `${f}: unknown CLI command ${m[1]}`);
    for (const m of text.matchAll(/\$STRAND ([a-z]+)/g)) assert.ok(cli.includes(m[1]!), `${f}: unknown CLI command ${m[1]}`);
  }
});

test('no skill or command names the old gates or bead-id branches', () => {
  for (const f of [...commandFiles(), ...skillFiles()]) {
    const text = read(f);
    for (const word of ['gate1', 'gate2', '<bead-id>-<slug>']) assert.ok(!text.includes(word), `${f} contains ${word}`);
  }
});

test('commands call the CLI; work does not nest claude; approve confirms first', () => {
  assert.match(read('commands/new.md'), /strand\.ts" new/);
  assert.match(read('commands/brief.md'), /strand\.ts" brief/);
  const work = read('commands/work.md');
  assert.match(work, /strand-work/);
  // The id is optional: with none, the hook works the bound bead or asks for one.
  assert.equal(frontMatter(work)?.['argument-hint'], '[bead-id]');
  assert.match(work, /Work bead `\$ARGUMENTS` \(or, when no id was given, the bead named in the injected `Strand bead` context\)/);
  assert.match(work, /not launch|do not launch|never launch/i);
  const approve = read('commands/approve.md');
  assert.match(approve, /strand\.ts" approve/);
  assert.match(approve, /confirm/i);
  assert.equal(frontMatter(approve)?.['disable-model-invocation'], 'true');
  assert.doesNotMatch(approve, /--gate/);
});

test('SKILL.md routes to stage files and covers artefacts', () => {
  const s = read('skills/strand-work/SKILL.md');
  for (const f of ['specify.md', 'build.md', 'verify.md', 'close.md']) {
    assert.ok(s.includes(f));
    assert.ok(existsSync(join(root, 'skills/strand-work', f)));
  }
  assert.match(s, /<tracker>\/artefacts\/<bead-id>\/scratch\//);
  assert.match(s, /\$STRAND keep/);
});

test('specify.md covers formats, risk matrix, legal, criteria and approval', () => {
  const s = read('skills/strand-work/specify.md');
  for (const f of ['checklist', 'gwt', 'ears', 'repro', 'document', 'brief']) assert.ok(s.includes(f), f);
  assert.match(s, /likelihood × impact/);
  for (const w of ['policy', 'technology', 'people']) assert.ok(s.includes(w), w);
  assert.match(s, /UK GDPR lawful basis/);
  assert.match(s, /automated decisions/);
  assert.match(s, /bias/);
  assert.match(s, /docs\/adr\//);
  assert.match(s, /--design-file/);
  assert.match(s, /--acceptance/);
  assert.match(s, /\(check: /);
  assert.match(s, /plan mode/i);
  assert.match(s, /Bead: <id>/);
  assert.match(s, /Approve spec/);
  // The Specify session saves the spec to the bead and stops; it does not enter plan mode itself.
  assert.match(s, /Do not enter plan mode on your own/);
  assert.match(s, /\/strand:approve <id>/);
  assert.match(s, /Stage changed: specify -> build/);
  assert.doesNotMatch(s, /In this session: enter plan mode/);
  assert.match(s, /\$STRAND criteria accept/);
  assert.match(s, /docs\/rfc\//);
});

test('filing is capture first: criteria optional at creation, the spec rules checked at approval', () => {
  const filing = read('skills/strand-work/filing.md');
  const nw = read('commands/new.md');
  for (const [name, text] of [['filing.md', filing], ['new.md', nw]] as const) {
    assert.match(text, /optional/i, name);
    assert.match(text, /at approval/i, name);
    assert.match(text, /--context/, name);
    assert.ok(text.includes('(check: <command>)'), name);
  }
  assert.match(read('skills/strand-work/specify.md'), /refuses? .*(spec rules|approval rules)|(spec rules|approval rules).*refus/i);
  assert.ok(!/needs at least one acceptance criterion|no acceptance criteria yet/.test(read('commands/approve.md')));
});

test('build.md and verify.md use only the repo Test command', () => {
  for (const f of ['build.md', 'verify.md']) {
    const s = read(`skills/strand-work/${f}`);
    assert.match(s, /`Test command`/, f);
    assert.match(s, /CLAUDE\.md/, f);
    assert.match(s, /ask the engineer/i, f);
    // ADR 0018: a server starts only through the repo's Run command, and browser checks are hands off.
    assert.match(s, /own (test )?runner/, f);
    assert.match(s, /`Run command`/, f);
    assert.match(s, /Playwright/, f);
  }
  const checks = read('skills/strand-work/verify.md');
  assert.match(checks, /## Browser checks/);
  assert.match(checks, /Never ask the engineer to restart a server/);
  assert.match(read('skills/strand-work/SKILL.md'), /Browser checks are hands off \(ADR 0018\)/);
  const b = read('skills/strand-work/build.md');
  assert.match(b, /Commit with:/);
  for (const w of ['red-green-refactor', 'input validation', 'design by contract', 'assertions', 'fail-safe defaults', 'metamorphic', 'discovered-from'])
    assert.ok(b.toLowerCase().includes(w.toLowerCase()), w);
  assert.match(b, /but branch new/);
  const v = read('skills/strand-work/verify.md');
  assert.match(v, /\$STRAND pr <id> --title/);
  assert.match(v, /--body-file/);
  assert.match(v, /\(verified: <command> passed\)/);
  assert.match(v, /\(verified: user confirmed\)/);
});

test('close.md asks once, proposes rule, test or skill, and never closes the bead', () => {
  const s = read('skills/strand-work/close.md');
  assert.match(s, /what did you correct/i);
  assert.match(s, /CLAUDE\.md/);
  assert.match(s, /test/);
  assert.match(s, /skill/);
  assert.match(s, /docs\/adr\//);
  assert.match(s, /never blocks/i);
  assert.doesNotMatch(s, /bd [^\n`]*close </);
  assert.match(read('skills/strand-work/SKILL.md'), /\| review \|[^\n]*close\.md/);
  assert.match(read('skills/strand-work/SKILL.md'), /\| done \|[^\n]*nothing to do/);
});

test('git-conventions.md states the label naming and is referenced from SKILL.md', () => {
  const s = read('skills/strand-work/git-conventions.md');
  assert.match(s, /but branch new <prefix>\/<topic>/);
  assert.match(s, /but branch new -A /);
  assert.match(s, /but reword <full-name> -m <new-name>/);
  assert.match(s, /but commit --branch /);
  assert.match(s, /branch:<name>/);
  assert.match(s, /but agent setup/);
  assert.ok(read('skills/strand-work/SKILL.md').includes('git-conventions.md'));
  assert.ok(!existsSync(join(root, 'rules')));
});

test('every skill file that touches git keeps bead ids out of git', () => {
  for (const f of ['SKILL.md', 'build.md', 'verify.md', 'close.md', 'git-conventions.md']) {
    assert.ok(read(`skills/strand-work/${f}`).includes(NO_IDS), `${f} must say: ${NO_IDS}`);
  }
});

test('no skill or command runs a bare strand CLI command', () => {
  const files = [...commandFiles(), ...skillFiles()];
  for (const f of files) {
    for (const line of read(f).split(/\r?\n/)) {
      assert.ok(!/(^|[\s`(])strand (new|work|approve|criteria|pr|none|audit|keep|brief|archive|cockpit)\b/.test(line), `${f}: bare strand in "${line}"`);
    }
  }
  assert.ok(read('skills/strand-work/SKILL.md').includes('$STRAND` = `node "${CLAUDE_PLUGIN_ROOT}/src/cli/strand.ts"`'));
  assert.match(read('skills/strand-work/SKILL.md'), /never type `\$STRAND` itself/);
  assert.match(read('skills/strand-work/build.md'), /Build blocked:/);
  assert.match(read('commands/work.md'), /Build blocked:/);
});

test('SKILL.md routing table rows are exactly the Stage values', () => {
  const rows = [...read('skills/strand-work/SKILL.md').matchAll(/^\| (\w+) \|/gm)].map((m) => m[1]).filter((r) => r !== 'Stage');
  assert.deepEqual(rows, ['backlog', 'specify', 'build', 'verify', 'review', 'done']);
  const stage = read('src/core/stage.ts');
  const union = /export type Stage = ([^;]+);/.exec(stage)![1]!.split('|').map((x) => x.trim().replace(/'/g, ''));
  assert.deepEqual(rows, union);
});

test('verify opens the PR, review never opens another; build files discovered work through strand new', () => {
  const s = read('skills/strand-work/SKILL.md');
  assert.match(s, /\| verify \|[^\n]*verify\.md/);
  assert.match(s, /\| review \|[^\n]*Never open a second PR/);
  assert.match(s, /\| specify \|[^\n]*specify\.md/);
  const b = read('skills/strand-work/build.md');
  assert.match(b, /\$STRAND new/);
  assert.match(b, /--type discovered-from/);
});

test('no skill uses but commit -b; every bd command in skills and commands runs against the tracker', () => {
  for (const f of skillFiles()) assert.ok(!read(f).includes('but commit -b'), f);
  for (const f of [...commandFiles(), ...skillFiles()]) {
    for (const line of read(f).split(/\r?\n/)) {
      // `bd` then a word: it must be `bd -C "<tracker dir>" <subcommand>`, the form of the hook's Tracker: line.
      for (const m of line.matchAll(/\bbd (?=[a-z-])/g)) {
        assert.ok(line.startsWith('bd -C "<tracker dir>" ', m.index), `${f}: bd without -C "<tracker dir>" in "${line}"`);
      }
    }
  }
  assert.match(read('skills/strand-work/SKILL.md'), /`-C "<tracker dir>"` straight after `bd`/);
});
