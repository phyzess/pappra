# W3: checkpoint/resume repository coverage without schema migration

Complete original batch 2's coverage bug after accepted W2 filename capture. Missing configured repositories are currently discarded by `loadContinuityWorkspace`, which retains only discovery.repositories. Resume iterates only checkpoint rows; a newly resolved/configured current repository absent from that list can escape drift comparison. Empty/equal subsets must not imply full current verification.

## Compatibility decision

Keep existing checkpoint/resume schema versions, JSON field shapes/enums and stored payload formats. No new durable inventory framework or schema migration is needed for this bounded correction. Use internal configured/resolved/unresolved/truncated discovery observations, existing checkpoint `contextCompleteness`/bounded `limitations` and existing diagnostic/identity-check/blocking-reason/code-drift fields to express coverage truthfully.

At capture, unresolved configured repositories must be explicitly diagnosed with logical ID/configured reference and captured as incomplete context; they must not silently disappear under a complete checkpoint. Do not invent an absolute root, checkout identity, HEAD or patch for an unresolved external mapping. Persist the incompleteness through the existing partial flag and clear bounded limitations; preserve user semantic fields/limitations. If bounds prevent a valid honest checkpoint, refuse without advancing the pointer rather than silently dropping required coverage or user context.

At resume, require coverage of the currently configured/resolved set and compare both directions against stored snapshot IDs. A currently unresolved configured repository, unknown/truncated discovery, missing stored repository, or current-only repository must prevent `verificationStatus: current` and unchanged aggregate code coverage. Use existing changed/unknown categories accurately; include bounded IDs/reasons with visible truncation/count limitations where necessary. Current-only repositories need a diagnostic/set comparison, not fabricated stored-root/checkout fields merely to fit a drift row. The existing schema cannot represent a nonexistent stored identity; do not manufacture one or add enum values ad hoc.

Older checkpoints remain readable under the same schema. Their stored rows are the observable baseline, not evidence that historically omitted configuration was complete. Check current coverage conservatively; don't reconstruct facts that were never persisted, silently rewrite old records or parse human limitation strings as execution authority. Continue to require live writer proof; context/checkpoints never grant execution.

## Scope and behavior

- Retain the repository discovery primitive's unresolved/truncated/diagnostic results in continuity's internal context. Use the selected workspace's configured logical entries plus actual discovery; no home/global scan or guessed external mapping. Do not change workspace discovery semantics or private config.
- Missing/unavailable/unmapped/non-Git configured entries are distinct from a valid intentionally empty repository configuration. An intentionally repository-free workspace must remain usable under documented context/authority limits; an incomplete configured set must not look equivalent.
- Capture and resume must not produce a false current result when a missing repository stays missing, becomes available later, is newly configured after capture, or a stored repository is removed/renamed/replaced. Preserve existing path relocation/checkout identity/HEAD/patch/status checks and W2 content detection.
- Keep configured/resolved aliases and bounds explicit. Do not silently treat a partial configured list, ID collision or over-limit set as complete. Preserve read-only resume and no repository/Git/config mutation.

## Validation and delivery

First reproduce current false-current cases on fresh fixtures: configured missing/unmapped repo during capture+resume, previously absent repo becoming available, and newly configured/current-only repo. Include a normal unchanged complete workspace and intentionally empty configuration as nonregressions. Assert persisted capture incompleteness/diagnostics, noncurrent resume/code aggregate and unchanged old checkpoint bytes; validate returned JSON against existing schemas. Exercise configured external mappings without reading real host registries. Cover existing repository bounds with an honest incomplete/refusal result, preserving user context.

Source scope is continuity context/service and directly needed existing service/CLI tests. Add one exact service-file claim; existing context/tests claims remain. No W1/collaboration/knowledge/init/schema/Git-helper/workspace-discovery rewrite. If a concrete schema constraint makes the pinned compatibility policy impossible, return the conflict before broadening it.

Run focused continuity/CLI tests, typecheck/build, formatting/source checks. At this completed checkpoint-reliability milestone run the wider deterministic/package verification proportionately once; report actual integration skips/limits. Same Pi/session, actual fresh new-assignment readiness before first edit. Return combined manifest/input/readiness, before/after cases, compatibility/bounds and actual validation through one proactive product REPORT/notify, without native/model/pane/global/dependency changes, polling, timers, --wait or fallback.
