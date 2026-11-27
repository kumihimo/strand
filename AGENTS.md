# Working on Strand (humans and coding agents)

This file is the entry point for anyone, a colleague or their coding agent, picking up development. Read it first, then `docs/roadmap.md` if you have the docs repo (below).

## The docs repo

The design docs (RFCs, ADRs, architecture, plans, roadmap, known issues) live in a separate, private repo. Maintainers clone it into this checkout's `docs/` folder, which this repo git-ignores, so the `docs/...` links below resolve on their machines and nowhere else. Without it, the code, tests and this file are the reference. Commit docs changes in `docs/` (its own git repo) and code changes here; one change can need a commit in each.

Commits in this repo use the project identity `The Strand Authors <authors@strand.invalid>`, set in the checkout's local git config. No personal name or email goes into this repo's files or history.

## What this repo is

An LLM-assisted SDLC system for one engineer, run the engineer's way ([RFC 0003](docs/rfc/0003-workflow-alignment.md)):

- **`strand` CLI + Claude Code plugin** (done): every task is a Beads bead, captured with a title, a type and a parent epic; before its spec is approved it gets a user story and acceptance criteria that name their checks. The engineer approves the spec (plan approval, the cockpit, or `/strand:approve`); Claude ticks each criterion with `(verified: ...)` evidence; the bead closes when its PR merges. Branch and PR are linked to the bead by labels, and bead ids never leave the PC. Six Claude Code hooks enforce the workflow and fail open. Stage is derived from facts; WIP limits warn by default; transcripts are archived per bead.
- **Cockpit** (done): a local web UI over the same data, in the Strand desktop app (Electron, [ADR 0022](docs/adr/0022-electron-window-cookie-handoff.md)): Brief, Board (six stages, sort, filter, drag to Specify) with bead detail, Criteria panel, Edit and a Claude Code terminal pane, Epics, Review queue, New bead, Approve spec and Request changes, open artefacts. One server per user ([RFC 0002](docs/rfc/0002-embedded-terminal.md), ADRs 0016, 0017 and 0022).

Design authority: [RFC 0001](docs/rfc/0001-sdlc-system.md) and [RFC 0003](docs/rfc/0003-workflow-alignment.md), plus the ADRs in [`docs/adr/`](docs/adr/). Current shape: [architecture doc](docs/architecture/cockpit-and-workflow.md). What's next: [roadmap](docs/roadmap.md). What's known to be imperfect: [known issues](docs/known-issues.md).

## Stack and layout

