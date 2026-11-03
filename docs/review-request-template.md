# Review request template

A review request asks a fresh session to judge a bounded candidate against stated
acceptance criteria. It carries the package, not the conversation, and it fixes the bytes
under review before the reviewer reads anything.

Two rules make the verdict usable:

- The reviewer is read-only by default. It may read the repository, the package and the
  artefacts the package names; it may not write a checkpoint, accept a document, commit,
  or change any file it inspects.
- An advisory review outside the formal collaboration protocol is never an ACK, a REPORT,
  an acceptance or a proof of ownership. A verdict informs the coordinator's decision; it
  never substitutes for it.

## What the reviewer receives

- The handoff package (`docs/handoff-template.md`), complete or explicitly incomplete.
- The repository and absolute root paths, plus the branch.
- The candidate identity: the commit, or the `patchDigest` plus the retained patch
  artefact when the tree was dirty.
- The base revision the candidate is measured against, and how it was derived.
- The source pointers with their recorded digests.
- The acceptance criteria, verbatim.
- The declared limitations, so the reviewer does not spend effort re-deriving them.

The reviewer does not receive the author's transcript, reasoning or chat history. When a
detail is missing from the package, the reviewer asks for the field rather than inferring
it from repository archaeology.

## What the reviewer may inspect

Read-only: the named repository and paths, the checkpoint and resume packet, the retained
patch artefact, the test logs named in the package, and
`pappra resume`/`pappra docs check`/`pappra code query` output for the candidate. It must
not run a command whose purpose is to change state, and it must not "fix" a finding.

A reviewer that cannot inspect something says so in the verdict. "Not inspectable" is a
finding, not a pass.

## Verdict shape

```text
# Review — <taskId> revision <n>

## Reviewed bytes
- Commit: <full sha> | Dirty patch digest: <sha256:...>
- Artefact digests read: <path> <sha256:...>, ...
- Reviewed at: <ISO timestamp>
- Repository state at review: <clean | dirty, with the command that showed it>

## Criteria
1. <criterion> — pass | fail | not-verifiable — <command or file that decides it>
2. <criterion> — ...

## Findings
- <severity: blocking | non-blocking> <path or field>: <what is wrong> — <how it was observed>
- none

## Not inspected
- <area> — <why> — <what the coordinator would need to decide it>

## Verdict
<approve | approve with non-blocking findings | request changes | not-verifiable>
Advisory only: this verdict is not an ACK, REPORT, acceptance or proof of ownership.
```

A verdict without a "Reviewed bytes" block is unusable: it cannot be matched to a
candidate afterwards.

## How a changed candidate is distinguished from the reviewed bytes

The identity is recorded, not remembered. Three mechanisms exist today and they agree:

- **Checkpoint chain.** Each revision records `previousDigest` and stores the candidate
  `head`. A review that quotes revision 1 does not describe revision 2, even when the
  author says "same change, one fix".
- **Dirty patch digest.** When the tree is dirty, `patchDigest` covers the tracked diff
  and the framed untracked entries. It changes when an untracked file's bytes change, so
  an untracked edit cannot slip past a review silently.
- **Document digests.** `pappra docs review <documentId> --expected-digest <digest>`
  refuses bytes that are not the reviewed bytes, and reports `document_proposal_stale`
  with a non-zero exit. `pappra docs check` reports `fileDigest` against `recordDigest`
  and a `freshness` verdict per document.

A candidate that moved after the review is unreviewed by definition. The correct response
is a new request against the new identity, not an amendment to the old verdict.

## Requesting the review

1. Freeze the candidate: either commit it and record the full sha, or record the
   `patchDigest` and keep the tree unchanged from that moment.
2. Write the request from the package fields above. Name the acceptance criteria you
   expect the reviewer to check, and the ones you know it cannot check.
3. State the read-only default in the request itself, not in a separate convention.
4. Record the returned verdict with its "Reviewed bytes" block next to the candidate
   revision. A verdict filed without that block is not evidence.
5. If the candidate changes, ask again. Do not carry the earlier verdict forward, and do
   not describe the earlier verdict as approval of the new bytes.

## Limits

- A reviewer with read access can be wrong about intent; it can be right only about
  bytes, paths and commands it observed. The verdict must therefore cite what it
  observed.
- A read-only reviewer cannot re-run a validation that needs to write build output. It
  reports `not-verifiable` for that criterion and names the command the coordinator
  should run.
- Reviewing inside a sandbox that forbids temporary files can degrade drift reporting to
  `unknown`. `unknown` is not `unchanged`, and a verdict that treats it as unchanged is
  invalid.
- This template adds no messaging transport and no automatic launch. It describes a
  request a coordinator hands over through whatever channel it already uses.
