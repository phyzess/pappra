# C4 task/resource review — round 1

Decision: changes requested for two reproduced public-result defects. The original source scope and existing authority primitives remain unchanged.

## Independent evidence

- REPORT `msg-c4-task-resources-report`, notification SHA-256 `93ac4a0d5825902566039964a510d893517d8d49a463e49aed4b47614c358ec7`: identity/correlation/epoch, pinned assignment/input and all output digests verified.
- All 40 current manifest files match `sha256:f84e8f7d6ada31aeb381eae95ae5d9121f49a283dfe5576157f366f8f689551f`.
- Independent type checking and 12 focused C4 tests passed. The earlier excluded reliability patch passes its reverse-apply check and remains separately unaccepted.
- Source review covered namespace inspection, state projection, domain resource listing, plan/apply separation and core claim/release reuse.
- Reproduction driver `/tmp/pappra-c4-repros.mjs`; latest fixture domain `/private/tmp/pappra-c4-review-BZuDlQ`. All mutations were fixture seeding in fresh temporary domains, with no live task claims changed and no model/Herdr prompt sent.

## R1 — P2: doctor calls unresolved uncertainty ready

`doctorTaskState` counts only `severity: invalid` when deriving `ok`. With one unresolved `session_unobserved` uncertainty, the installed CLI returns `ok: true`, exit 0 and human output describes the task as ready, even though findings contain `open_uncertainty` / severity uncertain. This violates the approved conflict/uncertainty exit-1 contract and can mislead the next agent.

Keep the existing diagnostic findings and cooperative semantics. Derive a needs-input result for unresolved uncertain findings and explain the distinction from merely observing an active live lock. No repair, native query, release or state transition is authorized by doctor. Update counts/human wording consistently and add installed-route tests for unresolved uncertainty and interrupted transaction/dead-lock evidence. A clean fixture should still exit 0; no diagnostic command may write state.

## R2 — P2: resource output cap is per task rather than global

`listTaskResources` slices each task's claims to 500 but admits up to 100 tasks. Two tasks with 300 claims each return 600 claims despite the reported/documented 500-claim output bound. `truncated: true` is reported even though no claim was omitted in that reproduction.

Apply one remaining-claims budget across displayed tasks, preserve full counts separately, and mark truncation based on actual omitted rows. Keep task and unreadable-task caps explicit. Add a multi-task regression that asserts total emitted claims never exceed 500, counts retain all 600, actual omissions are indicated, and listing leaves all task/domain bytes unchanged. Preserve stable existing ordering; no new paging system is needed.

## Process deviation

The report candidly states that its fresh runtime observation and C4 preflight were recorded after source editing began. The later result is not retroactive proof of a pre-write gate. Record the deviation; do not fabricate a timestamp or claim original admission ordering was met. This does not expand source permissions or justify discarding user work.

Before the repair's first source write, run readiness against the new pinned repair assignment using a still-fresh actual same-session card or a genuine refreshed observation when needed. Persist that result first. This is a procedural correction within the already authorized task, not an added user approval gate or a new capability subsystem.

## Repair scope

R1/R2 and corresponding focused regressions only. Preserve C0-C3 and excluded reliability files, existing native session/claims, and coordinator plan/review ownership. Update product guidance only where these public result semantics need correction. Report a current manifest/pinned input revision plus the pre-write check evidence; send one proactive product REPORT/notification without waiting, polling or native fallback.
