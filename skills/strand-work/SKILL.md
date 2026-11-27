---
name: strand-work
description: Use when working a bead, running /strand:work, planning work in a repo that uses the strand plugin, or when the session context starts with "Strand bead" or "Bead workflow". Routes to the Specify, Build, Verify and close-and-learn instructions by stage.
---

# Working a bead

Definitions used in every stage file:

- `$STRAND` = `node "${CLAUDE_PLUGIN_ROOT}/src/cli/strand.ts"`. `$STRAND` is shorthand in these files only: always write the full command `node "${CLAUDE_PLUGIN_ROOT}/src/cli/strand.ts" <command> ...`; never type `$STRAND` itself (it is not a shell variable, and `$STRAND pr` would run the coreutils `pr`) and never a bare `strand`. When a hook message says `strand <command>`, run it in the full form.
- Every `bd` call runs against the tracker: `bd -C "<tracker dir>" <args>`, the form the `Tracker:` line of the injected context gives. Put `-C "<tracker dir>"` straight after `bd`, before the subcommand. Before a session is bound there is no `Tracker:` line: if you do not know the tracker dir, ask the engineer.
- A hook message that says `bd <args>` means `bd -C "<tracker dir>" <args>`.
- Git: read `git-conventions.md`. Use the `Commit with:` line of the injected context. No bead id in a branch name, commit message, PR title or PR body.
- Filing a bead: read `filing.md`.

## Context the hooks give you

A session may also be started from the cockpit (a card dragged to Specify, or **Start session**). It runs `$STRAND work` in the bead's repo folder, so the same hooks, binding and context apply. Lines the engineer sends from the cockpit, such as `Spec approved. Start Build.` or `Changes requested: <note>`, arrive as prompts in this session.

- Bound to a bead: `Strand bead <id>: <title>`, then `Type: ...; stage: ...; spec format: ...`, a `WIP:` line, a `Commit with:` or `Branch: none yet` line, the `Tracker:` line, the acceptance criteria and the spec (`design`).
- Every prompt: a `Bead workflow:` reminder with the stage. `Stage changed: specify -> build. The spec is approved. Start Build.` means the engineer approved the spec (in the cockpit or with `/strand:approve`).
- Not bound: a `Bead workflow: no bead is bound` reminder. Questions and read-only work need no bead. For new work, enter plan mode before the first file edit and put one line in the plan: `Bead: <id>` for an existing bead (`bd -C "<tracker dir>" search <words>`, `bd -C "<tracker dir>" ready`, `bd -C "<tracker dir>" list --status=in_progress`), `Bead: new` to file one once the plan is approved, or `Bead: none`. A large feature: name its epic in the plan and list its child beads as the tasks. A one-line change may skip plan mode: confirm the bead with the engineer, then claim it with `bd -C "<tracker dir>" update <id> --claim`. If the engineer says no bead is needed, run `$STRAND none`.

## Stages

Find the `stage:` in the context and follow its row.

| Stage | Do |
|---|---|
| backlog | Not claimed. Read `specify.md` and start there. |
| specify | Read `specify.md`. Write the spec to the bead, then stop for the engineer's approval. File edits are refused until then, except under `docs/rfc/` and `docs/adr/`. |
| build | The spec is approved. Read `build.md`. Work that changes a repo makes its branch first, before the first file edit. Then `verify.md` as the criteria's checks pass. Never tick the last criterion while the bead has repo changes and no branch. |
| verify | Every criterion is verified and there is no PR yet. Read `verify.md` and open the PR with `$STRAND pr`. A bead with no branch closes by itself instead. |
| review | A PR is open. Wait for the engineer's review. Fix CI failures or review comments only, on the same branch. Never open a second PR. When the Stop hook asks the close-and-learn question, read `close.md`. The bead closes when its PR merges. |
| done | The bead is closed; nothing to do. Tell the engineer and stop. |

## Rules for every stage

- One bead per session. Work only what the spec says. File anything else as a new bead (see `build.md`).
- You never approve a spec. The engineer approves the plan in this session, presses **Approve spec** in the cockpit, or runs `/strand:approve <id>`. The hook refuses `$STRAND approve` from you.
- A claim you run through the Bash tool (`bd -C "<tracker dir>" update <id> --claim`, or `--status in_progress`) writes the approval. Claim only after the engineer approved a `Bead: new` plan, confirmed a one-line change, or approved the epic whose next child you claim. Never claim a bead to get past Specify.
- Never close a bead that has a branch or PR yourself: it closes itself when the merge is seen, and the hook refuses the close while the branch is unmerged. A bead with no branch closes itself once every criterion is verified, so a bead that changes a repo must have its branch before its last criterion is ticked.
- The hooks deny an action only by a rule. When one denies, read the reason and follow it; do not work around it. If a hook fails, it allows the action and writes to stderr.
- Tests run only via the repo's `Test command` (ADR 0008). Never start your own runner. A server starts only through the repo's `Run command`.
- Browser checks are hands off (ADR 0018): restart the stack and drive the page with Playwright yourself. Do not ask the engineer to restart a server, open a browser or click through a page. See "Browser checks" in `verify.md`.
- WIP limits warn by default: the context shows `WIP warning: <reason>`. Tell the engineer, point to the review queue (`/strand:brief`), and carry on unless they say stop. In `refuse` mode the line is `Build blocked: <reason>` and starting Build is denied.
- Checkpoints (spec written, tests green, PR opened, wrap-up): add a one-paragraph summary with `bd -C "<tracker dir>" comments add <id> "<summary>"`.

## Artefacts

Save mockups, screenshots and recordings to `<tracker>/artefacts/<bead-id>/scratch/` (the tracker is the `Tracker:` dir). Nothing there is kept by default. Promote each keeper with `$STRAND keep <bead-id> <scratch-file>`. Never put binaries in the bead text or in the code repo.
