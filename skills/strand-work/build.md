# Build

Goal: implement exactly the approved spec, test first.

## Branch

- Work that changes a repo: make the bead's branch at the start of Build, before the first file edit: `but branch new <prefix>/<topic>` (`<prefix>` is the engineer's branch prefix, shown in the `Branch: none yet` line; you pick the topic). The hook labels the bead `branch:<name>`, and the `Commit with:` line then names it.
- Never tick the last criterion while the bead has repo changes and no branch. The Stop hook closes a verified bead that has no branch or PR at once, and a closed bead cannot commit: the next `but commit` is refused.
- No branch is right only for work that changes no repo file, for example a bead whose deliverable is the bead text itself or a file under the tracker's `artefacts/` folder.
- One bead has one branch. Commit only to it. See `git-conventions.md` for stacking and renaming.
- No bead id in a branch name, commit message, PR title or PR body.

## Tests

Run tests only via the `Test command` documented in the repo's `CLAUDE.md` (ADR 0008). Never start your own test runner. If `CLAUDE.md` has no `Test command`, ask the engineer for one and stop until you have it. Do not guess one.

To see a change working in the browser, do it yourself: bring the stack up with the repo's `Run command` and drive the page with Playwright ("Browser checks" in `verify.md`, ADR 0018). Do not ask the engineer to restart a server or open a page. The `Run command` is the only way you start a server.

## Cycle

Follow red-green-refactor (superpowers:test-driven-development):

1. Red: write one failing test per acceptance criterion (AT-n, EARS ID, checklist item, or repro step). Run it and watch it fail for the right reason.
2. Green: write the least code that passes. Run it.
3. Refactor with tests green. Repeat for the next criterion.

When a criterion's check passes, tick it with the evidence (see `verify.md`). After a turn with edits, the Stop hook asks you once to check the criteria: tick the ones whose check passed, or say which remain.

## Defensive checklist (every module boundary)

- Input validation: check type, range, length and format of everything that crosses the boundary; reject, do not repair.
- Design by contract: state preconditions, postconditions and invariants; enforce them.
- Assertions for conditions that must never happen; never use them for user input.
- Fail-safe defaults: deny by default, closed on error, no silent fallbacks.

Where output has no easy oracle (numerical, simulation, signal processing), test metamorphic relations: how the output must change when the input is transformed (scale, permute, add noise, add a duplicate).

## Design

Keep modules decoupled: no shared mutable state across modules, no reaching into another module's internals, no logic leaking across layers, subclasses substitutable for their base. If a change needs that, stop and tell the engineer.

## Discovered work

When you find work outside the spec, do not do it. File it as a new bead and link it `discovered-from` this one:

1. `$STRAND new "<title>" --type <t> --parent <epic-id> --description "..." --acceptance "..."` (rules in `filing.md`). It prints the new id.
2. `bd -C "<tracker dir>" link <new-id> <id> --type discovered-from`.

Do not use `--parent <id>` with this bead to express it: that is parent-child, the wrong relation. Mention the new bead to the engineer. Do not claim it in this session.

## Commits

- Commit with the `Commit with:` line of the context: `but commit --branch <name> -m "<what and why>" <files>`. Name the files; never commit unrelated changes.
- Commit at working checkpoints (tests green), not every edit.
- Never push by hand before the PR is open. `$STRAND pr` makes the first push (see `verify.md`); later pushes use `but push <name>`.

## WIP

The context has a `WIP: Build n/limit, Review n/limit` line. With `WIP warning: <reason>`, tell the engineer and point to the review queue (`/strand:brief`), then carry on unless they say stop. With `Build blocked: <reason>` (WIP mode `refuse`), do not start new Build work: give the reason and point to the review queue.

When every criterion's check passes, read `verify.md`.
