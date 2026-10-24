# Pappra API boundaries

Pappra exposes small, versioned package entrypoints. Schemas use explicit
version strings; callers should validate returned data rather than infer
capabilities from command success alone.

## Core workspace

- `pappra/workspace`: inspect, resolve and discover workspace configuration.
- `pappra/init`: plan and apply workspace initialization.
- `pappra/doctor`: passive diagnostics and integration observations.
- `pappra/continuity`: checkpoint creation and advisory resume packets.
- `pappra/knowledge`: document catalogs and preview/apply lifecycle operations.
- `pappra/install`: local runtime installation (self, tarball, or exact version),
  journaled managed replacement and ownership-safe cleanup.

Core workspace operations use Pappra-owned `.pappra/` files. A checkout-local
machine file binds the workspace to a canonical path; missing or mismatched
local identity fails closed.

## Optional capabilities

Collaboration (`collab*`, `collaboration`) and managed Pi entrypoints (`hosts/pi-*`)
are experimental. Their wire schemas remain validated, but their exported TypeScript
interfaces and host-version pins may change before 0.1.0. Store recovery primitives
such as `breakLock` are low-level operations, not general application APIs.

- `pappra/code`: selected-repository status, explicit preparation and bounded
  query. Text/structure fallback does not require a code-graph service.
- `pappra/hosts`: optional host detection, hook adapters and lifecycle mappings.
  Host integration is not required to import or use core Pappra.
- `pappra/collab` and `pappra/collaboration`: bounded collaboration primitives
  and a generic controller interface. A caller must provide an explicit
  controller; no native host is launched by default. The `pi-rpc` controller path
  and its observed Pi 1.3.0 behaviour are documented in `docs/pi-rpc.md`.
- `pappra/schemas`: exported validation schemas and types.
- `pappra/hosts/pi-managed`: explicit fresh native Pi TUI launch, write-ahead
  terminal ingress journal, private endpoint and exact owned-child exit evidence.
  Uses Python 3's standard PTY support on Unix, normal Pi configuration and an
  explicit OpenRouter model. It does not adopt an existing session or prove
  complete native queue, approval or external-writer quiescence.
- `pappra/hosts/pi-managed-sdk`: explicit Pi 1.4.0 SDK and native TUI, pinned
  internal queue/dialog inventory, ingress fences and owned-runtime disposal.
  Its receipt describes runtime disposal, not operating-system process exit.
- `pappra/collab/automatic-handoff`: threshold-driven native summary, full-source
  checkpoint artifact capture, immutable bundle preparation and guarded transition ticks.
- `pappra/collab/role-orchestration`: bounded event dispatch through the existing
  work executor, durable no-redelivery receipts and authoritative aggregation.
- `pappra/collab/role-plan`: optional planner/writer/reviewer expansion into the existing
  work-plan model and conservative aggregation of its evaluated results.
  Root exports include `managedPi` and `collabRolePlan` namespaces.

The CLI exposes `session plan|start|status|fence|stop --config <absolute-file>`
and `collab role-plan expand|aggregate`, plus `collab role-run --request <file>
--apply [--watch]`. `collab capabilities derive --harness pi
--live` derives a standard card from a settled saved interactive session without
inventing a process-exit receipt. Existing preflight freshness checks still apply.

## Safety contract

- Plans are read-only; apply operations use explicit, bounded writes.
- Unknown ownership, stale identities, partial writes and interrupted locks are
  reported rather than silently repaired.
- Outputs are bounded and failures carry diagnostics or a typed outcome.
- No API authorizes a model, provider or external host merely by being imported.
- Version pins for optional hosts describe an observed integration surface; they
  do not prove that a native installation is callable.

## Compatibility

The public package intentionally preserves validated wire identifiers for
existing collaboration records. New Pappra defaults use Pappra-owned state
paths. Do not assume a legacy user-global state directory will be adopted or
migrated automatically.
