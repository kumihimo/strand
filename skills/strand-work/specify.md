# Specify

Goal: a spec the engineer can approve: a user story, acceptance criteria that each name their check, and a spec body. Do not write production code. File edits are refused in this stage, except under `docs/rfc/` and `docs/adr/`. Writing to the bead is allowed.

## 1. Understand

- If intent is unclear, ask the engineer questions first (superpowers:brainstorming). One question at a time.

## 2. Write the spec body in the bead's format

Use the format named in the context (`spec format:`):

- `checklist`: one-line intent. The criteria are the checklist; a body is optional.
- `gwt`: Given / When / Then scenarios; number each acceptance test AT-1, AT-2, ...
- `ears`: When / While / If-then / shall statements; give each a test or verification ID; If-then rows carry defensive and security cases.
- `repro`: environment, steps, expected, actual, first failing test.
- `document`: the RFC or ADR template itself (RFC: Summary, Motivation, Detailed design, Alternatives, Risks, Unresolved questions; ADR: Status, Context, Decision, Consequences). The document is the spec; it goes in `docs/rfc/NNNN-<slug>.md` or `docs/adr/NNNN-<slug>.md`, which you may edit in this stage.
- `brief`: the playbook brief for the bead type (EULA review, DPIA, deck, incident, retro).

## 3. Risk and legal rows (in the spec body)

- Risk matrix. Required when the bead touches auth, personal data, money or public APIs; skip otherwise. A table: risk, likelihood, impact (likelihood × impact: low/medium/high each), mitigation. Group mitigations as policy, technology and people.
- Legal and ethics rows, when the bead touches personal data or automated decisions:
  - UK GDPR lawful basis (and consent where it is the basis).
  - Automated decisions: is a person affected by automated decisions with no human in the loop?
  - Algorithmic bias: who could be treated worse, and how would we notice?
  - Data minimisation: collect and keep only what the purpose needs.
- Accepted risks: do not accept a risk yourself; ask. For each risk the engineer accepts, write an ADR in `docs/adr/NNNN-<slug>.md` (Nygard: Status, Context, Decision, Consequences) and track it with a `decision` bead linked `related` (`bd -C "<tracker dir>" link <decision-id> <id> --type related`).

## 4. Write the criteria

- One criterion per checklist item, per acceptance test (AT-n), per EARS id, or per repro step. Each names its check:
  ```
  - [ ] <criterion> (check: <test file or command>)
  - [ ] <criterion> (check: user confirms in the app)
  ```
- One criterion per id (`gwt` and `ears`). A second check on the same scenario is its own scenario with its own id (AT-9), never a second line under AT-8.
- A UI criterion names a browser check you will run yourself with Playwright (see "Browser checks" in `verify.md`): `(check: Playwright, <what the script does and sees>)`, or the repo's own browser suite command. Use `user confirms in the app` only for what a script cannot drive: a real payment, hardware, or a judgement of look and feel.
- Keep the leading `- ` on every line. The scenarios themselves stay in the spec body.
- The bead may have been filed with free-text criteria or none. Turn every line into this form now: no prose lines in the acceptance text.

## 5. Save to the bead

- Story: `bd -C "<tracker dir>" update <id> -d "<text>"` if the description does not open with `As <role>, I want ..., so that ...` yet.
- Criteria: `bd -C "<tracker dir>" update <id> --acceptance "<full list>"`. This replaces the whole list, so send every line.
- Spec body: write it to a temp file, then `bd -C "<tracker dir>" update <id> --design-file <file>`.
- Check with `bd -C "<tracker dir>" show <id>`. Add a checkpoint comment.

## 6. Stop for approval

- Once the story and criteria are on the bead (step 5), tell the engineer the spec is on the bead and to press **Approve spec** in the cockpit or run `/strand:approve <id>`. Then stop.
- Do not enter plan mode on your own, and do not start Build work. The spec on the bead is what the engineer reviews.
- An engineer who is already in plan mode can still approve by approving a plan that carries the line `Bead: <id>`; the hook then writes the approval and the criteria baseline.
- After approval the next prompt carries `Stage changed: specify -> build`. Then plan the build.
- **Approve spec** and `/strand:approve` check the spec rules and refuse a spec that breaks one (approval by plan or by a claim does not check them): the story line (not for a `chore` or an `epic`), at least one criterion (not for a `chore`), and every acceptance line in the form `- [ ] <text> (check: <command>)`. The cockpit lists what is missing beside the button. Fix the bead before you stop.
- The engineer may ask for changes instead (Request changes in the cockpit adds a comment starting `changes requested:`). Revise and stop again.
- Never approve, and never run `bd -C "<tracker dir>" update <id> --claim` to move on. A claim through the Bash tool counts as approval.
- If the hook answers `The approval was not written: <reason>` (for example a WIP limit in `refuse` mode), tell the engineer the reason and stop. The bead stays in Specify.

## 7. After approval

- Write the approved criteria to the bead first, every time, with `bd -C "<tracker dir>" update <id> --acceptance "<full list>"`. Rewriting an identical list is harmless. If the bead had no criteria at approval, the hook records the baseline on this update.
- If the hook says the criteria changed after approval, show the engineer the change and ask. On a yes, run `$STRAND criteria accept <id>`. On a no, put the approved list back.
- The same applies whenever criteria change later in Build. Never change them silently.

Then read `build.md`.
