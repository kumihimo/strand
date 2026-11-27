# Git conventions for bead work

GitButler's own steering (installed by `but agent setup`) applies. These rules sit on top of it. The hooks enforce them.

No bead id in a branch name, commit message, PR title or PR body. Bead ids are local to this PC. The bead finds its branch through its `branch:<name>` label and its PR through its `pr:<owner>/<repo>#<n>` label.

## Branches

- Name: `<prefix>/<topic>`. `<prefix>` is the engineer's branch prefix (config `branchPrefix`, shown in the context); you pick a short topic.
- Make it with `but branch new <prefix>/<topic>`. The hook labels the bound bead `branch:<name>`.
- One bead has one branch, and a branch belongs to one bead. A second branch for the same bead is refused: file a new bead for separate work.
- Stack on another bead's branch with `but branch new -A <parent-branch> <prefix>/<topic>`, using the parent's full name. The hook makes this bead depend on the parent's bead, so bead order is merge order.
- Rename with `but reword <full-name> -m <new-name>`. The label follows.
- Do not make branches with `git checkout -b`, `git switch -c` or `git branch`.

## Commits

- `but commit --branch <the bead's branch> -m "<what and why>" <files>`, as on the `Commit with:` line of the context. Name the files; never commit unrelated changes.
- A commit to another bead's branch is refused. Changes for another bead belong in that bead's session.
- Do not use `but commit -A` or `-B` to make a branch while committing. Make it with `but branch new` first.

## PRs and pushes

- The first push and the PR: `$STRAND pr <id> --title "<title>" --body-file <file>` (see `verify.md`). The title and body follow the target repo's own PR rules.
- Later pushes of the same branch: `but push <name>`.
- No worktrees (ADR 0008). Parallel bead branches share one GitButler workspace.
