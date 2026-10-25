# Managed native Pi sessions

This controller starts a fresh **visible native Pi TUI** that it owns from process launch. It
does not adopt an existing session, switch to RPC mode, or replace the TUI with a log viewer.
The root CLI owns config validation and exposes the lifecycle commands below.

## Request file and CLI

`session start` accepts an absolute JSON config file with this schema:

```json
{
  "schema": "pappra/managed-pi-session-request/1",
  "cwd": "/absolute/project/path",
  "model": "openai/gpt-6-luna",
  "journalPath": "/absolute/private/path/session-ingress.jsonl",
  "controlSocketPath": "/absolute/private/path/session.sock",
  "piBin": "pi",
  "pythonBin": "python3",
  "shutdownGraceMs": 5000
}
```

Required values are `schema`, absolute `cwd`, explicit `model`, and absolute `journalPath`.
`controlSocketPath`, `piBin`, `pythonBin`, and `shutdownGraceMs` are optional. The controller
generates a new Pi session ID; the request cannot select or resume an existing transcript.
`model` is required because the controller passes `--provider openrouter --model <model>`
explicitly.

```text
pappra session plan --config /absolute/request.json
pappra session start --config /absolute/request.json
pappra session status --config /absolute/request.json
pappra session fence --config /absolute/request.json
pappra session stop --config /absolute/request.json
```

`startManagedPiSession(options)` accepts the same launch values except for the CLI-only
`schema` property and returns `ManagedPiSession`. The handle exposes `identity`, `snapshot()`,
`fenceIngress()`, `stopOwnedChild()`, `waitForExit()`, `archiveOriginalTranscript(...)`, and
`close()`. `ManagedPiSessionOptions`, `ManagedPiSessionSnapshot`, `ManagedPiProcessIdentity`,
and exit/receipt types are exported from `src/hosts/pi/managed-session.ts`.

The controller uses normal Pi configuration discovery for the supplied working directory and
inherited environment. It does not pass flags that disable user/project tools, extensions,
skills, MCP servers, settings, or context files, and it does not replace
`PI_CODING_AGENT_DIR`. It adds only explicit OpenRouter/model selection, a generated fresh
`--session-id`, and its small observation extension. Existing Pi extensions and project-trust
behavior remain in effect.

## Owned process and readiness evidence

A stdlib Python PTY bridge gives Pi a real controlling terminal. Its terminal output is
forwarded byte-for-byte to the caller's terminal, and terminal resizing is relayed to the PTY.
The controller identifies the exact Pi child using the bridge PID plus the `pty.fork()` child
PID and a random run ID. The bridge reports that child's exit only after `waitpid()` reaps that
exact PID. The controller never signals a process group or an arbitrary PID; it sends TERM,
then (after a bounded wait) KILL through the bridge to that exact child. It then bounds its wait
for the bridge process separately.

Launch readiness is intentionally split:

- `ownedPiChild: started` means the PTY bridge reported its exact child PID.
- `extensionSessionStart: observed` means the managed extension durably observed Pi's
  `session_start` event with the exact `ctx.sessionManager.getSessionId()` and matching cwd.
- `terminalUiRender: not_observed` is explicit: no screenshot/terminal-render receipt is
  inferred from a process or extension event.

`startManagedPiSession()` returns after the first two observations, not just after a PTY fork.
The transcript may not yet be persisted: the snapshot reports it as `not_observed` until a
session path and matching JSONL header become available. This allows a no-prompt native launch
without pretending a transcript exists.

## Ingress journal and private control endpoint

Every terminal input chunk's SHA-256 digest and byte length are written to the append-only
journal and `fsync` completes **before** the original bytes are forwarded to Pi. Journal records
have monotone sequence numbers and a SHA-256 hash chain. A failed journal write, failed PTY
write, explicit fence, or observed child exit closes terminal ingress; input without a durable
admission receipt is never forwarded. The Pi extension separately records semantic input and
lifecycle metadata. These observations do not prove that every internal or external message
source used the hook.

The journal retains metadata, not terminal keystrokes, prompt arguments or base64 images. SDK
ingress arguments and queued messages are represented by digests and counts. Native Pi
transcripts remain separate native history and may contain user content. The journal and its
companion `.pi-events.jsonl` are created with mode `0600`; the controller does not log its
control token.

