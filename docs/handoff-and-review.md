# Bounded handoff and fresh-context review

A handoff is a package, not a conversation. The implementing host builds it from the
continuity records it already writes, and a fresh reviewer or a successor reads it
without the discussion that produced it. Nothing here needs Herdr or Pi: the package is
produced and consumed through the existing `pappra checkpoint`, `pappra resume`,
`pappra docs` and `pappra code` commands.

Two rules govern the whole workflow:

- A review is a bounded artefact with its own inputs and verdict. It is not a summary of
  the reviewer's chat.
- An advisory review outside the formal collaboration protocol is never an ACK, a
  REPORT, an acceptance or a proof of ownership. It informs a decision; only the
  coordinator's recorded decision accepts work.

## What already carries the package

`pappra checkpoint` writes `pappra/checkpoint/1` under the private task directory
(`.pappra/local/tasks/<taskId>/checkpoints/`). `pappra resume` reads the pointer and
returns a `pappra/resume-packet/1`: the stored bounded context, identity checks against
the task and workspace, code drift, artifact checks and the reasons execution is or is
not allowed. Both sides already exist; the handoff package is a reading of them.

| Package field    | Continuity carrier                                                |
| ---------------- | ----------------------------------------------------------------- |
| objective        | `checkpoint.objective`                                            |
| acceptance       | `checkpoint.acceptance[]`                                         |
| constraints      | `checkpoint.constraints[]`                                        |
| repository, root | `checkpoint.repositories[].repoId`, `.root`                       |
| candidate        | `checkpoint.repositories[].head` (plus `.patchDigest` when dirty) |
| source pointers  | `checkpoint.artifacts[].path`, `.digest`                          |
| limitations      | `checkpoint.limitations[]`                                        |
| next action      | `checkpoint.nextActions[]`                                        |

A resume packet adds what a stored checkpoint cannot know by itself: whether the bytes
still match. `codeDrift`, `artifactChecks` and `verificationStatus` are re-observed at
read time, which is why a package is bounded to a revision instead of to a moment.

`pappra docs check` supplies the document half of the same statement: for every
registered document it reports `fileDigest`, `recordDigest` and `freshness`, so a
reviewer can see whether the file on disk is still the file that was reviewed.

## Building a package

1. Save the checkpoint at the revision you want handed over. Name the objective, the
   acceptance criteria, the constraints, the next action and every file the successor
   must read as `--artifact`.
2. Hand over the **task id** and the checkpoint revision, not a transcript. The
   successor runs `pappra resume <taskId> --json` in a fresh session.
3. Treat the packet's own verdict as part of the package. `executionAllowed: false` and
   a named `blockingReasons` entry are the packet saying what it does not prove:
   - `live_writer_unverified` — a stored checkpoint cannot show which session is still
     writing.
   - `writer_not_confirmed` — the caller did not pass `--session`, so the writer is
     unnamed.
   - `context_partial` — the checkpoint was written with `--context-completeness
partial`, so the semantic context is incomplete by the author's own declaration.
4. When the tree was dirty, hand over the patch digest **and** the retained patch
   artifact; a digest alone tells the successor that bytes differ, not which bytes.

A complete example, run against a fixture repository at two real commits:

```sh
git rev-parse HEAD                       # base:    06dca71bba1e8d87a61a1c86b0fb21f5d23cc1e8
pappra checkpoint --task demo-clean --objective "..." --acceptance "..." \
  --next-action "Add docs/spec-2.md describing the follow-up change." \
  --artifact docs/spec.md --context-completeness partial --json
# revision 1, dirty false, captureStatus complete

# ... commit the candidate ...
git rev-parse HEAD                       # candidate: b1528421391f0f8caaf99720b7f6619e929d9067
pappra checkpoint --task demo-clean ... --artifact docs/spec.md --artifact docs/spec-2.md --json
# revision 2, previousDigest sha256:214d8ab3..., head b1528421...
```

