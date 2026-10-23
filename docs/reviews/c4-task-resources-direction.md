# C4 task inspection and resource controls: implementation direction

Expose the existing deterministic task/resource primitives as installed-user operations. Reuse the authoritative record and current store/resources/lifecycle functions; no parallel task registry, scheduler or lock system.

## Public CLI

- `pappra collab state show --task-root <abs> [--json]`
- `pappra collab state doctor --task-root <abs> [--json]`
- `pappra collab state epoch-check --task-root <abs> --owner-epoch <positive integer> [--json]`
- `pappra collab resource list --task-root <abs> [--json]`
- `pappra collab resource claim --task-root <abs> --request <abs request.json> [--apply] [--json]`
- `pappra collab resource release --task-root <abs> --request <abs request.json> [--apply] [--json]`

Use strict subcommand-specific option handling and versioned JSON results. Successful read/plan/apply exits 0; state conflict/uncertainty/core refusal exits 1; invalid request/options exit 2. A plan is request/namespace validation only, not a reservation or promise that apply will succeed. Do not execute a mutation on a temporary clone as a fake plan.

## Resource request contract

Use `pappra/collaboration-resource-request/1` with a strict action-discriminated schema. Both actions require explicit nonempty holder agent/session identity; optional harness may be retained.

- claim: `action: claim`, `holder`, nonempty bounded `resources` using existing ResourceInput kinds/semantics, explicit `access: read|write`, optional `include_shared_git` (false by default), note, subtask_id and attempt. Validate kind-specific paths/ports/opaque values without inventing aliases or silently converting relative paths. Preserve all existing supported kinds; origin/derived metadata is produced by core expansion, not fabricated by request flags.
- release: `action: release`, `holder`, explicit `claim_id`, optional reason. Request action must match the CLI action. No unowned release route or mass release.

Bound request JSON at 1 MiB with the shared special-file-safe loader. Do not print request body values in malformed-input errors. Plan-only leaves all task/domain bytes, locks, transactions and claims untouched. `--apply` revalidates the namespace and invokes exactly the existing claim/release primitive. Apply is cooperative record mutation, not OS fencing or proof of stopped side effects.

## Core behavior and namespace

- Reuse the task namespace validator and identity revalidation already established for messages. Refuse original domain/tasks/task redirects and unsafe nested private state before reads/mutations; preserve system aliases above the domain. Avoid another filesystem framework. Inspect all nested store paths used by the new route; do not assume message-directory validation alone covers locks/transactions/ledger.
- Reuse core canonical resource expansion/conflict/epoch behavior, including parent/child path overlap, symlink aliases, all supported resource kinds, read/read compatibility, read/write conflict, per-worktree index/HEAD and explicit shared-Git opt-in. Do not narrow the 128-character collaboration task identity rule.
- Preserve core refusal for unreadable/unsupported neighboring task records, ambiguous claim IDs, holder mismatch and cancel-pending release. Retain claims under uncertainty and do not invent cancellation or stop proof.
- `state show` is a summary of stored task/revision/coordinator/freeze, attempts/results, claims, handoffs, uncertainty and lock observations; it does not query native execution. Follow the maintained legacy `show` projection rather than dumping message bodies/transcripts. Bound displayed collections or explicitly report truncation/counts.
- `state doctor` is diagnostic-only over the existing doctor/lock/transaction primitives. Never repair, break a lock, reconcile, release, restart or execute a process. Invalid record/layout must return a useful typed diagnostic rather than fabricated healthy findings.
- `epoch-check` uses the existing `checkOwnerEpoch`. `resource list` reports current-domain claims and unreadable-state uncertainty rather than treating an unreadable domain as empty.
- Git inspection needed by resource expansion is permitted; no model/native agent launch, process adoption/control, timer-based supervision or new authority transition.

## Scope, tests and delivery

Source changes: narrow app/CLI/schema glue, collaboration tests and shipped collaboration guidance (both mirrors); preserve excluded reliability files and coordinator plan/review ownership. Do not add handoff/reconcile/lock-break/task binding/native lifecycle operations yet; those are the following slices.

Tests must cover public read-only projections and no side effects; plan/apply separation; real cross-task conflict and holder/release boundaries; unreadable domain records; namespace redirection including nested mutation paths; parallel claims through separate CLI processes; Git worktree/resource compatibility; strict/unsafe input; and installed commands from an unrelated cwd. Use fresh fixture domains only: never release or alter this live task's claims as a test. Run relevant regressions, type checking/build, source policy, changed-file formatting, mirror and package checks.

Same Pi session and existing epoch-1 claims. Reuse fresh actual runtime evidence when suitable, refresh when needed, and run preflight against the new pinned assignment before writes. Return pinned input revision/current manifest/report through the product message route and notify once. BLOCK if the existing nested namespace guarantees cannot safely support an operation without a concrete broader design change; do not silently weaken them.
