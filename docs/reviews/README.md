# Review index

This directory holds only the current review index. It is not a log, and it is not a
place for new review discussion: reviews belong in the issue or pull request that
carries the change.

## Current contracts

Current behaviour is described by the maintained guides, not by review notes:

- [Review closeout](../review-closeout.md) — the 84 stable finding ids, their current
  status and evidence locators.
- [Cold-start acceptance](../cold-start-acceptance.md) — what the fresh-agent cases
  actually observed, including the retained release failure and its verified recovery.
- [API boundaries](../api.md) — package entrypoints, experimental surfaces, safety contract.
- [Quick start](../quickstart.md) — install, init, runtime and optional surfaces.
- Topic guides next to them (`collaboration-*.md`, `managed-pi-*.md`, `pi-rpc.md`,
  `host-plugin-validation.md`).

## Historical reviews

Earlier direction, revision and acceptance notes are archived privately under
`.pappra/local/review-archive/`. That location is machine-local and untracked by design:
the notes are process evidence, not current requirements, and Git history still holds the
exact bytes they were removed from. Copy them out of the archive only when reproducing a
specific past decision.

Anything in an archived note — an accepted direction, a superseded exit code, a temporary
path or session identifier — applies to the change it reviewed and proves nothing about
today's checkout. Public prose must not reintroduce home directories, machine scratch
paths, native session identifiers or pane inventories; use placeholders such as
`/absolute/path`, `<session-id>` and `<pane-id>` instead.
