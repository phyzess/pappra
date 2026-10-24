# Collaboration recovery

Durable, opt-in recovery for interrupted collaboration tasks. Recovery is layered so each layer is
independently testable and the only component that can touch a live host is an injected controller that
verifies the live target before dispatching.

- **R1 — projection (advisory).** `inspectRecoveryProjection` (see
  [collaboration-recovery-projection.md](./collaboration-recovery-projection.md)) reads a task record and
  work plan through a bounded, no-follow, namespace-anchored reader and reports the single safe recovery
  recommendation. It writes nothing, queries no host, and is not an authorization.
- **R2 — executor (durable).** `executeRecovery` (`src/app/collab-recovery-executor.ts`) turns one
  actionable projection into at most one issued continuation/review wake, guarded by an atomic durable
  reservation keyed on the canonical cause.
- **R3 — opt-in Pi controller.** `recoveryExtension` (`src/adapters/pi/recovery-extension.ts`)
  reconciles on supported startup/settled/manual triggers, gated by the actual host session.
- **CLI handler.** `runCollaborationRecoveryRunCommand` (`src/cli/commands/collaboration-recovery-run.ts`)
  exposes a `plan`/`apply` boundary for the integration router.

The new-session handoff, old-writer stop, ownership transfer and archive are a separate Stream A batch and
are **not** part of recovery.

## Executor (`executeRecovery`)

```ts
const result = await executeRecovery(
  { taskRoot, planFile, self, policy, requestId, mode, expectedSession?, maxRetries? },
  { controller, now?, sleep? },
);
```

- **Plan vs apply.** `plan` validates authority, namespace and the single actionable recommendation and
  writes nothing. `apply` reserves, then issues one wake.
- **Canonical-cause reservation.** The durable dedup key is derived from the canonical cause identity
  (task, actor, role, attempt, input, owner epoch and the admitted answer/report identity carried in the
  action key) — **not** from the caller `requestId`. A different request id for the same cause does not
  create a second right to send; it returns the recorded outcome. A genuinely different cause (a new
  attempt, input or coordinator answer) is a distinct key and is never suppressed by an earlier reservation.
- **Anchored, no-follow sidecars.** The reservation lives at
  `<taskRoot>/.recovery/reservations/<causeKey>.json`. Every sidecar directory component is `lstat`-checked
  to be a real directory inside the task root with its inode pinned, and the reservation **file** is created
  exclusively (`O_EXCL`) and updated only through an `O_NOFOLLOW` descriptor whose inode must still match
  the pinned file. A pre-created or swapped `.recovery`/reservation symlink — even one installed during a
  retry backoff — is refused, so a write can never escape the task root or overwrite an outside path. The
  complete reservation/cause/journal/final schema is parsed; malformed or truncated data stays a
  conservative unknown. Persistence failures become structured blocked/unknown outcomes and never throw out
  of the host callback, and a final receipt is never written through an unsafe path. The initial task
  namespace anchor is retained and re-verified across the whole operation. No OS atomic fence or
  cross-process exactly-once is claimed; writes are fsync'd.
- **Per-attempt journal + fresh re-validation.** Each dispatch attempt appends an intent to the durable
  journal (persisted before the controller call) and records its outcome after. Immediately before **every**
  attempt — including after a backoff — the namespace anchor, sidecar anchor, record, plan and authority
  (actor/attempt/input/epoch/approval/cancellation) are re-validated; a CANCEL admitted during backoff, a
  redirect, or a changed recommendation stops with no further wake.
- **Known-no-effect-only retry.** A controller reports an `observation`: `none` (supported evidence of no
  effect), `queued`/`applied` (effect issued), or `unknown` (a possible/ambiguous effect). Only a
  `failed`/`unavailable` result with observation `none` retries, within a bounded budget and backoff. A
  thrown controller, a post-dispatch failure, or any `unknown`/`queued`/`applied` observation stops and is
  recorded as an actionable unknown — never blindly replayed. A `submitted`/`queued` wake is a submission
  acceptance only, never consumption or completion. Numeric retry inputs are bounded (NaN/Infinity fall back
  to the default). After a blocked, refused or unknown final result, a later explicit invocation may retry
  the same cause only when every retained journal entry has a completed, known-no-effect outcome and the
  final observation is also `none`. Each invocation gets a fresh bounded retry budget; an exclusive
  generation claim prevents concurrent callers from both resuming that boundary. Recorded successful or
  deferred effects return a successful `noop`; ambiguous effects remain `ok: false` / `unknown` and are
  never silently converted to success or reissued. A verified dead owner with no dispatch intent can
  be resumed. Interrupted generation claims are followed through exclusive immutable successors instead
  of deleting a possibly replaced lock; live, malformed or excessively long claim chains remain unknown.
  An incomplete dispatch intent still requires supported observation before recovery.
