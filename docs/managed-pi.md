# Managed Pi

How Pappra owns a native Pi session: start, admission, resume, transition and diagnostics.

- [Managed native Pi sessions](#managed-native-pi-sessions)
- [Managed Pi initial task admission](#managed-pi-initial-task-admission)
- [Controlled managed Pi resume](#controlled-managed-pi-resume)
- [Managed Pi owned-runtime transition contract](#managed-pi-owned-runtime-transition-contract)
- [Managed provider network diagnostics](#managed-provider-network-diagnostics)

## Managed native Pi sessions

This controller starts a fresh **visible native Pi TUI** that it owns from process launch. It
does not adopt an existing session, switch to RPC mode, or replace the TUI with a log viewer.
The root CLI owns config validation and exposes the lifecycle commands below.

### Request file and CLI

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

### Owned process and readiness evidence

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

### Ingress journal and private control endpoint

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

### Explicit Pi SDK 1.4.0 mode

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
separate verified [controlled resume](#controlled-managed-pi-resume) admission; a supplied UUID alone
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
runtime registration; see [the transition contract](#managed-pi-owned-runtime-transition-contract).
Automatic capture retains the ACK/REPORT/authority guards and does not promote scoped inventory
into global stop proof. After registered successor first work, the CLI can dispose its source
runtime and retain a verified transcript while leaving native history unchanged.

### Snapshot, transfer limits, and archive gate

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

### Owned SDK task lifecycle

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

[Controlled resume](#controlled-managed-pi-resume) can reopen a checkpointed task-owned SDK session after
verified process death, retaining registered-input deduplication and current task permissions.
[Minimal provider diagnostics](#managed-provider-network-diagnostics) retain bounded transport errno,
timings and supplied request/response IDs in the private journal without logging request bodies
or credentials.

`automaticHandoffFile` can drive native summary, verified context import, receiver ACK, actual
scope/route transfer, first work, runtime disposal and digest-verified transcript retention. A
`running` handoff-first-work marker does not complete the task. A successor's future handoff
waits for its predecessor's actual disposal and retained-transcript receipt.

### Bounded observation: root-run Pi 1.4 native launch

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

## Managed Pi initial task admission

`watchManagedPiInitialAdmission` bridges a controller-owned Pi session to its first task-owned execution scope. It does not start or adopt a process, create an ASSIGN, grant readiness, or manufacture native evidence.

### Admission sequence

1. The host supplies the canonical task root and a startup `assignmentFile` preview path. The helper pins that path's parent-directory identity. The preview's contents are advisory only: they may be missing or replaced before the task store admits dispatch, and they grant no authority.
2. The helper waits for a current Task attempt and an applied `ASSIGN` message matching the configured subtask/attempt, owner epoch, coordinator actor, assignee and input revision. The Assignment artifact is reread through the bounded file reader and must match the attempt's exact `assignment_ref` and `assignment_digest`. The `assignment_id` is deliberately not used as the task-store subtask id.
3. It requires the latest active attempt, no pending approval, awaiting state, cancellation or dispatch freeze, and current unreleased claims held by the exact Pi agent/session. Every Assignment resource must match a claim's canonical path, access and (when specified) resource epoch. The scope contains the current claims; the artifact never adds or widens claims.
4. It waits for complete, idle native inventory and calls the real `bindManagedPiExecutionScope`. The supplied callback must complete before the binding is published. A failed callback does not publish a binding, and refreshes are serialized/coalesced.
5. After binding, `canExecute()` rereads the bounded task record and authoritative artifact synchronously, checks the task namespace, attempt/epoch/input/ASSIGN/claim and observed native identity pins, and denies on drift or close. No polling timer is used.

The managed SDK CLI wires this helper through the optional `initialAssignment` request field:

```json
{
  "taskRoot": "/absolute/private/domain/tasks/task-id",
  "assignmentFile": "/absolute/private/role.assignment.json",
  "subtaskId": "writer-a",
  "attempt": 1,
  "ownerEpoch": 1,
  "inputRevision": "sha256:<64 hexadecimal characters>"
}
```

This mode requires a fresh SDK UUID and cannot be combined with an immediate execution scope, bootstrap receiver, or automatic-handoff source. The preview grants no execution authority. A task-local pending-launch entry supports discovery only after authenticated SDK control, OS socket-owner PID and foreground-pane PID agree.

The CLI creates the watcher before native input and gates semantic methods, provider runs and managed tools with the current authority check. Binding the idle runtime records its owned endpoint; task-native execution is confirmed from the real `agent_start`, so an assigned session is not mistaken for an already-dispatched task. Historical retry approval must match its registered ASSIGN; an actual pending approval still blocks. Settlement refreshes admission on the next event-loop turn, after the SDK has finalized idle state.

Startup readiness may precede ASSIGN with zero model input. MCP discovery and tool selection changes trigger coalesced observations of actual native resources and refresh the card without an operator editing evidence. Registered-message delivery rechecks admission before passing the pointer to the owned SDK.

### Test boundary

`tests/hosts/managed-initial-admission.test.ts` uses real local task-store message/claim protocols with a controlled SDK port. Native startup, deferred ASSIGN, actual OpenRouter work and multi-role acceptance are separately recorded in the integration acceptance report; unit fixtures alone are not native evidence.

## Controlled managed Pi resume

The SDK runtime can explicitly reopen the same native session after its previously
registered process has died. This is separate from fresh-session handoff. It does
not replay the previous prompt, pending input, approval, tool, or provider request.

Use the ordinary `pappra session start --config <absolute-file>` command with
`runtime: "sdk"`, the exact existing `sessionId`, a new private `journalPath`, and
the same immediate `executionScope`. Add:

```json
{
  "resume": {
    "sourceJournalPath": "/absolute/private/source.jsonl",
    "sourceSessionFile": "/absolute/native-session.jsonl",
    "sourceRunId": "exact-source-controller-run-id"
  }
}
```

The plan command remains read-only and reports `launch_kind: "controlled-resume"`.
Neither a valid plan nor a JSON configuration grants resume authority. The runtime
must establish all of the following before native session open:

- The original process is absent according to the local OS. A live/reused PID or
  unknown process-death observation refuses admission.
- New checkpoints identify the physical machine, OS boot, PID namespace and process birth.
  On the same machine, a prior boot or a replaced process birth proves the original owner
  is dead even when its PID has been reused. A different machine or inaccessible process
  observation remains unknown; a hostname is never evidence of ownership.
- The original task-owned runtime registration, private control descriptor and
  complete hash-chained source journal agree on scope/session/run identity.
- A versioned complete-idle checkpoint covers the exact native transcript. Known
  private queues, work, tools, Bash and approval paths are idle/empty; any later
  semantic/provider/tool action invalidates it. Native error/aborted outcomes do
  not establish permission to retry an unknown effect.
- The task namespace, latest active attempt, admitted Assignment, coordinator,
  input revision, approval state and exact unreleased resource claims are current.
- One exclusive task-store reservation is established for this exact source run
  and checkpoint. Concurrent reservations owned by a live process are not bypassed.
  Failed startup and normal shutdown release their exact reservation; the next
  attempt reclaims reservations whose exact owner is proven dead before checking capacity,
  including owners from a previous boot. Failed cleanup returns failure without masking
  the original startup/runtime error.

An in-process opaque authorization carries these verified pins to the SDK opener.
The reopened session must retain the same UUID, cwd and transcript. Before native
input is exposed, task-store registration atomically replaces the exact old owned
endpoint with the new one under the reservation. Claims do not move or advance.
Execution gates continue checking authority after startup. Verified registered
input IDs/digests survive the restart, so an old notification cannot start another
model turn merely because the runtime has changed.

This first mode requires one immediate task scope. Deferred initial Assignment,
bootstrap receiver and automatic-handoff startup cannot be combined with resume.
They retain their existing fresh-session contracts. Pre-upgrade journals without
resume checkpoints cannot be adopted. If the source journal is partial/altered,
native outcome is unresolved, or permissions
have drifted, preserve the evidence and reconcile explicitly.
For a Herdr-hosted source, resume stays in its recorded pane and retains the
existing participant binding; it does not silently move a route to another pane.
Journal and native-history reads are bounded at 32 MiB and 64 MiB respectively.
Retirement uses the same 64 MiB native-history limit, so a valid resumed transcript
does not become ineligible for a later handoff at an unrelated 8 MiB ceiling.

The native SDK receives an opaque in-memory resume capability. Its private registry tracks
reserved, registered and revoked state, and invokes the issuer's current task/namespace/
transcript checks at every native admission boundary. Copying or serializing the capability
cannot copy its authority. Issuance is an internal application port, absent from the public
experimental Pi API; the native controller does not import application orchestration.

A session with no real conversation may have no native transcript file: Pi 1.4
does not persist setup/custom entries alone. Such startup does not manufacture a
conversation or a checkpoint. Integration acceptance first runs a genuine bounded
native turn before testing an idle checkpoint.

The ownership boundary remains the pinned SDK runtime. This feature does not
establish that arbitrary external writers or unowned descendants are stopped.

## Managed Pi owned-runtime transition contract

`bindManagedPiExecutionScope` runs before the native TUI admits input. It binds
the controller's live session/cwd to the authoritative task, active attempt,
coordinator epoch and exact held claim epochs. Binding rejects unknown queues,
pending work/dialogs, unhealthy ingress journals and stale identities. The result
is an in-process branded object; serialized configuration cannot create it.

`createManagedPiTransitionHost` fences and quiesces that actual controller. Fresh
version 2 proofs are likewise branded in process and include the binding digest,
controller sequence and journal head. Their explicit scope is
`pinned_pi_1_4_owned_runtime`; arbitrary external writers, unrelated processes
and unowned descendants are excluded. Unscoped legacy requests cannot consume
these proofs. Existing ACK, current authority, claim transfer, registered
first-work and retirement gates still apply.

The SDK CLI opens its private control server and registers the owned runtime
before starting the TUI when an execution scope is supplied. Role repair can
query that registration, verify the control socket's actual OS owner and stop
only the matching runtime. A stop confirms SDK runtime disposal; it does not
claim that the host PID exited.

After authoritative successor first work reaches `task_retired`,
`retireManagedPiSource` stops the owned source runtime and retains a bounded,
identity-checked transcript plus a receipt under the continuity task's
`retired-sessions` directory. It preserves the original native transcript.
Repeated retention requires matching artifacts and a still-disposed controller;
a static receipt alone is not live stop authority. Pi's native history remains
unchanged because the installed SDK exposes no archive operation.

Focused tests cover the real guarded transition with the concrete controller
and test runtime ports, stale/malformed scope refusal, legacy separation,
retirement gates and authenticated stop deduplication. These are not a native
provider end-to-end takeover demonstration. In particular, ordinary bootstrap
still launches native Pi rather than recursively launching another scoped SDK
controller. Repeated automatic managed rollovers and their visible host
recognition remain an integration gap.

## Managed provider network diagnostics

The pinned managed SDK runtime observes its per-request fetch boundary before Pi
AI reduces transport errors to a generic transcript message. It preserves the
configured provider/model, native retry policy, caller-supplied fetch, request
arguments, cancellation signal, original response/body and original error. It
does not replace global fetch, add a probe request or retry a failed effect.

The existing private hash-chained session journal records:

- `sdk_provider_run_admitted`: a local `provider_call_id` correlates one SDK
  provider invocation with its fetch observations.
- `sdk_provider_fetch_started`: a distinct local `fetch_id` for each HTTP attempt.
- `sdk_provider_fetch_response`: HTTP status, latency to response headers in
  `headers_elapsed_ms`, and a bounded remote `request_id` when supplied in
  `x-request-id`, `request-id` or `x-openrouter-request-id`. Missing IDs stay null.
- `sdk_provider_fetch_failed`: elapsed milliseconds, the observed abort-signal
  state, and up to four redacted error/cause entries containing recognized error
  names, errno/code and syscall. Cycles and unusual getters are bounded.
- `sdk_provider_message_observed`: the native assistant message's safe terminal
  reason, total SDK provider-call duration and provider `response_id` when the SDK
  supplies one. An OpenRouter generation ID is a response ID; it is not relabeled
  as an HTTP request-ID header.

Diagnostic records exclude request/response bodies, prompts, full URLs, hostnames,
authorization headers, proxy configuration and raw exception messages. Only the
named request-ID response headers are inspected; secret-shaped or malformed IDs
are omitted. The helper returns the original response without reading or wrapping
its stream, and rethrows the original error. A diagnostic sink failure must not
convert a successful admitted response into a new failed/retriable request; the
managed controller fences future work if its journal becomes unavailable.

Header latency is not total stream duration; message observations separately time
the provider call through its terminal message. Native agent/tool lifecycle
events establish later work boundaries. A stream failure after response headers
may already be flattened by the SDK; preserving the original response stream
means this fetch observer cannot promise an errno for that later failure.
An aborted signal does not by
itself identify whether the user, coordinator, timeout or provider caused an
interruption. Likewise, a diagnostic errno is not an authoritative no-effect
receipt and cannot authorize replay. Recovery still uses its explicit ownership,
checkpoint, task-authority and unresolved-effect gates.

These observations help diagnose a future recurrence of the historical generic
connection errors. They cannot recover details that the original transcripts did
not preserve.
