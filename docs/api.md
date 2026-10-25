# Pappra API boundaries

Pappra exposes a deliberately small package map. Schemas use explicit version
strings; callers should validate returned data rather than infer capabilities from
command success alone.

## Published entrypoints

The 0.1.0 beta publishes fourteen package keys and no per-surface aliases:

| specifier | surface |
| --- | --- |
| `@phyzess/pappra` | root namespace: package info and host integration adapters; automation lives in the experimental barrel |
| `@phyzess/pappra/workspace` | inspect, resolve and discover workspace configuration |
| `@phyzess/pappra/knowledge` | document catalogs and preview/apply lifecycle operations |
| `@phyzess/pappra/continuity` | checkpoint creation and advisory resume packets |
| `@phyzess/pappra/code` | selected-repository status, explicit preparation, bounded query |
| `@phyzess/pappra/schemas` | exported validation schemas and types |
| `@phyzess/pappra/install` | local runtime installation, journaled managed replacement, ownership-safe cleanup |
| `@phyzess/pappra/hosts` | optional host detection, hook adapters and lifecycle mappings; managed Pi and extension namespaces live in the experimental barrel |
| `@phyzess/pappra/init` | plan and apply workspace initialization |
| `@phyzess/pappra/doctor` | passive diagnostics and integration observations |
| `@phyzess/pappra/collab` | bounded collaboration primitives: `store`, `canonical`, `resources`, `envelope`, `messages`, `lifecycle`, `handoff`, `notify`, `workPlan`, `rollover` |
| `@phyzess/pappra/experimental` | curated experimental barrel (see below) |
| `@phyzess/pappra/experimental/pi` | Pi adapter barrel: managed Pi runtime and opt-in host extensions |
| `@phyzess/pappra/package.json` | package metadata |

Core workspace operations use Pappra-owned `.pappra/` files. A checkout-local
machine file binds the workspace to a canonical path; missing or mismatched local
identity fails closed.

## Layer boundaries

Published barrels follow the dependency order, and a lower layer never imports an
upper one:

- `schemas`, `infra`, `collab` — leaf contracts, bounded IO and collaboration
  primitives.
- `workspace`, `knowledge`, `continuity`, `code`, `install` — core services.
- `hosts` — native host primitives: detection, hook adapters, bundles and the
  managed-Pi controllers. No `hosts` module imports `src/app`.
- `adapters` — explicit composition above both layers. `src/adapters/pi` owns the
  opt-in recovery and session-transition extensions, and the emitted host bundles
  are built from those adapter sources.
- `app`, `cli`, `experimental` — application orchestration and the barrels that
  publish it.

A format that both a host primitive and an adapter need belongs to the lower layer:
the recovery configuration contract is
`src/hosts/integration/recovery-config.ts`, which bundle export inside `hosts` and
the recovery adapter both read, and which imports no application module.

`pnpm source:check` enforces this direction: core/schema modules may not import
`app`, `hosts`, `collab` or `adapters`; host modules may not import `app` or
`adapters`; and infrastructure may import only `infra` and `schemas`.

## Experimental surface

Collaboration, automation and managed-Pi APIs are experimental: their wire schemas
are validated, but exported TypeScript shapes and observed host-version pins may
change before 0.1.0. They are reachable only through the two experimental
entrypoints, which keeps internal `src/app` and `src/hosts` files out of the
published contract.

```ts
import * as experimental from '@phyzess/pappra/experimental';
import * as pi from '@phyzess/pappra/experimental/pi';

const { runWorkExecution } = experimental.collabWorkExecution;
const { executeRecovery } = experimental.collabRecoveryExecutor;
const { validateSessionTransitionRequest } = experimental.collabSessionTransition;
const { PI_RECOVERY_CONFIG_SCHEMA } = pi.piRecovery;
```

`@phyzess/pappra/experimental` exposes exactly these namespaces: `collaboration`,
`collabAdmission`, `collabRolePlan`, `collabRoleOrchestration`,
`collabAutomaticHandoff`, `collabWorkPlanInspection`, `collabWorkExecution`,
`collabRecovery`, `collabRecoveryProjection`, `collabRecoveryExecutor`,
`collabSessionTransition`, `collabWorkPlan`, `collabWorkflow`, `piManaged`,
`piManagedSdk`, `piRecovery` and `piSessionTransition`. The Pi namespaces are also
importable on their own from `@phyzess/pappra/experimental/pi`. Work-plan
validation stays reachable from `@phyzess/pappra/collab` as the `workPlan`
namespace; this barrel re-exports the same module as `collabWorkPlan`.

`collabWorkflow` provides typed preparation, dispatch, participant actions,
explicit coordinator acceptance and inspection for a declared cohort. The CLI
entry is `pappra collab workflow`; see [the workflow contract](collaboration-workflow.md).
It composes existing protocol authority and never chooses identities or accepts
worker output automatically.

The knowledge service exposes `previewReview` and `applyReview` for explicitly
reviewed bytes. These preserve the document ID and unrelated metadata; see
[document review](document-review.md) for the pinned-digest CLI flow.

## Observed host version matrix

