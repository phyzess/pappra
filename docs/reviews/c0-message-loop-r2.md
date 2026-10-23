# C0 independent review — round 2

Decision: changes requested for two residual cases within R1 and R5. The original session-substring, concurrent-retry, stale-caller and async task-symlink reproductions now behave as required. No downstream reliability/init work resumes yet.

## Evidence and independent validation

- REPORT `msg-c0-repair-r1-report`: notification digest, sender/recipient sessions, parent assignment, task/subtask/attempt/epoch, input revision, assignment and all output digests verified.
- All 18 current files match the fixed-file manifest `sha256:6c320de3c64eefa45fe4a4a5e8115a0cbfada9bcc69e2a7d5807eb9d64f2a9a1`.
- Independent type checking passed; test sources compiled; focused tests: 23 passed, 0 failed.
- The broader collaboration/CLI/MCP/skill-mirror/task-pin regression selection passed independently: 84 passed, 0 failed.
- The original excluded reliability patch still passes its reverse-apply check.
- Pi's reproduction driver was rerun independently. New independent driver: `/tmp/pappra-c0-r2-review.mjs`; evidence root `/private/tmp/pappra-c0-r2-aaLKY7`. Fake transports only; no native prompt was sent by these reproduction drivers.
- The incoming REPORT has a persisted product delivery record with one submitted reservation. This proves the participant-to-coordinator wakeup path, with native recipient session reported as unknown; it does not prove independent task acceptance.

## Remaining findings

### R1 residual — P2: the task-local domain may still be a symlink

`openMessageTask` checks the task root and original `tasks` parent, but calls `resolveRealpath(domainCandidate)` without checking the domain itself. A symlink `alias-domain -> real-domain` followed by `openMessageTask(alias-domain/tasks/smoke)` returns success. This contradicts the required private-namespace boundary, code comment, and repair report's assertion that the domain is a real directory.

Check the original domain entry before canonicalization; refuse its symlink or special-file form. Preserve supported system aliases above it, including `/tmp` and `/var`. Add a regression that demonstrates refusal and no writes, plus a valid system-alias case. Do not broaden into a new filesystem framework.

### R5 residual — P2: every unknown error code is classified as a definite refusal

`refusalStatus` treats every code except two timeout codes and `agent_blocked` as `refused`. The independent command-runner reproduction returns a spawned process with exit 1 and JSON `{error:{code:"connection_lost_after_write"}}`; the result is `refused`. An unrecognized future code does the same. A parseable error envelope does not prove the command stopped before submitting.

Use an explicit, evidence-backed set of recognized pre-submission refusal codes. Unknown codes remain `unknown`, with the diagnostic preserved and no automatic resend. Test unknown JSON errors as well as known blocked/refused and timeout cases. Do not infer submission certainty from exit status or JSON shape alone.

## Follow-up scope

Complete only these two residual cases and meaningful regressions in the same visible Pi session, preserving previous source exclusions and protocol compatibility. Refresh receiving-runtime evidence/preflight before source writes. Report an updated manifest, pinned input revision and validation through the persisted message path, then notify once without `--wait`.

Both corrections remain within the authorized local repair. Continue based on concrete progress and risk, rather than a fixed round count. Escalate a real scope, authority or design decision; do not create an automatic approval gate for another small reversible correction.

## Delivery boundary observed during follow-up

The product persisted `msg-c0-repair-r2-assign`, but product notify refused with `herdr_caller_unverified` / `caller_unresolved`, attempts 0, and no native submission. This coordinator process retains stale inherited Herdr IDs. Explicit `herdr pane current --pane w3:p1` and live agent metadata verified the current coordinator and exact existing Pi session before a single native pointer notification was used as a recorded bootstrap fallback. No environment IDs were forged, no focused-pane fallback was used, and no product delivery receipt was fabricated. A supported recovery route for this stale-caller case remains part of subsequent collaboration routing work; current C0 does not establish fully restored bidirectional product routing for this process.