- **Node ≥ 24, TypeScript run directly by Node's type stripping**: no build step for server and CLI code ([ADR 0007](docs/adr/0007-node-type-stripping.md)). Erasable syntax only: no `enum`, `namespace`, parameter properties; imports use explicit `.ts` extensions; `import type` for types.
- **UI:** React 19 + Vite 8 in `ui/`, built to `dist/ui` (git-ignored). UI code may import *types* from `src/` and pure modules with no Node imports (e.g. `src/core/spec.ts`, `src/core/facts.ts`, `src/core/stage.ts`), never server code.
- **Runtime deps:** `@napi-rs/keyring`, `cross-spawn`, `fastify`, `@fastify/static`, `@fastify/websocket`, `node-pty` (pinned exactly at 1.1.0, see [ADR 0017](docs/adr/0017-terminals-run-only-sdlc-work.md)), `open`, `react`, `react-dom`, `@xterm/xterm`, `@xterm/addon-fit`. Dev only, beside the type packages, TypeScript and Vite: `ws` (a WebSocket client for the tests), `electron` (pinned exactly at 45.5.0, the desktop app's runtime, whose Node 24 runs `electron/main.ts` by type stripping) and `electron-builder` (pinned, packaging). Adding one needs a reason in the commit message.

```
src/core/        adapters (bd, but, gitea, gitfacts, exec, config, secrets, tools) + pure logic
                 (facts, stage, snapshot, wip, naming, spec, criteria-hash) + approve, create-bead,
                 edit-bead, release, binding, sessions, archive, audit, migrate, migrate-prefix, repos (workspace
                 repo list), folders (folder and repo-name comparison)
src/cli/         strand CLI: strand.ts dispatches to commands/<name>.ts -> main(args, ctx)
src/hooks/       Claude Code hooks: one entry file per event; parse.ts (shell parser), gate.ts (PreToolUse),
                 track.ts (PostToolUse), prompt.ts, session.ts, stop.ts, common.ts, runtime.ts (runHook)
src/cockpit/     Fastify server, auth, routes, actions (open), read model; pty.ts + ring.ts (terminal
                 manager), terminal-routes.ts (session routes, WebSocket), instance.ts (key file, probe),
                 desktop.ts (launches the desktop app)
electron/        the desktop app's main process: main.ts (starts strand cockpit --ipc, sets the cookie, the
                 window) + handoff.ts (pure, unit-tested: IPC message, cookie, navigation, quit rules)
ui/src/          React app: views/, components/ (TerminalPane, TerminalBoundary, EditBead, ViewControls, ...),
                 lib/ (pure, unit-tested: filter, terminal, detail, drawer, views, ...), useStoredView, useDrawers,
                 useUnloadGuard, api.ts
commands/, skills/strand-work/, hooks/hooks.json, .claude-plugin/   the Claude Code plugin
installer/       setup.ts (+ install.ps1 / install.sh wrappers)
scripts/seed-demo.ts   demo workspace for trying the cockpit
docs/            (git-ignored; the private docs repo) rfc/, adr/, architecture/, design/mockups/,
                 superpowers/plans/ (implementation plans), cutover-checklist.md
```

CLI commands (`node src/cli/strand.ts help`): `new`, `work` (`--specify`, `--resume <session-id>`, `--session-id <session-id>`), `approve`, `criteria accept`, `pr`, `none`, `audit`, `migrate`, `migrate-prefix` (`<old> <new> [--apply]`), `keep`, `brief`, `archive`, `cockpit` (`--port`, `--no-open`, `--window app|tab|none`).

## Commands

```bash
npm install
npm test            # node --test "test/**/*.test.ts"; integration tests skip when bd/but are absent
npm run typecheck   # tsc --noEmit
npm run build:ui    # ui -> dist/ui
npm run cockpit     # node src/cli/strand.ts cockpit
npm run dev:ui      # Vite dev server; proxies /api to a running cockpit (STRAND_COCKPIT_URL to override)
npm run app         # the desktop app from this checkout (electron .)
npm run package     # build the UI, then the unpacked desktop app in release/
claude plugin validate .
```

Try everything against throwaway data: `node scripts/seed-demo.ts <dir>`, then run the start command it prints (it sets `STRAND_WORKSPACE`, `STRAND_CONFIG_DIR` for the strand config folder, and `STRAND_COCKPIT_DRY_OPEN=1`; it leaves `APPDATA` and `XDG_CONFIG_HOME` alone, since cockpit terminals inherit them). **Never run `npm run setup` on a development machine**, except the one-off cutover of the machine the engineer chose to self-host on (RFC 0004 project 1). The engineer starts it. It writes the real strand config, creates the tracker and registers the plugin with Claude Code. **Never run `strand migrate --apply`** except as the engineer's cutover step.

On a PC where `BEADS_DIR` is set globally, run tests as `env -u BEADS_DIR -u BEADS_ACTOR npm test`, so nothing can reach the real database.

## Rules that keep this codebase healthy

1. **Cross-platform first.** The primary user is on Windows. No shell-specific logic in `src/`; paths via `node:path`; spawn with `shell: false` (`run()` in `src/core/exec.ts`, which uses `cross-spawn` for `.cmd` shims and kills the process tree on timeout). Anything touching paths, processes or file names needs a thought about Windows (drive letters, spaces, trailing dots, `:` streams, case-insensitivity).
2. **Tests never touch real state.** Sandbox `APPDATA`, `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `STRAND_WORKSPACE` and keep `STRAND_CONFIG_DIR` unset or sandboxed: copy the environment only through `baseEnv()` in `test/fixtures/env.ts`, which drops it with `BEADS_DIR` and `BEADS_ACTOR`, and spawn with an env of your own only through `runWith()` there, since `run()` merges over `process.env` (`test/env-guard.test.ts` checks both; see helpers in `test/cli.test.ts`); inject runners for npm/claude/plugin commands; never write `~/.claude`, the real strand config or the keychain. Every bd call sets `BEADS_DIR` from the config.
3. **TDD.** Write the failing test, see it fail, implement, see it pass.
4. **The cockpit stores nothing but the work queue** ([ADR 0005](docs/adr/0005-stateless-cockpit.md), [ADR 0023](docs/adr/0023-cockpit-keeps-a-work-queue.md): `queue.json` beside the config). Every other view derives from Beads, git, the session index, the artefacts folder and Gitea. Writes go through the same core functions the CLI uses (`approveSpec`, `requestChanges`, `createBead`, ...); never duplicate a rule between CLI, hooks and cockpit.
5. **Performance rule for Beads:** never call `bd show` per bead in a loop (~80 ms per call). Use one `bd list --all --limit 0 --json` and derive in memory (`src/core/snapshot.ts`). There are no gate calls.
6. **Security model is load-bearing** (cockpit): localhost only, per-launch key cookie, fail-closed Host/Origin allow-list, anti-framing headers, open-in-default-app via an allowlist only, served HTML/SVG with `CSP: sandbox`, the key file user-only ([ADR 0016](docs/adr/0016-single-instance-key-file.md)). Don't weaken any of it without an ADR.
7. **Hooks deny only by a rule in RFC 0003** ([ADR 0014](docs/adr/0014-hooks-enforce-and-fail-open.md)). On an error or a timeout a hook allows the action, writes to stderr and exits 0 (`runHook`). Hooks never call the forge. SessionEnd does no network or git work (1.5 s budget).
8. **The terminal endpoint runs only `strand work`** ([ADR 0017](docs/adr/0017-terminals-run-only-sdlc-work.md)): a validated bead id, mode and session id, in the bead's `repo:` folder. A new session's id is made by the server, never taken from a request. Never let anything else from a request reach a command line.

## How changes are made here

- **Docs-as-code:** significant change: an RFC in `docs/rfc/NNNN-<slug>.md` first; each architecturally significant decision: a short Nygard ADR in `docs/adr/` (never edit an accepted ADR, supersede it); keep `docs/architecture/` current in the same change.
- **Implementation plans** live in `docs/superpowers/plans/` (task-by-task, TDD, with Global Constraints and a Review Focus). The existing plans show the expected level of detail. Agents using the superpowers plugin: brainstorm, write the plan, execute it with subagent-driven development (fresh implementer and reviewer per task, final whole-branch review).
- **Git:** small logical commits; stage files explicitly (never `git add -A`); commit messages explain what and why. No bead id in a branch name, commit message, PR title or PR body. Don't push or open PRs unless the maintainer asks.

## Using the system on itself

The workflow of RFC 0003 applies to this repo too: a bead per task, filed with `strand new` (story, criteria with checks, parent epic); the spec format chosen per bead; the engineer approves the plan before any file edit; each criterion ticked with its evidence; a branch `<prefix>/<topic>` made with `but branch new`; the PR opened with `strand pr`; the bead closes on merge. The repo can keep its own Beads database for its backlog; `docs/roadmap.md` lists the work that should become beads. In this repo the strand plugin's GitButler workflow (`but branch new`, `but commit`) takes precedence over any personal plain-git rule. PRs on GitHub go through `gh` (ADR 0020).
