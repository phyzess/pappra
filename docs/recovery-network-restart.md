# Controlled network and process-restart recovery tests

`tests/collab/recovery-network-restart.test.ts` exercises the existing public
`executeRecovery` API against a test-only controller that uses real TCP sockets
on `127.0.0.1`. It complements the executor unit tests with process boundaries
and transport-level fault injection. The fixture does not call OpenRouter,
Herdr, or any external host, and it does not read credentials or alter machine
network settings or running agent sessions.

## Scenarios

- **Admitted dispatch, then disconnect and process loss.** A loopback service
  reads and durably logs the complete recovery-wake frame, then destroys the
  TCP socket without an acknowledgement. The controller worker observes socket
  closure and exits before returning to the executor, leaving the executor's
  already-persisted intent unresolved. A second, distinct controller process
  invokes `executeRecovery` against the same task sidecar. The executor reports
  an actionable `unknown`, requires supported observation/reconciliation, and
  does not call the controller or redeliver the effect.
- **Known pre-dispatch failure.** The first connection targets a just-released
  loopback port and receives `ECONNREFUSED` before the TCP `connect` event; the
  fixture verifies that no request bytes were sent. Only this supported
  no-effect observation permits a bounded retry. The test opens the same port
  before the retry, and verifies that only the second attempt reaches the
  service and receives a queue acknowledgement.
- **Ordinary restart with known pending work.** A separate worker process uses
  `executeRecovery` to issue one recovery wake for an eligible pending
  assignment. The task projection remains pending afterward; a queue
  acknowledgement does not create an ANSWER, acceptance, or completion.

The durable JSONL effect log belongs to the fake loopback service, not the task
record. The test inspects it alongside the executor's recovery reservation to
show what the local service admitted versus what the restarted executor can
safely conclude. No exactly-once claim is made: the ambiguous case remains
unknown until supported evidence can reconcile it.

## Scope and execution

Run the focused test from the repository's normal compiled test tree after the
usual test compilation, or include it in the repository test suite. When
isolating validation, compile into a temporary directory outside the repository
and execute only `recovery-network-restart.test.js`; do not use shared `.build`
or `dist` outputs for this focused task. The repository owner is responsible
for the full integration suite.

These tests demonstrate controlled local socket interruption only. They do
**not** reproduce or claim coverage of a real OpenRouter outage, provider-side
queue semantics, TLS/proxy behavior, or external service availability.

## Separate native provider acceptance

The opt-in `provider-network-recovery.test` also has a native SDK branch. Its owned per-request loopback gate first refuses the dispatch before bytes are sent, and the recovery executor persists that known-no-effect result. The executor exits with code 86; a new process resumes the same reservation and budget after OS evidence confirms that the previous executor died. Exactly one gate admission then reaches the real owned Pi SDK and OpenRouter, and acceptance requires the actual final assistant response rather than HTTP 200 alone.

Unknown admission remains non-replayable. An earlier native stream-outage acceptance separately terminated an interrupted SDK process and verified that restart did not resend an ambiguous provider request. These are two bounded cases: successful executor restart with an existing SDK runtime, and conservative non-replay after interrupted native execution. They do not claim a whole-machine network outage or exactly-once provider semantics.
