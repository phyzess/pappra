# C3 native capability evidence: implementation direction

Restore installed-user access to the maintained Pi, Codex and Claude native-evidence adapters. Reuse the legacy evidence semantics and existing Pappra contract/fingerprint/preflight primitives; do not make a new capability assertion engine.

## Public entry

`pappra collab capabilities derive --harness <pi|codex|claude> --assignment <abs assignment.json> --template <abs declared-card.json> --execution <abs execution.json> [--session <abs pi-session.jsonl> | --events <abs events.jsonl>] --json`

- Pi requires session; Codex/Claude require events. Reject wrong-host options and ambiguous/duplicate/unknown flags. Do not infer harness/session/configuration/cwd from names or supply invented defaults.
- Read-only: return a versioned result `pappra/collaboration-capabilities/1` with `derived`, `needs_input` or `invalid` and appropriate diagnostics/limits. Derived returns the capability card; exit 0, needs_input 1, invalid 2. Human output summarizes metadata without exposing transcript/input/tool payloads. JSON may include only the derived card and explicitly selected metadata, never raw evidence content.
- No output file flag in this slice. Document deliberate saving of the JSON `card` field to a new task-local path using Nushell, followed by `collab preflight`; deriving alone neither persists nor dispatches.
- Bound assignment/template JSON at 1 MiB and each native evidence file at 16 MiB. Absolute regular files only; refuse final symlinks and special files without blocking, with descriptor-level type/size checks and bounded reads. Preserve supported system aliases above files and generic content-free diagnostics. Do not import legacy files at runtime or depend on their checkout.

## Semantics to preserve

Use these three maintained legacy adapters as pinned migration inputs:

- `atlas/integrations/harness-collab/scripts/hosts/pi-evidence.mjs`.
- `atlas/integrations/harness-collab/scripts/hosts/codex-evidence.mjs`.
- `atlas/integrations/harness-collab/skills/harness-collab/scripts/claude-evidence.mjs`.

Preserve their native execution/session/cwd/phase and event-shape checks, call/result correlation, incomplete/error handling, file digests and skill fingerprint validation. Translate to typed repository modules under the existing claimed app scope; share only clear common bounded IO/validation helpers. No unrelated host refactor or new dependencies.

- Pi: successful correlated tool results can verify the exact tool; a skill requires an actual successful read of that skill's entry. Preserve numeric message timestamps versus zoned record timestamps, native-time fallback rules and incomplete tool-use refusal.
- Codex: preserve explicit item/tool mapping and unsupported-stream behavior. Exec JSON does not establish skill invocation; skills stay unknown and required skills still block preflight. Do not fabricate current desktop/daemon native capability evidence from an exec-stream parser.
- Claude: preserve bootstrap/discovery-phase restrictions, actual initialization tools, successful result correlation, skill name/source injection matching and unknown/discovered/callable/verified distinctions.
- Unknown/failed/incomplete or mismatched evidence cannot promote a capability. Preserve documented parser limitations; do not add guessed mappings for newer versions. A supported shape fixture is not proof of live version support.
- Observation time comes from the native evidence according to the adapter's maintained semantics, never adapter invocation time. Replaying old artifacts must not refresh their freshness. Bind evidence records to the exact bytes used.
- A derived runtime card remains a claim derived from supplied evidence; no authentication, process ownership, admission or task completion is implied. Existing `preflight` remains a separate read-only check.

## Scope and validation

- Public CLI glue, bounded service/adapter modules under `src/app`, focused tests under `tests/collab`, and both packaged collaboration guidance mirrors. Keep source exclusions and previous message/preflight behavior intact. No changes to parent plan/review files.
- Port representative maintained deterministic fixtures or create minimal sanitized equivalents. Cover each host's positive derivation and preflight integration, identity/cwd mismatch, changed skill, failed/unmatched/incomplete tool calls, unsupported stream rows and native-time freshness. Assert no file changes, transcript leakage or child/model process launch. Include special-file/oversize handling and installed CLI from unrelated cwd.
- Test all three harness selections without real model launches. Run type checking/build, focused and relevant collaboration regressions, source policy, formatting of changed files, mirror parity and package verification. Pin output files in a manifest; attribute unexecuted live-host/version verification honestly.
- Same existing Pi session and epoch-1 claims. A still-fresh actual same-session runtime observation can be reused; run readiness against this new pinned assignment before source writes. Refresh actual receiving-runtime evidence only when needed for freshness/identity/capability changes. Do not relabel declared evidence or timestamp old evidence as newly observed.
- Deliver one REPORT with pinned input revision, manifest and limitations; notify through the working product route, without waiting/polling/native fallback. BLOCK a concrete schema/contract conflict before weakening or broadening semantics.
