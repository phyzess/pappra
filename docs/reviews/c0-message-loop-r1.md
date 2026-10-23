# C0 independent review — round 1

Decision: changes requested. The supported message path and proactive product REPORT are useful progress, but the following reproduced failures block acceptance. No downstream reliability/init work resumes yet.

## Reviewed input and validation

- Input: C0 REPORT `msg-c0-report-1`, source manifest SHA-256 `28b332d2380da84b3dbbfa08457e5af0edec846f2c08ed919900f28be5802a5e`.
- Notification, report, manifest and assignment digests verified; all 18 C0 source/artifact hashes matched the manifest.
- The preserved earlier reliability patch still passes a reverse-apply check.
- Independent focused tests: 14 passed, 0 failed. Type checking passed on recheck. An initial check observed transient syntax errors in the excluded install schema; its reread and subsequent check passed, so that observation is not attributed to C0.
- Reproduction driver: `/tmp/pappra-c0-review-repros.mjs`; latest evidence tree: `/private/tmp/pappra-c0-review-C87ygu`. Fake transport only; no model or Herdr prompt was sent by the driver.

## Findings

### R1 — P1: namespace checks are incomplete and can write outside the task

`openMessageTask` canonicalizes before checking the original `tasks` parent, so an alias-domain/tasks symlink into another valid domain is accepted. `readMessageFromTaskRoot` and `notifyRegisteredMessage` use `readRegisteredMessage`, which follows a final message-file symlink without the app service's regular-file/bounded-read guard. A symlink to an envelope outside the task is returned as a registered message.

More materially, `notifyRegisteredMessage` awaits transport metadata after its initial task check. A fake transport can replace the task root with a symlink during that await; `ensureNotificationsDirectory` creates `notifications/` outside the task before detecting the redirect. Reproduction: refused result but `outsideDirectoryCreated: true`.

Required: retain and revalidate the task/domain/private namespace identity before mutations and native submission, including after async seams. Check the original task-local parent chain, while preserving supported system aliases such as `/tmp` and `/var`. Use one bounded, regular-file, identity-checked registered-message reader for read and notify. A final symlink/FIFO/oversized/mismatched message must not become registered content. No outside directory or metadata may be created on refusal. Reuse existing ownership/namespace helpers where practical; avoid another parallel filesystem framework.

### R2 — P1: native session matching accepts a different session

`live.sessionValue.includes(participant.native_session_id)` marks a session match when the expected id appears only in an ancestor directory. Reproduction: `/sessions/worker-session/archive/other-session.jsonl` is classified `native_session: match` and notified for `worker-session`.

Required: preserve reported session kind and compare exact native identity using supported metadata semantics. For Pi paths, validate the actual session identity rather than an arbitrary substring. A binding's null native session must not disable checking an explicit `message.to.session_id` against a reported, different live session. Missing evidence remains unknown; mismatched evidence refuses.

### R3 — P2: concurrent retries lose attempts and exceed the wakeup bound

First delivery reserves with `wx`, but retry reads and atomically replaces existing state without a serialized reservation/revision check. Two simultaneous `--retry` calls both prompt, both append to the same old attempt list, and one count is lost. Reproduction: after three actual prompts the metadata records two; a fourth prompt is admitted despite MAX_ATTEMPTS=3.

Required: serialize/reserve retries for the exact message, preserve every submitted/unknown attempt, and reject concurrent/in-flight retry instead of overwriting another reservation. The limit must hold across processes, including crashes and explicit concurrent retries. Never reclaim a reservation by age or silently delete unknown evidence.

### R4 — P2: a Herdr marker is presented as a verified caller

`createHerdrTransport().availability()` accepts `HERDR_ENV=1` without caller IDs or successful current-pane resolution, then queries agents and can submit prompts. This contradicts the restored legacy environment-routing contract and repeats the stale-caller problem observed earlier in this task.

Required: verify the caller through the installed Herdr caller-resolution surface before inspecting/controlling another agent. A missing/stale/unresolvable caller fails with a specific diagnostic, without falling back to the focused pane or launching another channel. If an explicitly supplied, verified caller binding is supported, define that route and its evidence requirements rather than relabeling an environment flag as verification. Keep caller observation distinct from recipient matching and sender authentication.

### R5 — P2: unclassified spawned transport errors are reported as definite failures

When `herdr agent prompt` spawned but exits nonzero without a recognized refusal envelope, `createHerdrTransport.prompt` returns `failed`. It cannot establish that the prompt was never submitted. Reproduction: a spawned command with exit 1 and `connection lost after writing` is `failed`, despite possible submission.

Required: use unknown for ambiguous post-spawn outcomes; retain definite not-started/unavailable for verified spawn failure and recognized pre-submission refusals for their documented cases. No automatic resend. Tests must cover malformed output, nonzero exit, signal/timeout, and explicit blocked/refused responses without asserting more than the transport proves.

## Repair scope and acceptance

- Repair R1-R5 only, update focused regressions and product guidance where behavior changes.
- Preserve all excluded earlier reliability files and existing protocol/authority constraints.
- Keep the event-driven same-session workflow. Do not start another agent, model configuration, pane, scheduler or polling loop.
- Run focused C0 tests, relevant existing collaboration regressions, type checking, build and formatting for changed C0 files. Repeat package smoke only when changes affect packaged runtime/guidance or the installed route.
- Deliver an updated report and fixed-file manifest. REPORT/notify the coordinator once, then await independent review round 2.
- If the focused repair cannot meet these criteria without a broader design change, send a clarification BLOCK with the concrete alternatives before broadening implementation.
