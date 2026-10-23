# C10: one explicit collaboration preparation contract

Replace the MCP objective-to-invented-runtime convenience path with the same explicit goal contract as installed CLI preparation. Keep this slice to preparation and truthful role/runner metadata. No new controller, launcher, model call, native history/control API, ownership migration or init work.

## Input and compatibility decisions

- `collab_prepare` accepts `{ domainRoot, goal }`, where goal uses the shared strict `pappra/collaboration-goal/1` schema. Reuse the schema rather than duplicating nested identities/capabilities in MCP. Coordinator agent/session/harness/owner_epoch and assignee agent/session/harness/surface/configuration_id/cwd, resources and requirements are supplied explicitly. Never infer cwd from a resource, identities from prose, or runtime configuration from defaults.
- The old flat objective/session/harness MCP form is intentionally unsupported. Missing goal, mixed legacy/new fields and unknown fields must be refused before task/claim/card writes with understandable schema/validation errors and migration guidance in documentation. No silent conversion or guessed identities. Preserve tool name `collab_prepare` and the explicit launch confirmation/runtime-evidence gate of `collab_start`.
- Retire the internal objective synthesis path if it has no other callers. It is not a published package export. Do not keep an undocumented route that recreates the old guessed fields. If source inspection reveals a genuine supported external caller, report that compatibility issue before changing the public contract.
- Return the existing prepared bundle/goal in a clear result. Do not create a synthesized capability-card file or manufacture an observation timestamp during preparation. A declared card is not required to prepare a goal. Explicitly document the removed helper `cardPath/card` output and explain how callers separately supply actual capability evidence and use existing derivation/preflight. Never upgrade declared evidence to runtime.

## Shared preparation behavior

Validate the independent assignee cwd as a real existing directory before creating task metadata or claims; allow a first resource to be a file. Preserve existing namespace/boundary checks and avoid user-workspace/global scans. Validation does not confer ownership or require a native host operation.

Add bounded explicit `roles` to the shared goal and copy them to Assignment. Use existing protocol role strings without inventing execution policy: nonempty bounded unique strings/array; unsupported malformed input refuses. Preserve compatibility for older raw goal JSON that omits roles by a documented `['implementer']` default. Keep the inferred TypeScript input compatible where practical; avoid unrelated fixture churn. Phase must not silently replace an explicit role.

Map the supported assignee harness to its established runner (`pi` → `pi-cli`, `codex` → `codex-exec`, `claude` → `claude-cli`) before writes. Refuse unknown/unsupported assignee harness early; do not leave partial tasks/claims. This metadata support does not add Codex/Claude live controllers: `collab_start/run` must still reject incompatible real-controller/harness choices without launching. Fixture tests remain explicitly fixtures. Reuse the established runner mapping rather than allowing separate tables to drift; do not alter isolated pilot profiles or daily Pi settings.

## Verification and delivery

Use actual in-memory MCP tool calls and shared app/installed CLI tests on new fixture domains. Cover nondefault participant identities/configuration/surface, independent cwd with a file first resource, preserved required/preferred capabilities and roles, three supported runner mappings, old-role default, missing/mixed/unknown legacy input and invalid cwd/harness/roles refusal with no artifacts. Check returned explicit prepared references are usable by the existing preflight path, declared/stale/mismatched evidence remains refused, and unsupported real-controller combinations never spawn. No real native process/model is necessary or authorized.

Update affected public MCP documentation and shipped references/mirrors with a complete explicit-goal example, old-input/output migration and supported-controller limits. Keep code and documentation in professional English. Preserve accepted C0-C9 behavior and excluded reliability changes/coordinator plans. Run proportionate regressions/typecheck/build/source/package/format/mirror checks.

Same Pi native session. Existing source claims plus explicitly recorded exact-file MCP/document/test extensions govern writes. Preflight this pinned assignment with actual fresh same-session evidence before source changes. Report current complete baseline-plus-changes manifest (or clearly separate verified manifests), input revision, prewrite evidence and results through one proactive product REPORT/notification. No completion polling, timer, blocking --wait, native fallback or automatic retry.
