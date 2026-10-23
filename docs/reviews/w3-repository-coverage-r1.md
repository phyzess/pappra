# W3 repository coverage: review round 1

Verdict: changes requested for a bounded identity-collision gap. REPORT/native correlation, assignment/input/direction, all output/log/readiness digests and 77 current files independently verify. Independent type checking, test compilation and 39 continuity/CLI tests passed. Missing/unmapped/current-only coverage improvements and the same-schema compatibility choice are sound.

## R1: generated repository ID collides with a valid configured ID (P2)

`repoId(repository, index)` in continuity context still creates fallback IDs such as `workspace-2` without reserving configured IDs. Resume indexes snapshots in `Map<string, ...>`, so a collision silently overwrites a different checkout. This is explicitly within W3's collision/complete-coverage boundary.

Independent fixture script `/tmp/pappra-w3-review.mjs` creates a Git workspace root and a separate nested Git checkout `child`, configures the child with valid logical ID `workspace-2`, and ignores `.pappra/` plus child in the parent Git status. Discovery returns the configured child and automatically observed root. Capture publishes two repository rows both named `workspace-2`; the later root row replaces the child in the resume map. With no repository change, resume then falsely says the child relocated to the parent root and returns unknown.

Make snapshot identities unique and deterministic across capture/resume before building keyed maps or publishing complete coverage. Prefer an existing-compatible fallback that avoids the configured/assigned ID set, or a clear bounded collision refusal/diagnostic. Never overwrite one checkout with another, fabricate relocation or silently rename configured logical IDs. Preserve normal fallback compatibility where collision-free; disclose any old colliding-record behavior without rewriting old checkpoint bytes. No new schema/enum/discovery semantics are requested.

Add a fresh parent/child fixture with a configured ID colliding with fallback, and an ordinary noncolliding control. Assert unique identities and correct unchanged coverage, or explicit collision refusal rather than publication followed by false relocation. Preserve the prior missing/unmapped/current-only/empty/bounds tests.

## Readiness ordering deviation and dispatch correction

Pi correctly disclosed that W3's first source write preceded its only new-assignment readiness artifact. The post-edit ready result at `2026-10-21T15:38:44.480Z` is not prewrite evidence; do not erase or retroactively repair it. Source authorization/claims remain separate from that missed readiness step.

For the repair, Codex will run the existing product preflight on the new pinned assignment against the last actual same-Pi runtime card while fresh, persist its result before notification, and include its digest with the assignment message. The receiver verifies that matching ready evidence and actual runtime/contract are still current before its first write; if stale/changed, refresh and preflight before editing. This reuses real receiver evidence, not a fabricated coordinator observation. No restore/reapply ceremony makes an earlier write compliant.

Only the collision correction and meaningful regressions are requested; no full-suite/package repetition for this narrow repair unless justified by a failure. Preserve C0-C12/W1/W2, schemas, coordinator documents and normal discovery behavior. Return current manifest/input/before-after/pre-dispatch readiness and focused verification via one proactive product REPORT/notify, without native/model/pane/global/dependency changes, polling, timers or --wait.