The resumed packet for that task reports `verificationStatus: "current"`,
`codeDrift.status: "unchanged"` for both artifact paths, `executionAllowed: false` with
`live_writer_unverified` and `context_partial`, and
`boundedContext.nextActions: ["Open a fresh-context review of the candidate bytes."]`.
That last line is the whole point: a session with no prior conversation can read the
next action from the packet.

## The four cases that must be reproduced, not assumed

Each case below was run for real; the command output is kept outside the repository in
`/Users/zimm.yu/.pappra/domains/host-native-m1/evidence/30-handoff/logs/`.

### A clean-commit handoff

Base and candidate are both real commits (`06dca71` then `b152842`), the checkpoint is
`dirty: false` with `captureStatus: "complete"`, and `resume` reports
`codeDrift.status: "unchanged"` with exit code 0. The successor identifies the next work
without the prior conversation. This is the only case where a bare revision is
sufficient evidence.

### A dirty-worktree handoff

With `docs/notes.md` edited and `scratch/working-note.txt` untracked, the checkpoint
records `dirty: true` and a `patchDigest`. Changing only the untracked file's content
changes that digest while `head` and `checkoutId` stay the same, so the digest covers
untracked bytes. The manifest itself is retained, not invented:

```text
$ cat .pappra/local/tasks/demo-dirty/patches/b375b1a6....patch
PAPPRA-UNTRACKED/3
P 45 221
 M docs/notes.md?? scratch/working-note.txtdiff --git a/docs/notes.md ...
F 24 71
scratch/working-note.txtsha256:dec25ab6141adb7b275f4a6c53cabd396809c437e1af6fe3023a0817316d1406
```

The record frames the `git status --porcelain` body, the tracked diff, and one entry per
untracked path with its byte digest. A later `resume` reports `codeDrift.status:
"changed"`, `patchStatus: "changed"` and exit code 1 once the tree moves again. Fields
the package cannot fill are marked `unavailable` (see the template); nothing is
estimated.

### A candidate identity change after review

`pappra docs review <documentId> --expected-digest <digest>` refuses to accept bytes
that are not the reviewed bytes:

```text
$ pappra docs review e497b1e1-... --expected-digest sha256:39949e6e... --apply
{"ok":false,"status":"stale","applied":false, ...}
document_proposal_stale: Reviewed digest sha256:39949e6e... does not match the bytes on disk
# exit 1
```

Re-planning without `--expected-digest` shows the difference directly:
`expectedFileDigest: sha256:1a690a0d...` against `recordDigest: sha256:39949e6e...`. At
the package level the same distinction is the checkpoint chain: a review that quotes
revision 1 (`head 06dca71`) does not describe revision 2 (`head b152842`). A stale review
is not approval of the new bytes; it is evidence about bytes that no longer exist.

### Missing evidence

The tool refuses to record evidence it cannot observe, rather than storing a plausible
placeholder:

```text
$ pappra checkpoint --task demo-missing --artifact docs/does-not-exist.md ...
{"ok":false,"status":"failed", ...}
file_not_found: docs/does-not-exist.md
residualPaths: [.../.pappra/local/tasks/demo-missing]
# exit 1
```

Related absent cases behave the same way: `pappra resume demo-never-existed` returns
`document_not_found: Task context not found` (exit 1), a task whose first checkpoint
failed returns `No checkpoint pointer for task` (exit 1), and `pappra docs review` on an
unknown id returns `status: "not-found"`. A checkpoint written without test evidence
records `validations: []` and `artifacts: []` — the honest statement is that no test
evidence exists, which the template carries as `unavailable`, not as an empty success.

## Reuse assessment: what honestly fits, and the gaps

The existing representation carries eight of the eleven required fields without any
change to storage: objective, acceptance, constraints, repository and root, candidate
revision, source pointers, limitations and next action. Its read side already answers the
question a reviewer actually asks, because `resume` re-observes drift and artifact
digests instead of trusting the stored snapshot.

