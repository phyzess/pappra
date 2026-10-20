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

- `pappra/code`: selected-repository status, explicit preparation and bounded
  query. Text/structure fallback does not require a code-graph service.
- `pappra/hosts`: optional host detection, hook adapters and lifecycle mappings.
  Host integration is not required to import or use core Pappra.
- `pappra/collab` and `pappra/collaboration`: bounded collaboration primitives
  and a generic controller interface. A caller must provide an explicit
  controller; no native host is launched by default. The `pi-rpc` controller path
  and its observed Pi 1.3.0 behaviour are documented in `docs/pi-rpc.md`.
- `pappra/schemas`: exported validation schemas and types.

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
