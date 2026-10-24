# Managed lifecycle follow-up acceptance

Date: 2026-10-24. This follows the [v5 integration acceptance](managed-session-v5-acceptance.md)
and separates actual process death from SDK disposal, input admission from model
execution, and historical investigation from new diagnostic evidence.

## Controlled native recovery and network diagnostics

The final isolated campaign is
`/private/tmp/pappra-v6-container-resume.HRY5Rz/acceptance.json` (`ok: true`).
Its private `harness/` directory retains the native runner and container helpers.
These are local opt-in acceptance tools, not shipped JavaScript source or public
runtime APIs. Production changes and regression tests remain strict TypeScript.

The campaign used a fresh visible Herdr pane, pinned Pi SDK 1.4.0, OpenRouter
`openai/gpt-6-luna`, a real registered Task/Assignment and a claimed output. It
detached every network interface from its dedicated Linux container; the host
machine network, user sessions and global configuration were unchanged. Only the
existing OpenRouter credential entry was copied inside the disposable container;
credential bytes and control descriptors were excluded from exported evidence.

Observed sequence:

1. A genuine warmup turn persisted native history and a complete-idle checkpoint,
   including the same-boot/PID-namespace identity.
2. The owned source process, PID 72, was SIGKILLed. The supervisor awaited its
   actual OS exit before starting the new process, PID 243.
3. While still offline, controlled recovery reopened the exact native UUID
   `91cc72aa-f338-4a40-a9a2-87f96b6b17b1`. It made zero provider calls; redelivery
   of the old registered warmup pointer was a duplicate and made no new call.
4. After network restoration, the original Assignment caused real native tools
   to write `NETWORK_RESTART_OK`. The assistant completed normally and a new
   checkpoint was persisted. The test did not manufacture Task acceptance.
5. After a second disconnection, a new provider request was admitted and the
   process was killed before its outcome was known. A third resume exited with
   refusal before opening an SDK control endpoint or replaying inference. Session
   identity, claims and authority epochs were preserved.
6. The exact campaign container, bridge network and visible pane were removed;
   all three cleanup receipts are true.

The actual native calls recorded HTTP 200 and response-header latencies of
1515.147, 1258.447, 738.387 and 610.309 ms. HTTP request-ID headers were absent
and remained null. Native terminal observations retained safe OpenRouter
generation response IDs and total provider-call timings separately.

A separate fresh, unauthenticated transport probe inside the disconnected
container exercised the same diagnostic fetch helper and captured
`EAI_AGAIN`, errno `-3001`, syscall `getaddrinfo`, in 29.876 ms. Its evidence
explicitly says `native_runtime: false`; it is not represented as a failed native
inference or an explanation of the historical incident.

Earlier failed campaigns remain private evidence. They exposed empty Herdr
admission output, delivery before TUI readiness, separate control/journal run IDs,
normal Pi transcript mode 0644, cold native binary downloads and an unresolved
pooled connection. They were corrected without editing ready cards, rewriting
accepted authority or replaying an uncertain request. Earlier passing campaigns
`lJBeaU` and `cBY6Bx` do not substitute for this final host-identity-aware run.

See [controlled resume](../managed-pi-resume.md) and
[minimal provider diagnostics](../managed-provider-diagnostics.md) for the
supported API and explicit limits.

## Controller restart and role scheduling

`/private/tmp/pappra-v6-role-controller-restart.kElyBI/restart-acceptance.json`
records native role acceptance after actual dispatcher death. PID 49639 received
SIGKILL through its owned child handle and its OS exit was observed at
09:26:40.030 UTC. Replacement PID 58182 started at 09:26:40.400 UTC over the
same request, task root, journal digest, round 8 and three reserved actions.
The limits stayed at 16 rounds, four actions and one attempt. There was no
coexistence interval or budget reset.

The two writers had both started real native tools before the kill and their
execution intervals overlapped. Planner, both writers and reviewer each received
one registered Assignment and started one native agent execution. The reviewer
started only after both writer REPORTs and coordinator acceptances were
registered. The final aggregation accepted all four nodes. All five campaign
panes were stopped and closed. Cleanup reconciliation separately records a root
container campaign pane that existed in the baseline and was independently
closed by that parallel campaign; it is not silently called an intact baseline.
The original acceptance JSON is retained unchanged; the separate
`post-run-cleanup-attribution.json` records all five session PIDs absent, empty
stop blockers, role panes gone, and the independently owned baseline difference.

