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
