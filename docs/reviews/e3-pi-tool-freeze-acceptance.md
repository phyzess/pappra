# E3-B2 acceptance: opt-in in-memory Pi managed-tool barrier

Accepted after R2 within the controller/registration prerequisite scope. REPORT `sha256:84790aeba706f7f8af862043e14fb9925f5f67d773f6c11169ab4a8ebb9d3c99`, participants/reply/attempt/epoch, assignment/input/direction/baseline/output/current two source and nested receiver evidence hashes verified. All four actual installed Pi1.3.0 example/doc hashes match. Coordinator fresh scoped compile `/private/tmp/freeze-r2-review.2gZJrW/build` and18 tests pass.

Independent probes `/tmp/pappra-freeze-r2-review.mjs`, findings `/tmp/pappra-freeze-r2-independent-findings.json`, verify repaired partial/malformed observation handling, defensive state/token snapshots, unsafe allowlist rejection, wrong-session callback rejection and absence of unguarded thaw. The additional old-sequence replay after tool activity now refuses and leaves ready=false; targeted tests also cover allowed/blocked activity, session mismatch, explicit invalidation, exact token replay and strictly newer complete snapshots. No accepted observation fence is lost when readiness becomes unknown.

Accepted hashes:

- `src/hosts/integration/pi-rollover-extension.ts`: `sha256:a5bffab9f2ba115b4c983bd9a4977e9fbdf88b5c2bfbb1e23ae58813aeb28c7a`
- `tests/hosts/pi-rollover-extension.test.ts`: `sha256:148ec4ed18220d939cf5cf2ba6c8a3fff2420f6ce255bc5e63fe92b10409a038`

This is a registered in-memory tool barrier, not live-native quiescence or permission to transfer. It blocks all non-vetted managed tools while latched; background/external processes and effects outside managed Pi tools are not fenced. Readiness snapshots remain caller-supplied and unauthenticated. No authoritative lifecycle/queue/approval producer, durable external control, live extension loading, host installation, session bootstrap/transfer/archive or automatic trigger was verified. Latch and sequence fence disappear on restart/reload and require fresh establishment. There is no thaw or authority-restoring recovery path. Example-based structural compatibility is not validation against shipped SDK declarations (unavailable), and the next adapter must verify actual host loading/events rather than use this status as a stop proof. Packed-consumer evidence for the earlier foundation does not cover these new files.