Three fields do not fit as cleanly. The gaps are real, and each has a narrow additive
answer that needs no new persisted protocol and no schema version:

- **Base revision.** `repositories[].head` is the candidate, and the record carries no
  starting commit at all: neither `pappra/checkpoint/1` nor `pappra/task-context/1` has a
  start or base field. The base is therefore the commit recorded when the task or change
  started — named by the assignment or the task record — and never the previous
  checkpoint's `head`. For a task that starts at A, checkpoints at B and ends at C, the
  review covers A..C; a review that compares only B..C is incomplete, because it silently
  drops A..B. When the start was never recorded the field is `unavailable` with the
  reason, and the reviewer asks the coordinator for the base or reviews the whole known
  range and records the gap; substituting the previous checkpoint's `head` yields a
  zero-width comparison and is not allowed. The narrow additive proposal is to record the
  starting commit once, when the task is created, instead of deriving it later.
- **Dirty and untracked manifest.** The manifest exists and is complete — the retained
  `patches/<digest-hex>.patch` artifact holds the porcelain status, the tracked diff and
  one path-plus-digest entry per untracked file. What is missing is presentation: no
  command prints those entries, so `resume` exposes only the digest. The narrow proposal
  is a read-only presentation of the artifact that already exists; nothing new is
  persisted, and the digest stays the identity.
- **Test evidence.** `validations[]` is in `pappra/checkpoint/1` but `pappra checkpoint`
  has no flag that writes it, so it is always empty today. The narrow proposal is one
  `--validation <id>` option mapped onto that existing field — no schema change, no new
  record, no new file. Until it exists, test evidence belongs in an artifact (the log
  itself) plus an `attempted` line naming what was run, and `unavailable` when neither
  exists.
- **The `unavailable` convention** is documentation, not storage: an absent field is
  named in `limitations` with a reason. Nothing in the schema enforces it, which is why
  the template states the convention field by field.

Do not extend the protocol to close these gaps during a handoff. The package is a
reading of existing records; a new persisted format would need its own review.

## Fresh-context review

A reviewer is a new session that receives the package, not the conversation. It may read
the repository, the artifacts named in the package, the checkpoint and the resume packet.
It defaults to read-only: no checkpoint writes, no document acceptance, no commits. Its
output is a verdict against the stated acceptance criteria — each criterion pass, fail or
not-verifiable, with the command or file that decides it, and a list of findings that
name what it could not inspect.

The reviewer must state which bytes it reviewed: the commit, or the patch digest when the
tree is dirty, plus the artifact digests it actually read. It must also state the base it
measured against, and that base is the commit recorded when the task or change started —
not the previous checkpoint's `head`. When the start is not recorded, the verdict carries
`unavailable` with the reason and either reviews the whole known range or returns
`not-verifiable` and asks the coordinator for the base; it never substitutes the previous
checkpoint's `head`. A verdict without that identity cannot be matched to a candidate
later, and a candidate that moved after the review is unreviewed by definition.
`docs/review-request-template.md` carries the request shape; `docs/handoff-template.md`
carries the package shape.

## Limits

- A checkpoint records what its author asserted. `resume` verifies bytes, not honesty: it
  cannot tell whether the objective was accurate, only whether the files changed.
- Drift reporting degrades to `unknown` rather than to a false `unchanged`. A capture that
  cannot run (for example inside a sandbox that forbids temporary files) leaves
  `currentCaptureStatus: "unknown"`, and `unknown` must never be read as approval.
- `contextCompleteness: partial` blocks execution by design. A handoff that declares
  partial context says so; it does not silently claim completeness.
- A review outside the collaboration protocol is advisory only. It is never an ACK, a
  REPORT, an acceptance or proof of ownership, and no coordinator decision is implied by
  it.
