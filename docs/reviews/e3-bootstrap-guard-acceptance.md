# Bootstrap guard acceptance

Accept the R2 opt-in managed-tool bootstrap gate within its trusted-reader dependency boundary. It is not installed, does not authenticate its injected reader, does not prove old-writer stop and does not implement complete visible rollover or a filesystem/process fence.

REPORT delivery `sha256:01233e84fece5f883abb53ed12573f545d1897438fe96cf4c7054c3b5880c8e2`, reply/session correlation, six output pins, current guard/test and six protected adjacent source hashes plus nested runtime evidence verified. Accepted source:

- `src/hosts/integration/pi-bootstrap-guard.ts`: `sha256:1edc7604e16d7515f25c1e37fe1ba5a81aed65f1c45e912df1259cf8105f1e88`.
- `tests/hosts/pi-bootstrap-guard.test.ts`: `sha256:dd9478308b95b7a4defd8d7be7c20ccf92272405ff91be645a856a8016bb414f`.

Coordinator helper `/tmp/pappra-bootstrap-r2-review.mjs` performs fresh isolated compilation,15 focused tests and12 additional actual-handler reproductions. All15 tests pass, all12 reproductions deny or reject invalid configuration, and the genuine completed-transfer first-write test still passes without a first-work REPORT. Findings `/private/tmp/bootstrap-review.sZUKaY/findings.json`; logs in the same directory.

The gate validates the exact current actionable transferred writer attempt, native binding/input, completed writer handoff metadata, exact original/current claims and resource epochs, ownership snapshot and present transfer-history bounds. It refuses supersession, blocked/unknown ownership, contradictory handoffs, resource conflicts and malformed accessors. Every non-read call revalidates via its trusted reader and rechecks native identity after waiting; no permanent unlock or thaw command exists. This checks permission at callback time, not throughout later external execution. Old no-thaw freeze and event producer remain unchanged.

The next integration prerequisite is a real bounded local task-record reader and explicit registration glue. Existing package/full-suite/native-loader evidence does not automatically cover this guard or its later runtime reader. Preserve those distinctions.
