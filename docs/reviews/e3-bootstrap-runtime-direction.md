# Local task-record reader and bootstrap registration

The successor tool gate is accepted within scope. Implement the concrete local read dependency and opt-in registration glue so it can evaluate actual task records, without changing the accepted guard, core or host defaults. This is not old-writer stop, a transfer executor, automatic rollover or installation.

## Exact scope

- New `src/hosts/integration/pi-bootstrap-runtime.ts`.
- New `tests/hosts/pi-bootstrap-runtime.test.ts`.

Expose a small bounded local reader and an explicit registration function that supplies it to `registerPiBootstrapGuard`. Configuration comes from trusted host integration: canonical existing absolute domain root plus exact task ID and the accepted guard's pinned configuration. No model-supplied path/allow token or caller reader override. Copy/validate configuration. Register the actual `tool_call` gate synchronously before any model work. Do not alter tools/MCP/skills/hooks/model, package exports, generated host bundle or global installation.

## Reader contract

Select only `<domainRoot>/tasks/<taskId>/task.json`. Validate a short safe task ID and exact task/domain identity in the parsed `TaskRecord` (`domain_id` must derive from the selected canonical root). Require existing directories; **do not use `resolveDomainRoot` or `taskRootFor` to create them**. Reject symlink/unsafe path entries and record directory/FIFO/device targets. Pin the canonical domain/tasks/task directory identities (device/inode) once and recheck around each read; replacement/redirect of an ancestor invalidates the reader rather than silently rebinding to another task namespace. Do not resolve from cwd or an unrelated last-session cache.

Reuse existing `src/app/bounded-file.ts` where suitable: bounded regular-file no-follow/nonblocking descriptor read. Inspect its actual guarantees; it does not itself anchor parent directories or validate task identity. Keep all accepted helpers unchanged. Use the existing8MiB task-record limit or a documented stricter fixed limit; count raw bytes, read no unbounded stream, never execute record content. Reject invalid/truncated JSON, wrong task/domain/schema, inaccessible files or concurrent replacement/change detected around the read. Support normal atomic replacement of `task.json` inside the same pinned task directory when it yields a coherent validated current revision; do not pin the record inode forever or reject every legitimate transaction.

Remember last successfully observed revision/digest in memory: reject lower state_revision or different bytes at the same revision, without resetting this floor on a failed read. This is rollback detection during this runtime only, not durable restart fencing or authentication against arbitrary user-owned filesystem changes. Treat same revision/same bytes as repeatable. Return fresh parsed data; outward mutation must not affect pinned identities or the revision floor. No writes/locks/sidecars, watchers, timers, process/model/network/transcript calls, new authority store or automatic recovery. Clearly document residual filesystem check/use races and the explicit local-root trust boundary; do not claim an atomic global snapshot or native stop proof.

Runtime registration returns conservative status only. A failed/malformed reader result becomes the accepted guard's explicit block. Never cache a positive allow result or expose allow/release APIs. Imported accepted guard/core APIs are read-only dependencies, not permission to change them. Preserve pinned native session checking and every-write revalidation.

## Verification

Use real temporary task domains and genuine protocol fixtures. Invoke the actual registered tool handler: before-transfer non-read denied; after real atomic record update to a completed matching transfer first write allowed; after claim/attempt/native/epoch changes next write denied. Show the reader observes successive legitimate transactions, fails on rollback/same-revision byte changes, and does not recover its floor after an error. Test wrong task/domain, malformed/oversized/non-regular record, symlinked record/parent, renamed/replaced task/domain directory, disappearance and failure. Confirm normal record atomic rename remains supported and unknown failures cannot write. Include mutation-isolation of config/returned record/status and a bounded real FIFO case on supported POSIX hosts.

Private focused compile/tests/type/format/source-policy only; no full suite/package/native fixture/install/global settings/dependency/model/pane/session/commit/publication actions. Record exact commands, source/output hashes, counts and limitations proactively. All8 accepted adjacent guard/freeze/event/core/app files/tests listed in the protected baseline remain unchanged. Two new exact path claims and matching fresh new-assignment preflight precede dispatch. No hidden worker or completion polling.