The earlier `OtjOqp` campaign proves real SIGTERM handler exit and replacement;
it is not counted as SIGKILL acceptance. `NgL4uv` observed SIGKILL but stopped on
a stale graceful-exit assertion before replacement, so it is also not a complete
restart pass. Failed artifacts remain available.

An earlier late capability-card refresh correctly caused the final dispatch
guard to refuse with `pinned_dispatch_inputs_changed`. No native work was sent.
The harness now waits for current stable capability evidence and fails promptly
on terminal blocked dispatch. It does not bypass the immutable dispatch pins,
clear durable intent or infer that a pane with no input has crashed. Automatic
reconciliation of such a refused intent remains a separate operational concern.

## Pane ownership and cleanup

The initial audit found 28 old test panes in workspace `w3`, alongside the active
root pane. `/private/tmp/pappra-v6-pane-audit.xs9Gn8/acceptance.json` records closure
of 27 idle campaign shells after exact terminal/cwd/process checks.

The remaining old pane, `w3:p1B`, held the live successor from the v4 single-handoff
campaign. That old test had stopped its source but never performed final successor
cleanup. It was not evidence that the successor had exited and resurrected. The
root authenticated its owned SDK endpoint, stopped it, observed actual host exit
and closed that exact pane. The same procedure retired the completed connection
investigation worker; receipt:
`/private/tmp/pappra-v6-owned-stop.SnMHbF/acceptance.json`.

The SDK-exit worker was first stopped with actual host exit observed, while its
pane remained available to a concurrent harness baseline. After that harness
finished, the exact idle shell/terminal and absence of child processes were
rechecked before closure; receipt:
`/private/tmp/pappra-v6-retained-shell-close.fFpI8z/acceptance.json`.
The final controller implementation worker was also stopped idle, its actual
host PID 28886 was observed exited, and its exact pane was closed; receipt:
`/private/tmp/pappra-v6-owned-stop.qsbGJ4/acceptance.json`.

SDK disposal alone does not prove host-process exit. New cleanup requires an
owned stop/quiescence receipt plus current process and terminal identity checks;
one failed stop does not prevent cleanup of independently proven safe panes.
Normal Herdr code-zero/empty-output responses are treated as admission only.
Read-only process-info timeouts have one bounded retry; mutations are never
retried on that basis.

## Historical connection investigation

The two named sessions retained only generic `Connection error.` outcomes with
empty assistant content and zero usage. Their later aborts were coordinator
actions. No saved errno, HTTP status, request ID or nested cause identifies the
original DNS/TLS/proxy/upstream failure. This limitation is preserved in
[the investigation](pi-connection-errors-v6.md); the new instrumentation captures
future evidence rather than inventing a retrospective root cause.

## Verification

The central regression exercised **950 tests** in 639.7 seconds: 931 passed,
16 failed and three skipped. All 16 failures were confined to two CLI files'
isolated TypeScript compilation while the acceptance test helper was being
integrated. The log is `/private/tmp/pappra-v6-full-tests.log`; it is retained as
a failed run, not relabeled as an all-green run.

After integration, both affected CLI files and all new/changed lifecycle,
diagnostic and acceptance-helper tests passed together: **54/54**, zero failed or
skipped, in 14.8 seconds. Log:
`/private/tmp/pappra-v6-final-affected-tests-verified.log`. This rerun covers every
failed case from the full matrix. The helper conversion's interim missing boolean
returns were also fixed and included in this final pass. Product behavior did not
need to be changed to resolve the CLI compilation failures. The remaining full
matrix tests had already passed; no second full-engine run is claimed.

The three full-run skips were the absent-CodeGraph branch when the engine is
installed and two explicit opt-in native outage scenarios. The isolated native
network and process-death acceptance above was performed separately.

Strict TypeScript, source-language policy, formatting and whitespace checks
passed. Package smoke passed with **418 files**, including installed ESM/API,
the recovery/transition bundle, durable self-install, owned cleanup with edited
file/user-content preservation, isolated workspace lifecycle with spaces/Unicode,
and the selected-project walkthrough that preserves the real checkout. Log:
`/private/tmp/pappra-v6-package-final.log`.

## Supported boundary

Controlled resume is explicit, same boot/PID namespace, same native session and
immediate task scope; a Herdr-hosted source retains its pane. It requires verified
old-process death and a complete-idle checkpoint with current task permissions.
It does not adopt pre-upgrade histories, cross-machine sessions or unresolved
effects. No physical-host airplane-mode or machine-reboot acceptance is claimed.
Arbitrary external writers and unowned descendants remain outside SDK ownership.
