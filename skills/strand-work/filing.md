# Filing a bead

File every bead with `$STRAND new` (the full command form is in `SKILL.md`). Do not file work with bd's own `create` or `q`.

Capture first, spec at approval. A bead needs only a title, a type and a parent epic to be filed. The description and the criteria are optional at creation and may be free text. The spec rules are checked at approval: **Approve spec** in the cockpit, `$STRAND approve` and `/strand:approve` refuse a spec that breaks one and list what is missing.

## When filing

- **Title.** Imperative and specific. Aim for 3 to 4 words. A title over 60 characters is refused.
  - Bad: `One order-number format across both channels: SUB + id padded to 10`
  - Good: `Unify order-number format`
- **Parent.** Required on everything except an epic. No orphans: every bead sits under an epic, directly or through a chain of parents. If the right epic does not exist, file it first with `--type epic`.
- **Description and criteria.** Optional. Write what is known now. The forms below are suggestions until approval.

## At approval

- **Description.** Opens with the user story, then whatever a reader with none of this session's context needs: what was tried, what was ruled out, why. Any role follows "As": "As a buyer", "As the engineer" or a name. Needed for every type except `chore` and `epic`.
  ```
  As <role>, I want <capability>, so that <benefit>.

  <supporting context>
  ```
- **Acceptance criteria.** At least one, for every type except `chore`. Every non-empty line is one criterion in the form `- [ ] <text> (check: <command>)`, naming the test or command that proves it:
  ```
  - [ ] <criterion> (check: <test file or command>)
  - [ ] <criterion> (check: user confirms in the app)
  ```
  - Always keep the leading `- `. The cockpit renders criteria as a task list, and it only recognises lines that start `- [ ]` or `- [x]`.
  - A criterion is ticked only when its check passes, with the evidence: `- [x] <criterion> (verified: <command> passed)`.
  - The bead closes only when every line is ticked that way.
- Approval through an approved plan or a claim does not check these rules: it may come before the criteria exist.

## Repos

- A bead has one **primary repo** (`repo:<folder>`): the session's folder, where the branch and the PR live.
- It may have **context folders** (`context:<folder>`): other folders under the workspace the session can read. `$STRAND work` passes each one to Claude with `--add-dir`.
- A bead with no repo is a non-code bead. It cannot start a session until one is set.

## Command

```
node "${CLAUDE_PLUGIN_ROOT}/src/cli/strand.ts" new "Unify order-number format" --type task --parent <epic-id> \
  --description "As a finance admin, I want one order-number format across retail and enterprise, so that reconciliation does not need two parsers.

Enterprise reuses the Stripe invoice number. Retail pads to 10 digits." \
  --acceptance "- [ ] Both channels emit SUB<10-digit-id> (check: npm test -- orders)
- [ ] Existing enterprise orders are backfilled or excluded (check: user confirms in the app)"
```

- The shortest form is the title, `--type` and `--parent`. Add the story and criteria when you know them.
- `--repo <name>` sets the primary repo. It defaults to the folder you run the command in, when that folder sits directly in the workspace root.
- `--context <folder>` adds a context folder. Repeat it for more. Context folders need a primary repo.
- Long text: use `--description-file <path>` and `--acceptance-file <path>` instead. Give a flag or its file, not both.
- `$STRAND new` prints the new bead id. Add `--json` for the full record.
- On a refusal it prints the rule that failed. Fix it and run again.

## Edit after filing

- Criteria: `bd -C "<tracker dir>" update <id> --acceptance "<text>"`. This replaces the whole list, so send every line.
- Description: `bd -C "<tracker dir>" update <id> -d "<text>"`.
- If the criteria change after the spec was approved, show the engineer the change and ask. On a yes, run `$STRAND criteria accept <id>`.

## Audit what is already there

```
# open beads with no parent that are not epics
bd -C "<tracker dir>" list --status open --json | jq -r '.[] | select(.issue_type != "epic" and ((.parent // "") == "")) | .id'

# checklist lines missing the leading "- "
bd -C "<tracker dir>" list --all --json | node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
for (const issue of data) {
  for (const line of (issue.acceptance_criteria ?? "").split("\n")) {
    if (/^\s*\[[ xX]\]\s/.test(line) && !/^\s*[-*]\s*\[[ xX]\]\s/.test(line)) {
      console.log(`${issue.id}: ${line}`);
    }
  }
}'
```

- bd's `query "parent=none"` returns nothing on bd 1.2.2. Filter the JSON as above.
- bd's `lint` checks that sections exist. It does not check titles, the story line or the parent.
