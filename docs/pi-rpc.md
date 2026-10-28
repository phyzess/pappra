# Pi RPC collaboration

`pappra collab run --controller pi-rpc` is the "one host directs, Pi executes" path: the
calling agent (Codex, Claude Code, a script) prepares one bounded task, then Pappra admits
and launches an owned Pi RPC child that does the work. The child is a process this command
spawned, bound to one frozen prompt; nothing adopts an existing session. The path is
independent of any host lifecycle hook.

## Preparing and running

```sh
pappra collab prepare --goal goal.json --domain-root /abs/domain --json
pappra collab run --prepared /abs/domain/tasks/<task>/p10/prepared.json \
  --capabilities card.json --controller pi-rpc < commands.jsonl
```

Prerequisites:

- an absolute shared domain root; the task lands in `<domain>/tasks/<task_id>`
- a goal (`pappra/collaboration-goal/1`) whose assignee names `harness: pi` — the
  controller refuses assignments for any other harness — with assignee fields
  (agent id, session id, cwd, surface, configuration id) matching the capability card
- a capability card (`harness-collab/capabilities/1`) with `evidence_level: runtime`,
  `observed_at` within 30 minutes, and assignee fields matching the goal
- Pi on `PATH` (or `PAPPRA_PI_BIN`) with a working provider configuration

The run re-validates the sealed assignment bytes before launch. It spawns
`pi --mode rpc --session-dir <task evidence>/pi-sessions --session-id <contracted id>`
and, because the controller always uses the `daily` runner profile, adds no capability
flags: Pi starts with its normal tools and MCP servers. The run records
`evidence/pi-rpc.{rpc.jsonl,execution.json,proof.json}` (plus a bounded stderr log) under
the prepared task directory, alongside the native session file it binds.

The controller reads `pappra/collaboration-command/1` JSONL from stdin and writes
`pappra/collaboration-event/1` JSONL to stdout. Three commands exist:

- `query` — a repeatable read-only native query, recorded through the protocol identities
  read from the registered task before the observation is taken.
- `cancel` — never starts work and never sends CANCELLED. The cancellation intent must be
  registered and applied first; claims stay held.
- `finish` — closes the run. Its declared status must match the native result status; a
  mismatch is a refusal, never a reported success. A run that closes without `finish`
  reports `run_closed`, not completion.

The finish result must be publishable as `harness-collab/native-current-result/1`
evidence: records written after a baseline sampled before the prompt, with the session
file inside the task's private namespace. A run whose transport exits cleanly is not
therefore a task success; only a validated terminal result counts.

## Deadlines and bounds

Single RPC responses have a 15-second deadline, configurable from 1 to 60,000 ms
(`--rpc-request-timeout-ms`). This covers commands such as `get_state` and prompt
acceptance, not completion of the model's task. The task has its own 30-minute deadline,
configurable up to 24 hours (`--rpc-operation-timeout-ms`, 1 to 86,400,000 ms):

```sh
pappra collab run --prepared prepared.json --capabilities card.json \
  --controller pi-rpc --rpc-request-timeout-ms 30000 \
  --rpc-operation-timeout-ms 7200000 < commands.jsonl
```

Normal completion waits for `agent_settled` within the remaining task budget.
Cancellation keeps a separate short settling limit (15 seconds by default). When the task
budget expires, the owned child shuts down even if the caller stops issuing commands.

Transport bounds, all enforced per run:

- One JSONL frame may be 16 MiB (`maxBytes`); a larger frame refuses the transport and
  stops the child. Overrides are capped at 256 MiB.
- History keeps at most 256 recent records and 1 MiB; a minimal `agent_settled` marker
  preserves lifecycle evidence when noisy events evict history. Responses are processed
  immediately, so eviction never delays work.
- At most 4,096 requests per owned handle. A response to a known expired request is
  recorded as late and ignored while the original request failure stays visible; a
  response with an unknown id fails the transport.

The JSONL evidence file keeps a bounded prefix (16 MiB by default, `maxLogBytes`, capped
at 256 MiB). Reaching that budget does not kill the task: execution and proof files
record `rpc_capture.log.complete: false`, the omitted record count, stdout byte counts,
history eviction and retained sizes, and the evidence exposes `events_complete` and
`events_omitted_records`. A partial log must not be described as a complete execution
trace; native session history remains separate evidence. Stderr capture is bounded
independently and reports truncation.

Shutdown is bounded and per-child: orderly EOF, then TERM, then KILL for this exact
child, then a bounded wait on this process's own stdio handles. Descendants that
inherited the pipes are detached, never signalled.

## Identity binding

The run binds the contracted identity before returning a live handle and re-checks it at
every protocol step:

- `get_state` must report the contracted session id; the reported session file must
  resolve, and once bound it may not switch to another path. The file header must carry
  the same id and cwd.
- Pi creates the session file lazily, on the first persisted message. The pre-prompt
  check therefore verifies the reported session id only; the header is bound immediately
  after prompt acceptance with a short bounded retry. The current-result baseline is
  sampled before the prompt, not after it, so the assistant message is never hidden.
- The proof and execution files record `header_bound` and `identity_status`, so a reader
  can tell a bound run from an id-only run.
