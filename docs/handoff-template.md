# Handoff template

Copy this block into the handoff you hand over, fill every field from a real command, and
keep the headings: they are the fields the reviewer checks.
A value that cannot be filled from a real command is written as the literal token
`unavailable` followed by the reason; it never says "none", "n/a", "presumably", "should be"
or a recap of what the author believes.

Two invariants make the template usable by a fresh session:

- Every value is a citation the successor can re-check — a path, a digest, a revision, an
  exit code or a command that produced it.
- `unavailable` is a positive statement that the evidence does not exist. It is never a
  restatement of a constraint and never a placeholder for work the author did not do.

## Field-by-field rules

| Field                               | How it is filled                                                                                                                                                                                                                                                                                                                                                                    | What `unavailable` looks like                                                                                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| objective                           | One sentence, the same text passed as `pappra checkpoint --objective`.                                                                                                                                                                                                                                                                                                              | Refuse to hand over. Without an objective the package has no subject.                                                                                                                                               |
| acceptance                          | The verifiable criteria, quoted from the assignment; one line each.                                                                                                                                                                                                                                                                                                                 | Refuse to hand over. An acceptance-free handoff invites an unverifiable review.                                                                                                                                     |
| constraints                         | The write scope, prohibitions and review requirements, one line each.                                                                                                                                                                                                                                                                                                               | `unavailable (constraints were never recorded)` — flag it for the coordinator before review.                                                                                                                        |
| repository and root paths           | `repoId` plus absolute `root`, copied from `checkpoint.repositories[]`.                                                                                                                                                                                                                                                                                                             | `unavailable (repository root was not captured; the record may have been written from a bare checkout)`.                                                                                                            |
| base revision                       | The commit recorded when the task or change started — the starting revision of the work under review, from the assignment or the task record, never the previous checkpoint's `head`. For commits A (start) → B (intermediate checkpoint) → C (candidate) the base is A and the review covers A..C; B is progress evidence only, so a review that compares just B..C is incomplete. | `unavailable (the starting commit was not recorded; the previous checkpoint head must not stand in for it)` — the reviewer asks the coordinator for the base, or reviews the whole known range and records the gap. |
| candidate revision                  | `head` of the latest checkpoint; when the tree is dirty, also the `patchDigest` and the retained patch artefact `patches/<digest-hex>.patch`.                                                                                                                                                                                                                                       | `unavailable (no checkpoint exists for the candidate bytes)`.                                                                                                                                                       |
| dirty and untracked change manifest | When `dirty: true`: the porcelain status, the tracked diff, and one path plus byte digest per untracked file, read from the retained patch artefact. When `dirty: false`: `clean` and say which commit is checked out.                                                                                                                                                              | `unavailable (worktree state was not captured; do not assume clean)`.                                                                                                                                               |
| source pointers                     | Each file the successor must read, as `path` plus the `digest` recorded in `checkpoint.artifacts[]`; add a one-line reason per file.                                                                                                                                                                                                                                                | `unavailable (path) — file did not exist when the checkpoint was written` for that entry only.                                                                                                                      |
| test evidence                       | The exact command, its exit code and the digest of the retained log, or a reference to a `validations[]` entry once one can be written.                                                                                                                                                                                                                                             | `unavailable (no test run for these bytes)`; never omit the line, and never record an empty pass.                                                                                                                   |
| limitations                         | What the package does not prove: partial context, unverified writer, unrun suites, skills not exercised. The same text passed as `pappra checkpoint --limitation`.                                                                                                                                                                                                                  | `unavailable (limitations were not recorded)` — this is itself a limitation worth naming.                                                                                                                           |
| next action                         | The single next step, from `checkpoint.nextActions[]`. One step, not a plan.                                                                                                                                                                                                                                                                                                        | Refuse to hand over. A successor with no next action will invent one.                                                                                                                                               |

## The template

```text
# Handoff — <taskId> revision <n>

## Objective
<one sentence; identical to checkpoint.objective>

## Acceptance
1. <criterion as written in the assignment>
2. <criterion>

## Constraints
- Write scope: <exact paths this work may touch>
- Prohibited: <what must not change>
- Review: <who reviews; state that an advisory review outside the formal protocol is
  never an ACK, a REPORT, an acceptance or a proof of ownership>

## Repository and root
- <repoId>: <absolute root path>
- Branch: <branch at the candidate revision>
- Recorded in: .pappra/local/tasks/<taskId>/checkpoints/<n>.json

## Base revision
- Commit: <full sha> (<subject>) — the commit the task or change started from
- Reviewed range: <base..candidate, for example A..C>
- Multi-checkpoint note: <when checkpoints exist at A, B and C, the base is A and the review covers A..C; the intermediate checkpoint B is evidence of progress only, so a review that compares only B..C is incomplete>
- Not recorded: `unavailable (reason)`. Never substitute the previous checkpoint's `head`; the reviewer asks the coordinator for the base, or reviews the whole known range and records the gap.

## Candidate revision
- Commit: <full sha> (<subject>)
- Dirty: <false | true>
- Patch digest: <sha256:... | null>
- Patch artefact: <patches/<digest-hex>.patch | unavailable (reason)>

## Dirty and untracked change manifest
<when clean: the word "clean" and the checked-out commit.
 when dirty: the porcelain status lines, then one line per untracked path with its digest.
 when not captured: unavailable (reason).>

## Source pointers
- <path> — <sha256:...> — <why the successor must read it>
- <path> — unavailable (file did not exist when the checkpoint was written)

## Test evidence
- Command: <exact command> — exit <n> — log <path or sha256:...>
- <or> unavailable (no test run for these bytes)

## Limitations
- <what this package does not prove>
- <or> unavailable (limitations were not recorded)

## Next action
<one step, imperative, checkable>
```

## Filling validation

Before handing over, the author answers these with a command rather than a memory:

- `pappra resume <taskId> --json` — read `verificationStatus`, `codeDrift` and
  `artifactChecks`. If the packet says `unknown`, the package does not know the bytes are
  current, and the field is filled as unknown, not as unchanged.
- `pappra docs check --include-private --json` — read `fileDigest` against `recordDigest`
  for each document pointer; `freshness: "stale"` means the pointer no longer describes
  the file.
- `git status --short` at the candidate revision — confirms that the manifest block and
  the recorded `dirty` flag agree. When neither the artefact nor a live status exists,
  the block is `unavailable`.
- Every exit code quoted in "Test evidence" comes from the run, not from the plan.

## What the template does not do

It does not create a new record, extend `pappra/checkpoint/1`, or change any command. It
is a reading order for the fields that already exist. Two of its required fields are
filled from artefacts because no command prints them yet — the untracked manifest from
`patches/<digest-hex>.patch`, and test evidence from a retained log — and the page that
explains those gaps is `docs/handoff-and-review.md`.
