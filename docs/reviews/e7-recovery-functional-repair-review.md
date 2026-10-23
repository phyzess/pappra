# Recovery functional repair review

Status: original four counterexamples fixed; remaining original acceptance requirements still need repair. The repaired report/output/source digests match. Independent strict compilation and all 51 supplied tests pass. The four original coordinator regressions also pass unchanged. Private output: `/private/tmp/e7-functional-review.NM1HWS`. Additional deterministic checks in `/tmp/e7-functional-repair-extra.mjs` reproduce the following remaining gaps; no full/package/install/live verification was run.

## P1: actual installed Pi context is not read

`observeHostFacts` searches `context.session.id`, `session_id` and `sessionId`. The installed Pi context already pinned by the accepted `pi-native-events.ts` adapter uses **`ctx.sessionManager.getSessionId()`** and `ctx.cwd`. A fixture with precisely that supported shape returns null, so the actual startup/settled recovery path never reconciles. Use the documented method with its receiver preserved, bounded validation and guarded access/throws. Do not replace this with fabricated event fields. Preserve the accepted producer unchanged; reuse its established interface pattern and pin rather than invent another host API. Add actual installed-shape extension callback tests, including a foreign session and missing cwd.

## P1: native identity checks still admit unknown or foreign destinations

Two deterministic controller tests return `submitted` when refusal is required:

- `sessionKind='id'`, `sessionValue='foreign-' + expectedSessionId + '-other'` matches through `includes`.
- A live participant with the right session but **null cwd** passes a non-null expected cwd.

Use the existing `reportedSessionIdentity` parser from `collab-notify.ts`, exact equality and harness/pane/cwd evidence. Reject missing expected pins/unknown native identity or cwd on an effectful path; do not accept arbitrary substrings or infer identity from names. The existing test using `/sessions/<id>.json` while claiming `sessionKind='id'` is not a valid native representation; use the actual supported kind and path syntax.

`binding_digest` and `target_agent` remain merely carried fields: the concrete controller never validates a task binding or checks that its configured target is the admitted task participant. Wire an explicit bounded task binding reference plus digest through request/config/controller, verify participant/session/cwd/pane/name and current actor/caller evidence, and reject mismatches. This was part of the original grouped review, not optional deferred hardening. Treat genuinely current model/provider changes separately from identity. Recheck task authority after the awaited live lookup immediately before prompt, so the bootstrap late-CANCEL bug is not repeated inside recovery.

## P1: sidecar directory check does not protect reservation file updates

The repaired static `.recovery` symlink test passes. However, replace the already-created reservation **file** with a symlink to an outside sentinel during injected retry backoff. `persistReservation(..., false)` uses `openSync(file, 'w')`, follows the link and overwrites the sentinel; a second controller call also occurs. The new reproduction observed `calls=2`, outside sentinel overwritten. Parent directories are only checked for directory type, not anchored inode identity, so replacing a sidecar with another real directory is also not detected.

Anchor sidecar directory and reservation-file identities across the operation. Use bounded no-follow descriptor reads/updates, verify descriptor/path identity before writes and effects, and refuse known replacements without overwriting outside paths. Preserve the original task anchor through inspection and effect boundaries. Catch persistence failures as structured blocked/unknown outcomes; never throw out of a host callback after an uncertain issued effect. Do not write a blocked/final receipt through an unsafe path. Parse the complete reservation/cause/journal/final schema, not only schema/key/three cause fields. Preserve conservative unknown behavior for malformed/truncated records and no OS race-fence claims.

## Continue as one complete repair

Keep the repaired cause dedup, per-attempt intent/outcome journal, exception-as-unknown, coordinator-versus-writer identity distinction and cause-aware event triggering. Fix the remaining related acceptance gaps in the same nine-file ownership and return one functional REPORT. Runtime refresh and scoped compile/test repairs continue autonomously; no model revert, preparation-only report or full campaign. Provide A a stable interface notice if binding/effect-guard fields change. Source scope remains disjoint from A's bootstrap/router. The prior four fixes are credited and do not require redesign or repeated unchanged verification beyond the affected regression run.
