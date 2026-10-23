# C0 independent acceptance

Decision: accept the C0 persisted-message and one-shot notification slice. This is not acceptance of full collaboration parity or the excluded reliability patch.

## Reviewed delivery

- REPORT: `msg-c0-repair-r2-report`, notification SHA-256 `0be4d98bd13410b1c667b39f495c03c94fbcaa2187ffe7d703483253aff1d75f`.
- Task, native sender/recipient sessions, parent assignment, subtask/attempt/epoch, assignment digest and input revision verified.
- Report, runtime-preflight and manifest digests verified. All 18 current file hashes match manifest SHA-256 `8dc1e0f7d04cca846d07561acebc1dae1c1bd93ef3a2bd37dc00c15b68d8d727`.
- Receiving-runtime preflight reports ready at `2026-10-21T01:44:18.040Z`, with cooperative resource ownership explicitly unenforced.

## Independent verification

- Type checking passed; test sources compiled; 26 focused tests passed, 0 failed, including installed-CLI coverage.
- Independent residual reproductions refuse the task-domain symlink, preserve unknown submission outcomes for unknown JSON error codes, and retain the recognized pre-submission refusal classification.
- Driver: `/tmp/pappra-c0-r3-review.mjs`; reproduction evidence: `/private/tmp/pappra-c0-r2-LkclPI`. The driver uses fake transports, with no native prompts.
- The prior review independently passed 84 broader regression tests before the final two narrow corrections. Pi reports 87 passing on the final revision, build, package verification and source-policy checks; those final broader commands were not independently repeated.
- Earlier reliability patch still passes the reverse-apply check and remains separately unaccepted.

## Accepted scope and remaining work

Persisted send/list/read, explicit pointer-only Herdr notification, bounded reserved retries, honest ambiguous outcomes and installed guidance are accepted within the documented cooperative filesystem boundary. Persisted, submitted, consumed, reported and independently accepted remain distinct.

This participant has proactively notified the coordinator through the product. The coordinator's inherited stale caller environment still causes product notify to refuse correctly. A previously documented explicit native bootstrap notification was needed in the reverse direction. Full bidirectional recovery is not established. The next slice must determine a supported caller-recovery route from current process/pane evidence; no focused-pane inference, environment spoofing, hidden participant or second writer is permitted.

Capability-evidence derivation, standalone preflight, broader authority operations, portable bindings and native lifecycle parity also remain open. Init/knowledge and reliability work remain queued behind collaboration restoration. No commit, publication or global change was made.