The reference defaults and admitted observed versions are distinct. Onboard and
verify/probe use the admitted set; the default pin is not an equality gate:

| host | `HOST_SUPPORT` reference default | `HOST_EVENT_VERSIONS` (onboard and verify/probe admission) |
| --- | --- | --- |
| Pi | 1.3.0 | 1.3.0, 1.4.0 |
| Codex | 0.163.0 | 0.163.0, 0.164.0 |
| Claude Code | 2.1.292 | 2.1.292, 2.1.308 |

`pappra onboard` passes the freshly observed admitted version to installation or
export, and probes again before writing. A missing, unreadable or unlisted
version is skipped with guidance; sharing a semantic-version minor is not
admission. Dry-run uses the same planning rules. These checks neither broaden
plugin-hook support nor prove native loading, trust, reload or callability.

Managed Pi is narrower still. The PTY controller pins Pi 1.3.0 behaviour, and the
opt-in SDK controller requires exactly `@earendil-works/pi-coding-agent@1.4.0`
with matching private-source hashes; a different build is refused rather than
degraded.

## Capability notes

- `code` selected repositories use bounded text/structure fallback when no code
  graph engine is selected; a graph is never required.
- `hosts` detection, hook adapters and bundles are optional. Host integration is
  not required to import or use core Pappra.
- `collab` primitives never launch a host by themselves. A caller supplies an
  explicit controller (`fixture` or `pi-rpc`); the observed Pi RPC behaviour is
  documented in `docs/pi-rpc.md`.
- `experimental.piManaged` performs an explicit fresh native Pi TUI launch with a
  write-ahead terminal ingress journal, a private endpoint and exact owned-child
  exit evidence. It uses Python 3's standard PTY support on Unix, normal Pi
  configuration and an explicit model. It does not adopt an existing session and
  does not prove native queue, approval or external-writer quiescence.
- `experimental.piManagedSdk` drives an explicit Pi 1.4.0 SDK and native TUI with a
  pinned internal queue/dialog inventory, ingress fences and owned-runtime
  disposal. Its receipt describes runtime disposal, not operating-system process
  exit.
- `experimental.collabAutomaticHandoff` captures a threshold-driven native summary
  and full-source checkpoint artifacts, prepares immutable bundles and runs guarded
  transition ticks.
- `experimental.collabRoleOrchestration` dispatches bounded events through the
  existing work executor with durable no-redelivery receipts and authoritative
  aggregation.
- `experimental.collabRolePlan` expands optional planner/writer/reviewer roles into
  the existing work-plan model and conservatively aggregates their evaluated
  results. These automation namespaces are available from the experimental
  barrel; the stable root exposes core package and host-integration APIs.

The CLI exposes `session plan|start|status|fence|stop --config <absolute-file>` and
`collab role-plan expand|aggregate`, plus `collab role-run --request <file>
--apply [--watch]`. `collab capabilities derive --harness pi --live` derives a
standard card from a settled saved interactive session without inventing a
process-exit receipt. Existing preflight freshness checks still apply.

## Safety contract

- Plans are read-only; apply operations use explicit, bounded writes.
- Unknown ownership, stale identities, partial writes and interrupted locks are
  reported rather than silently repaired.
- Outputs are bounded and failures carry diagnostics or a typed outcome.
- No API authorizes a model, provider or external host merely by being imported.
- Version pins for optional hosts describe an observed integration surface; they
  do not prove that a native installation is callable.
- Store recovery primitives are not library APIs. `breakLock` is deliberately
  absent from the public `@phyzess/pappra/collab` barrel: breaking a task lock
  requires the operator confirmation flow, and only `pappra collab recovery
  lock-break` implements it.

## Removed beta paths and the reset policy

The beta narrows the map instead of preserving every earlier path. These
specifiers no longer exist and fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`. No shim
and no compatibility promise accompanies them:

- `@phyzess/pappra/collaboration`
- `@phyzess/pappra/collab/admission`, `.../collab/work-plan`
- `@phyzess/pappra/collab/role-plan`, `.../role-orchestration`
- `@phyzess/pappra/collab/automatic-handoff`
- `@phyzess/pappra/collab/work-plan-inspection`, `.../work-execution`
- `@phyzess/pappra/collab/recovery`, `.../recovery-projection`, `.../recovery-executor`
- `@phyzess/pappra/collab/session-transition`
- `@phyzess/pappra/hosts/pi-recovery`, `.../pi-managed`, `.../pi-managed-sdk`,
  `.../pi-session-transition`

Migration is one namespace import: take the same functions from
`@phyzess/pappra/experimental` (or `@phyzess/pappra/experimental/pi`) as shown
above. A consumer that cannot move should pin the exact beta version it already
resolves instead of relying on a path that is gone.

Records that earlier beta builds wrote keep their wire identifiers
(`harness-collab/...`, `pappra/...`), because those identifiers name files that
already exist on disk. Pappra does not rewrite them, does not adopt a legacy
user-global state directory, and does not migrate configuration automatically.
`init --reconfigure` is the only supported way to rebuild a workspace file from
current selections, and it keeps identity, extension and continuity bindings.
Old local state keeps its archival exit (`repair --reset-local`), not a migration.