`SIGTERM` and `SIGHUP` immediately fence ingress and restore the previous terminal mode, then
stop the owned child with bounded TERM/KILL waits. If the controller dies, the PTY bridge
observes its closed control pipe, sends TERM and escalates to KILL after one second. A closed
PTY master is removed from the read set so it cannot cause an EOF spin.

A mode-`0600` descriptor is written at `<journalPath>.control.json`. It contains the private
Unix socket path, bearer token, run ID, and generated session ID. The socket is mode `0600` and
accepts only authenticated `snapshot`, `fence`, and `stop` commands; it has no PID-adoption
operation. The token is not part of `ManagedPiSession.identity`, stdout, or journal records.
`requestManagedPiControl(descriptorPath, action)` is the supported client helper. The CLI may
derive the descriptor path from `journalPath`.

## Explicit Pi SDK 1.4.0 mode

The PTY mode above remains the default and retains its conservative `unknown` inventory. Root
integration may explicitly select `runtime: "sdk"` and pass `sdkModulePath` to
`startManagedPiSdkSession({ cwd, model, journalPath, sdkModulePath, sessionId? })`. The path
must be absolute and load the exact `@earendil-works/pi-coding-agent@1.4.0`; the module checks
`VERSION`, required exports, and source hashes for its pinned session, interactive-mode and
compaction implementations. An older SDK or a mismatched 1.4 build is refused;
there is no ambient fallback or global install/update.

The SDK runtime uses normal `createAgentSessionServices` resource discovery and appends Pi
1.4.0's `createCodemodeExtension()`, `createToolSearchExtension()`, `createMcpExtension()`, and
the managed observer through `DefaultResourceLoader` extension factories. This keeps standard
settings, extensions, skills, MCP, tools, and context files available. The mode is native
`InteractiveMode`, not a PTY/RPC/log-viewer substitution. For ordinary fresh startup, an
optional coordinator-supplied `sessionId` must be a UUID and absent from
`SessionManager.list(cwd)`; it is passed to `SessionManager.create(cwd, undefined, { id })`.
With no supplied ID, Pi generates a fresh ID. Reopening an existing transcript requires the
separate verified [controlled resume](managed-pi-resume.md) admission; a supplied UUID alone
cannot authorize it. The `session_start` observer publishes the exact native ID/cwd/session
file before the JSONL session header necessarily exists; do not synthesize a transcript path or
wait for a model prompt to publish readiness.

`ManagedPiSdkSessionController` exposes `observe()` (`native`, current `cwd`, actual context
usage percent), `subscribe(listener)` (native `agent_settled`, queue, tool and
session-replacement events with a snapshot), `inventory()`, `captureSummary(causeId)`,
`fenceIngress()`, `quiesce()`, and `stopOwnedRuntime()`. `captureSummary` stops terminal
ingress, fences, bounded-aborts, and requires scoped-quiescent state before it calls the real
`AgentSession.compact()`, returns its exact summary and source `sessionFile`, and reports
`complete: false` because the model summary is lossy. Root may separately retain and verify the
complete immutable native JSONL transcript; that artifact, not the summary flag, establishes
structural checkpoint completeness.

The SDK-owned inventory is complete only for the pinned Pi 1.4.0 runtime contract. In addition
to public steering/follow-up payloads, the version-pinned adapter validates and snapshots
session next-turn/custom/bash queues and deferred settled actions, TUI
pending-user/compaction queues, extension dialogs, active selector state, `ReadonlySet` pending
tool-call IDs, and active session/bash state. Missing or wrongly-shaped private fields become
`unknown`; an empty inventory is never inferred from absence. `InteractiveMode.stop()` closes
terminal ingress before bounded abort/idle observation. The public `AgentSession.bindExtensions()`
UI context is wrapped transparently for confirm/select/input accounting. Pending or
unclassifiable UI, queue, bash, or tool work blocks scoped quiescence; no pending entries plus a
validated pinned source shape can produce a scoped-quiescent receipt.

