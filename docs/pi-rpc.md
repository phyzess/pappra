# Pi RPC collaboration

`pappra collab run --controller pi-rpc` is the "one host directs, Pi executes" path: the
calling agent (Codex, Claude Code, a script) prepares one bounded task with `pappra collab
prepare`, then pappra admits and launches an owned Pi RPC child that does the work. It is
independent of any host lifecycle hook.

```sh
pappra collab prepare --goal goal.json --domain-root /abs/domain --json
pappra collab run --prepared /abs/domain/tasks/<task>/p10/prepared.json \
  --capabilities card.json --controller pi-rpc < commands.jsonl
```

Prerequisites:

- an absolute shared domain root; the task lands in `<domain>/tasks/<task_id>`
- a goal (`pappra/collaboration-goal/1`) whose assignee is `harness: pi`, `surface: rpc`
- a capability card (`harness-collab/capabilities/1`) with `evidence_level: runtime`,
  `observed_at` within 30 minutes, and assignee fields matching the goal
- Pi on `PATH` with a working provider configuration

The controller spawns `pi --mode rpc --session-dir <task evidence>/pi-sessions
--session-id <contracted id>` and records `evidence/pi-rpc.{proof,rpc,execution}.*` plus the
native session file under the prepared task directory. A `finish` command must match the
native result status; a mismatch is refused rather than reported as success.

## Deadlines and bounded evidence

Single RPC responses have a 15-second deadline (configurable from 1 to 60,000 ms).
This covers commands such as `get_state` and prompt acceptance, not completion of the
model's task. The task has its own 30-minute deadline, configurable up to 24 hours:

```sh
pappra collab run --prepared prepared.json --capabilities card.json \
  --controller pi-rpc --rpc-request-timeout-ms 30000 \
  --rpc-operation-timeout-ms 7200000 < commands.jsonl
```

Normal completion waits for `agent_settled` within the remaining task budget. Cancellation
keeps a separate short settling limit (15 seconds by default). On task expiry the owned
RPC child shuts down even if the caller stops issuing commands. Shutdown still uses bounded
EOF, TERM, KILL and stream-close waits; it never claims to stop arbitrary descendants.
`PiRpcController` accepts the same `requestTimeoutMs` and `operationTimeoutMs` settings in
its constructor. Lower-level `startOwnedPiRpc` callers can also set `settleTimeoutMs` for
cancellation, or supply an explicit timeout to `awaitSettled` for an individual wait.

Streaming output is bounded per JSONL frame (16 MiB by default, configured by `maxBytes`),
not by the cumulative bytes of a long task. The transport retains at most 256 recent records
and 1 MiB of history; a separate minimal `agent_settled` marker preserves lifecycle evidence
when noisy events evict history. It processes responses immediately and permits at most
4,096 requests per owned handle. A response to a known expired request is recorded as late
and ignored; the original request failure remains visible. Unknown response IDs still fail
the transport.

The RPC JSONL evidence file keeps a bounded prefix (16 MiB by default, configured by
`maxLogBytes`). Reaching that budget does not kill the task. Execution and proof files
explicitly record `rpc_capture.log.complete: false`, omitted record counts, stdout byte
counts, history eviction and retained sizes. The returned evidence also exposes
`events_complete` and `events_omitted_records`; a partial log must not be described as a
complete execution trace. Native session history remains separate evidence. Stderr capture
is independently bounded and reports truncation. Both byte-limit overrides are capped at
256 MiB; one oversized frame still refuses the transport and stops the owned child.

## Pi 1.3.0 lifecycle notes

Two behaviours changed from the version the original protocol was written against:

1. **The session file is created lazily**, on the first persisted message. Identity binding
   therefore verifies the reported session id before the prompt and requires the file header
   immediately after it (bounded retry while the writer flushes).
2. **The current-result baseline must be sampled before the prompt**, not after it. The
   controller now takes the byte offset from the RPC handle; sampling after the prompt hid
   the assistant message and produced `finish status does not match the native result`.

## Verification (2026-10-20)

A real task was prepared and run on this machine (`deepseek-flash` provider):

- `collab run --controller pi-rpc` exited `0` with `started` and `finished` events
- the Pi session recorded the user prompt and the assistant answer `COLLAB_OK`
- `evidence/pi-rpc.execution.json`: `status: exited`, `exit_code: 0`, `header_bound: true`,
  `identity_status: match`, `identity_confirmed: true`
- the published report is `results/work-a1-*.json` with `status: completed` and
  `classification: applied`

This is a deterministic, no-fixture proof that the Codex/Pi split works end to end; it does
not imply host hook wiring (see `docs/host-plugin-validation.md` for that surface).

## Offline transport verification (2026-10-24)

Pi 1.4.0 also passed a local RPC load/status smoke with an isolated temporary HOME,
configuration directory, working directory and session directory. Startup used `--offline`
and disabled extension, MCP, skill and context discovery. A single `get_state` returned
the requested session ID and `isStreaming: false`; closing stdin produced exit code 0.
No prompt or external model request was sent. This verifies the installed binary's local
RPC protocol and orderly EOF behavior; it does not validate paid model execution.