- **Authority and identity.** The acting `self` must match the expected session. For a resume the attempt's
  bound native session must match too; for a coordinator review the actor is validated by role and is **not**
  compared to the completed writer's native binding.

The injected `controller` is the only live-host touch. `herdrRecoveryController` /
`createHerdrRecoveryController` list the live Herdr participants and verify the target agent **exactly**:
the live participant's parsed session identity (via `reportedSessionIdentity`, not a substring) must equal
the expected session, its cwd (required when an expected cwd is pinned) and pane must match, and — when a
task binding is supplied — its live participant and a recomputed `recoveryBindingDigest` must match the
admitted binding. Task authority is re-checked through `confirmAuthority` after the awaited live lookup and
immediately before the prompt (closing the lookup-to-send gap). A missing, foreign or mismatched live
target, or revoked authority, is refused without fallback. They never spawn a process.

## Opt-in Pi controller (`recoveryExtension`)

Loading the extension reads a sibling `recovery.json` (`PI_RECOVERY_CONFIG_SCHEMA`) and installs
`session_start`, `agent_settled` and a manual `pappra-recovery` trigger. Each trigger observes **genuine
host facts** (`observeHostFacts`) from the pinned installed Pi context — `ctx.sessionManager.getSessionId()`
and `ctx.cwd`, the same shape the accepted native-event producer uses — and reconciles only when the actual
host
session matches the configured expected session — a config loaded in a foreign session is skipped, and a
missing host observation stays explicit (never fabricated). Reconciliations never overlap.

There is no permanent per-event lock: every supported trigger may reconcile, and re-issue is prevented
durably by the executor's canonical-cause reservation. An initial no-op therefore does not suppress a later
genuine cause, while recovery's own settled event cannot repeatedly wake an already-reserved cause (no
self-loop). There is no known reconnect event, no completion polling, hidden daemon or approval auto-answer,
and the accepted observation-only native-event producer is left unchanged.
`createRecoveryReconciler(config, { controller, now?, sleep?, execute? }).reconcile(trigger, hostFacts)` is
exported for tests and for a CLI/manual controller.

## CLI handler (`recovery-run`)

```
pappra collab recovery-run --request <abs recovery-run.json> [--apply] [--json]
```

The request file (`pappra/collab-recovery-run-request/1`) carries `taskRoot`, `planFile`, `self`, `policy`,
`requestId`, optional `expected`, and (for `--apply`) `target.agent`. Apply requires a complete expected session,
cwd, harness, pane, task-local `binding_ref` and pinned `binding_digest`; it rejects missing/null identity,
participant or binding evidence. The bounded regular binding file must use `pappra/collab-binding/1`, identify the
current task root/id, and admit exactly the acting native participant and requested Herdr agent. The executor
re-reads and revalidates that binding, current task actor/attempt/coordinator authority and current projection
before every attempt and after the awaited live lookup immediately before prompting. The callback uses the actual
live Pi `sessionManager.getSessionId()` / `cwd` shape; a completed writer's native identity is never compared to
the coordinator performing a progress review. Without `--apply`, the handler runs a strict zero-write dry plan.


An apply request pins the binding file itself, rather than submitting a caller-created participant hash:

```json
{
  "schema": "pappra/collab-recovery-run-request/1",
  "taskRoot": "/abs/domain/tasks/TASK-1",
  "planFile": "/abs/domain/tasks/TASK-1/work-plan.json",
  "self": { "agent_id": "writer", "session_id": "native-session", "harness": "pi" },
  "policy": { "role": "writer" },
  "requestId": "recovery-request-1",
  "expected": {
    "session_id": "native-session",
    "cwd": "/abs/project",
    "harness": "pi",
    "pane_id": "w3:p4",
    "binding_ref": "/abs/domain/tasks/TASK-1/routing-binding.json",
    "binding_digest": "sha256:<64 lowercase hex digits>"
  },
  "target": { "agent": "herdr-writer" }
}
```

The binding participant must match `self`, every expected native pin, and `target.agent`; it must name the same
`task_root` and `task_id` as the current task record. Use the digest of the exact binding bytes.

`pappra collab recovery-run` is registered in the public CLI router and help. The argument parser rejects
missing, duplicate and unknown options, while the request parser rejects malformed and incomplete apply evidence.
The handler exports `parseCollaborationRecoveryRunArgs` and `runCollaborationRecoveryRunCommand` for tests and
future consumers.

## Honest limits

- Recovery is advisory + a single guarded wake; it is **not** automatic every-outage recovery and does not
  prove exactly-once delivery across a crash — a `queued` observation is not completion.
- No new session, hidden process, arbitrary command, model override, automatic approval or uncertain-effect
  replay. A possible/ambiguous effect remains an actionable unknown until supported observation resolves it.
- Package export integration and the new-session handoff/stop/transfer/archive remain separate from this batch.
  Final real restart/network and packaged consumer checks remain at the integrated milestone.