Scope is explicitly `pinned_pi_1_4_owned_runtime`: arbitrary external writers, unrelated
processes, and descendants are outside ownership. The SDK controller lives in the host PID; its
stop receipt confirms runtime disposal only and says `process.exit: not_owned`. Disposal removes
observers and closes the journal while ingress/provider gates stay permanently latched. Only the
native summary's asynchronous call context may run the provider during compaction; unrelated
calls remain fenced. An explicit `executionScope` enables authoritative pre-TUI binding and
runtime registration; see [the transition contract](managed-pi-transition-contract.md).
Automatic capture retains the ACK/REPORT/authority guards and does not promote scoped inventory
into global stop proof. After registered successor first work, the CLI can dispose its source
runtime and retain a verified transcript while leaving native history unchanged.

## Snapshot, transfer limits, and archive gate

`snapshot()` reports exact managed process identity and exit evidence, ingress fence/journal
health, observed transcript metadata, and an explicit inventory ceiling:

- queued message payloads: `unknown`;
- pending approvals: `unknown`;
- complete in-flight work: `unknown`;
- external writers: `unknown`;
- descendants: `uncontrolled`.

The default PTY mode's `ManagedPiSessionSnapshot` reports `transferReady: false` with blockers
naming unavailable evidence. This is bounded lifecycle management, not a complete
transferable-quiescence proof. Stopping its owned Pi child does not establish that detached
tools, other extensions, external writers, or other processes have stopped.

The original transcript is never removed by this controller. `archiveOriginalTranscript(...)`
only copies it after the exact source child exit, a caller-supplied receiver confirmation, and a
later caller-supplied first-work observation for the same receiver session. It verifies
transcript identity and hashes before/after copying; it leaves the source in place. The
confirmation/work objects are attestations from the integrating caller, not cryptographically
authenticated by this module. Because external transcript writers are not fenced, the archive
copy remains a best-effort, post-exit retention action—not proof that all source-side activity
has ended.

## Owned SDK task lifecycle

`initialAssignment` enables deferred first-task admission, while a bootstrap receiver binds only
after its verified ownership transfer. The private pending-launch registry is discovery
metadata, not task authority. Registered pointers enter through the authenticated SDK endpoint
after fresh task/message/session/digest checks; an arbitrary prompt cannot be submitted through
that endpoint. Admission and deduplication receipts never claim model completion.

The SDK lifecycle observes real `agent_start`, `agent_end` and `agent_settled`, native tools and
dialogs. Its pinned tool-registry and selection methods schedule coalesced resource
observations, including MCP discovery that completes after TUI initialization. The readiness
consumer derives a new card from those observations without a dummy model turn or operator
edits. Initial task execution remains denied until the real ASSIGN, claims and idle binding
agree; later gates recheck the exact attempt's input revision independently of other parallel
subtasks.

Control command envelopes remain limited to 8 KiB. Responses have a separate 1 MiB bound for
native inventory; automation snapshots expose compact transition status instead of embedding an
entire handoff report. The private SDK API does not adopt arbitrary PIDs or forward unregistered
text.

[Controlled resume](managed-pi-resume.md) can reopen a checkpointed task-owned SDK session after
verified process death, retaining registered-input deduplication and current task permissions.
[Minimal provider diagnostics](managed-provider-diagnostics.md) retain bounded transport errno,
timings and supplied request/response IDs in the private journal without logging request bodies
or credentials.

`automaticHandoffFile` can drive native summary, verified context import, receiver ACK, actual
scope/route transfer, first work, runtime disposal and digest-verified transcript retention. A
`running` handoff-first-work marker does not complete the task. A successor's future handoff
waits for its predecessor's actual disposal and retained-transcript receipt.

## Bounded observation: root-run Pi 1.4 native launch

One controller-owned visible session was launched with Pi 1.4, OpenRouter
`openai/gpt-6-luna`, retained daily skills/extensions/MCP/configuration and the configured
default thinking level. No model prompt was submitted.

The run fenced terminal ingress at journal sequence 10 and then stopped the exact Pi child with
exit code 0 and a zero exit code from the helper. The durable journal recorded
`owned_pi_child_exited` at sequence 11 and the pane returned to its shell. Session identifiers,
process ids and evidence paths from that run are retained privately and are not part of this
page.

That observation covers launch, controller ingress/fence, and exact owned-child exit only. It
does **not** establish complete queue/approval/in-flight inventory, external-writer fencing,
descendant termination, or full-transfer readiness; the controller continues to report those as
unknown/uncontrolled.
