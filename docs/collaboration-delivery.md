# Collaboration delivery guide

Pappra exposes bounded collaboration planning, work notification and recovery APIs through the experimental package entrypoints. Keep planning, notification, recovery and session transition as separate operations: an intent, submitted notification, ACK or task-local retirement marker is not proof of completed work or native session takeover.

## Public consumer APIs

The package root includes namespaced APIs for `collabWorkPlan`,
`collabWorkPlanInspection`, `collabWorkExecution`, `collabRecovery`,
`collabRecoveryProjection`, `collabRecoveryExecutor` and `collabSessionTransition`.
Beta 0.1.0 publishes no per-surface subpaths for them; take each namespace from the
curated experimental barrel:

```ts
import * as collab from '@phyzess/pappra/collab';
import * as experimental from '@phyzess/pappra/experimental';

const { validateWorkPlan, evaluateWorkPlan } = collab.workPlan;
const { inspectWorkPlan } = experimental.collabWorkPlanInspection;
const { runWorkExecution } = experimental.collabWorkExecution;
const { executeRecovery } = experimental.collabRecoveryExecutor;
```

Read-only recovery inspection, guarded recovery and resumable session transition
live in `experimental.collabRecovery`, `experimental.collabRecoveryProjection` and
`experimental.collabSessionTransition`. Host-specific Pi APIs live in
`@phyzess/pappra/experimental/pi` (`piRecovery`, `piSessionTransition`,
`piManaged`, `piManagedSdk`). The earlier `pappra/collab/*`, `pappra/hosts/pi-*` and
`pappra/collaboration` specifiers are removed and fail with
`ERR_PACKAGE_PATH_NOT_EXPORTED`; [API boundaries](api.md) carries the migration and
reset policy.

## Parallel work on existing assignments

Create a strict work plan from current task state and existing ASSIGN messages, capability cards and task-local participant bindings. Run a read-only execution plan first:

```sh
pappra collab work-run --request /absolute/path/to/work-execution.json --json
```

Apply only after reviewing each node's current assignment, attempt, input revision, coordinator epoch, resources and participant binding:

```sh
pappra collab work-run --request /absolute/path/to/work-execution.json --apply --json
```

Eligible disjoint writers may be notified in a bounded concurrent batch. Overlapping write scopes serialize or block. A role label never grants authority; dependent nodes remain blocked until the current coordinator accepts the exact registered predecessor report. Work-run does not create or adopt sessions, merge code, approve work, accept reports, or replay an ambiguous notification. Reconcile an existing intent before considering a new attempt.

See [collaboration work execution](./collaboration-work-execution.md) for the request schema, dependency rules and recovery procedure.

## Bounded recovery

Use the public recovery command to inspect one actionable recommendation without effects:

```sh
pappra collab recovery-run --request /absolute/path/to/recovery-run.json --json
```

`--apply` requires complete, current native session identity (session, cwd, harness and pane), an exact task-local binding reference and digest, and matching actor/attempt authority. Recovery is limited to one guarded continuation or coordinator review wake with durable cause deduplication. Only explicit supported evidence of no effect can permit a bounded retry; ambiguous or possibly issued effects remain unknown and are not replayed.

Recovery is not generic every-outage recovery: the installed Pi extension supports observed startup, settled and manual triggers, but no reconnect trigger. It does not create sessions, run hidden workers, poll for completion, answer approvals, consume prompts, guarantee exactly-once delivery across crashes, archive native sessions, or take over an interactive Pi session. See [collaboration recovery](./collaboration-recovery.md) for exact authority and evidence requirements.

## Optional Pi host packages

Host bundle export is an artifact operation. It never edits host settings and does not install, trust, enable, register, load, launch or transfer an extension. Choose the recovery or transition extension explicitly; no effectful recovery configuration is loaded by default.

Export an opt-in recovery extension only with an explicitly selected, bounded private configuration file that satisfies `pappra/pi-recovery-config/1`, includes the exact session/cwd/harness/pane and task-local binding digest, and points to the intended task and plan:

```sh
pappra host bundle --host pi --out /absolute/new-private-directory \
  --recovery-config /absolute/private/recovery.json
```

The exported config is written as a private sibling file (mode `0600`) next to the self-contained extension. Protect the whole exported directory as task-local sensitive state. Do not copy credentials, transcripts or unrelated task data into the config or package. Inspect the extension and config before taking any separate, explicit Pi installation/trust action.

Export the separate session-transition command extension with:

```sh
pappra host bundle --host pi --out /absolute/new-private-directory \
  --transition-extension
```

It exposes `/collab-transition plan|apply <absolute-request.json>` for an already-bound task. The extension does not start a successor or change settings when exported or loaded. Its current production Pi adapter cannot prove complete native quiescence, pending approvals or external writers, so source stop and claim transfer remain blocked. A reversible task-retirement marker preserves the original transcript in place; it is not native archive or external route removal. These artifacts make no automatic takeover or context-handoff support claim.

The existing `--bootstrap-config` flag is a separate opt-in default-deny successor gate. It is not a recovery switch. Bootstrap, recovery and transition exports do not weaken the existing staging, identity, trust or no-overwrite checks.

For host registration and verification limits, see [host plugin validation](./host-plugin-validation.md); for the transition stage ordering and native quiescence boundary, see [collaboration session transition](./collaboration-session-transition.md).
