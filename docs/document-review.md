# Explicit document review

Status: current implementation.

`docs check` reports changed registered bytes as `needs-review`, but it never
accepts them. Accepting reviewed bytes is a separate, explicit operation:
`docs review` re-registers the *same* `documentId` with the digest of the bytes a
human or agent actually inspected. It never rewrites, moves or deletes document
content, and it is not a substitute for `docs scan` or `dev:setup`, which still
never accept changed bytes for an existing registration.

Applying a review changes exactly two fields of one record:

- `digest` — the digest of the file bytes that were reviewed;
- `lastReviewedAt` — the review timestamp pinned in the plan.

`location`, `kind`, `maturity`, `owner`, `taskId`, `lifecycle`, `visibility`,
`sources`, `supersededBy`, the schema and every other registration are
preserved. The update runs through the existing knowledge lock, journal and
catalog writer. Interrupted writes remain recoverable; a failure after the
catalog commit is reported as `partial`.

## Plan, then apply

Plan mode is read-only. It prints the digest of the current bytes and the
registered digest, so the reviewer can compare them with what they inspected.

```sh
# 1. See why the record is stale (read-only).
pappra docs check --include-private

# 2. Inspect the plan; nothing is written.
pappra docs review 4f4b1c8e-5a5f-4a1e-9a8b-0f2d3c4b5a69
pappra docs review 4f4b1c8e-5a5f-4a1e-9a8b-0f2d3c4b5a69 --json

# 3. Accept the bytes you reviewed by pinning their digest.
pappra docs review 4f4b1c8e-5a5f-4a1e-9a8b-0f2d3c4b5a69 \
  --apply --expected-digest sha256:6d1f...e2
```

`--apply` requires `--expected-digest`, and that digest must equal the bytes on
disk at apply time. Without it the command refuses: a review must never accept
bytes nobody pinned. A plan-mode JSON report carries the value to pass:

```json
{
  "schema": "pappra/docs-review/1",
  "ok": true,
  "status": "ready",
  "applied": false,
  "plan": {
    "schema": "pappra/document-review-plan/1",
    "documentId": "4f4b1c8e-5a5f-4a1e-9a8b-0f2d3c4b5a69",
    "scope": "private",
    "expectedFileDigest": "sha256:6d1f...e2",
    "recordDigest": "sha256:1a2b...f0",
    "reviewedAt": "2026-10-25T10:20:00.000Z"
  }
}
```

After a successful apply the same `documentId` reports `current` in
`docs check`, keeps its single catalog entry, and its sources are unchanged.

## Scope

The record's catalog decides the scope. Private records live in the private
catalog; `shareable` records live in the shared catalog. `--scope` is optional,
and passing a scope that does not own the record is refused rather than
silently retargeted:

```sh
pappra docs review <documentId> --scope private
pappra docs review <documentId> --scope shared --apply --expected-digest <digest>
```

A `documentId` registered in both catalogs is ambiguous: resolve the duplicate
registration (for example `docs forget <documentId> --scope private --apply`)
before reviewing either record.

## Refusals

`docs review` refuses, without touching the file or any record:

- bytes that changed after the plan, and a pinned digest that does not match the
  current bytes (`document_proposal_stale`, `document_file_changed`);
- a missing file, a symlink, a directory, a FIFO or any other non-regular file;
- paths that escape the workspace/repository root or a nested workspace;
- an ambiguous scope, a scope mismatch, or a `documentId` present in both
  catalogs;
- concurrent drift — another operation that changed the record, its metadata,
  the owning catalog, or the workspace root identity after the plan was built;
- a held knowledge lock; retry after the current operation finishes.

Every refusal leaves the registered digest, the metadata, the catalog and the
document bytes exactly as they were, and reports the reason. When a catalog
commit fails after the journal was prepared, the journal records the failure and
the record is unchanged; rerunning the same plan after resolving the cause is
safe.

Repeating a plan whose effect is already present reports `unchanged` and writes
nothing, but it is still a verification step: the workspace root identity, the
registered metadata, the path and the exact reviewed bytes are re-read first. A
file that was edited, removed, or replaced by a symlink after the review is
refused instead of reported as unchanged.

`docs review --apply` without `--expected-digest` exits `2` with
`invalid_arguments`.
