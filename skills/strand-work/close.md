# Close and learn

Run when the Stop hook asks, once, as the bead first reaches `review`. It never blocks the close: the bead closes when its PR merges whether or not this is finished.

1. Ask the engineer once: "What did you correct?" (in the spec, the code, the PR, or your behaviour). Wait for the answer. If the answer is "nothing", stop here.
2. For each correction, propose one concrete change and let the engineer accept or skip it:
   - a rule in the repo's `CLAUDE.md` (a project-specific lesson);
   - a test that would have caught it;
   - a skill change: lessons that apply everywhere belong in the `strand` plugin repo. Propose the wording to the engineer; do not commit to that repo yourself.
3. Apply only what the engineer accepts. Commit it to this bead's branch as in `git-conventions.md`, then `but push <name>`, so it lands with the PR. No bead id in a branch name, commit message, PR title or PR body.
4. If a decision was made or reversed, add an ADR in `docs/adr/NNNN-<slug>.md` and link its `decision` bead: `bd -C "<tracker dir>" link <decision-id> <id> --type related`.
5. Add a summary comment: `bd -C "<tracker dir>" comments add <id> "<summary>"`.

Do not close the bead. It closes itself when the merge is seen.
