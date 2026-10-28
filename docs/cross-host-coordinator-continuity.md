# Cross-host coordinator continuity (design proposal)

Status: proposal, not implemented. Nothing here changes behaviour until a phase below lands.

## Problem

A coordinator accumulates context (reports, decisions, claims) over a long cohort. Today
only a Pi session that Pappra owns through the managed SDK is handed over automatically
([automatic handoff](automatic-handoff.md)). For Codex or Claude Code as coordinator the
automation is missing: the session transition request accepts only `harness: 'pi'`
(`src/app/collab-session-transition-request.ts`), the automatic handoff constructs only Pi
identities (`src/app/collab-auto-handoff.ts`), and dispatch derives live evidence only for
Pi. See the correction below: that Pi machinery turned out to be a writer rollover, not the
coordinator path.

The goal is that any supported harness can be the coordinator and still reach every
continuity capability **that the host can honestly support**, with reports saying exactly
which guarantee was and was not obtained.

Non-goals: a role daemon, hooks that start models or write checkpoints, treating
idle/settled/`abort()` as proof that a process stopped
([pi-transition-capability](pi-transition-capability.md) rejects that for good reason),
or inventing identities and capabilities from prose.

## Decompose "handoff" into five capabilities

| # | Capability | Meaning | Pi (managed SDK) today |
| --- | --- | --- | --- |
| 1 | Signal | Observe live context use, decide when to hand off | native context percentage |
| 2 | Capture | Preserve a lossy summary plus the lossless source | native compaction + retained JSONL |
| 3 | Launch | Start a successor of the same harness with the checkpoint imported | managed bootstrap in a visible pane |
| 4 | Fence | Make the old session unable to act as coordinator | epoch transfer (writer rollover also uses a scoped quiescence proof) |
| 5 | Verify | Successor proves first work before the source retires | correlated `handoff-first-work` REPORT |

The first draft planned an adapter seam over the Pi session-transition state machine. The
correction below shows that machine is the writer path; the coordinator path is already
harness-neutral in the protocol.

## Evidence by host

Verified means observed locally in this repository's session; documented means taken from
vendor docs and must be re-checked against the pinned version before use.

### Codex 0.164.0 (verified from `codex app-server generate-json-schema`)

- Signal: server notification `thread/tokenUsage/updated` carries `total`, `last` and
  `modelContextWindow` (nullable).
- Capture: `thread/read`, `thread/turns/list`, `thread/items/list`; `thread/compact/start`
  and `thread/compacted` for native compaction.
- Launch: `thread/start`, `thread/fork`, `thread/resume`, `thread/inject_items`,
  `turn/start`.
- Control: `turn/steer`, `turn/interrupt`, `thread/status/changed`, `thread/queue/changed`,
  `thread/unsubscribe`.
- CLI: `codex queue --thread`, `codex fork`, `codex resume`, `codex agents` (sessions on a
  shared local app-server daemon).
- Hooks: only `SessionStart` is verified at 0.163/0.164; `PostCompact` is unsupported
  ([host validation](host-plugin-validation.md)).
- The repository's transport spawns its own stdio `codex app-server`. Phase 0 established
  that an interactive TUI session is on the shared daemon instead, so a sidecar client on
  that daemon can observe it (see Phase 0 results).

### Claude Code 2.1.308 (documented; items marked [summary] came from a doc summary)

- Signal: the status-line command receives stdin JSON with `context_window.used_percentage`,
  `remaining_percentage`, `context_window_size`, token totals, `current_usage` (null after
  `/compact` until the next call) and `transcript_path`. Hook payloads carry no usage.
  OpenTelemetry exposes token counts but not context size.
- Capture: `PostCompact` input includes `compact_summary`; the transcript JSONL is at
  `transcript_path`, but its entry format is internal and may change.
- Launch: `claude "<prompt>"` starts an interactive session seeded with a prompt;
  `--resume`, `--fork-session`, `--append-system-prompt-file`. A `SessionStart` hook
  (matchers `startup|resume|clear|compact|fork`) can add stdout/`additionalContext`.
- Control: `PreCompact` can block compaction [summary]; `continue:false` stops a turn from
  a tool hook [summary]. **No documented way to send input to, stop, or quiesce a running
  interactive session from outside.** `claude stop` and `attach` apply to background
  sessions only.

### Pi 1.4.0

Unchanged: Pappra owns the SDK runtime, which is why a scoped quiescence proof is possible.

## Correction: what the protocol already provides (read after phase 0)

The first draft of this proposal assumed a coordinator handoff needs a new protocol-level
"fence" step and an adapter seam over the Pi session-transition state machine. Reading the
protocol showed otherwise:

- The Pi session transition (quiescence proof, managed SDK, `rollover`) is a **writer**
  rollover: it moves a worker's claims and attempt to a successor. It is not how a
  coordinator is replaced and does not need generalising for this goal.
- A **coordinator handoff** already exists in the protocol (`kind: 'coordinator'` in
  `src/collab/handoff.ts`, driven by `pappra collab handoff begin|transfer|confirm|complete|
  release-dispatch`). It is harness-agnostic and tested
  (`tests/collab/task-handoff-cli.test.ts`). By design it requires **no stop proof**: "a
  coordinator handoff has no writer process to stop: the freeze plus the captured inventory is
  the barrier". The fence is the owner epoch: `complete` replaces `record.coordinator`, raises
  `owner_epoch`, records `previous`, and freezes dispatch until the new coordinator releases
  it. Old-epoch commands are refused by the epoch checks.
- So the "protocol-fenced" tier is simply what a coordinator handoff is. What matters is that
  Pappra never reports it as process quiescence. The CLI already states
  `limits: cooperative_record_mutation_only, no_native_control`.

The accepted decision 1 therefore needs no new reducer step. It remains the rule for what a
guided workflow may claim.

## The real gap: a mid-cohort handoff strands the cohort

Verified with a throwaway test (deleted afterwards): prepare a cohort, let a writer report,
then simulate what `completeHandoff` does to the record (new coordinator identity, epoch + 1).
The new coordinator's `workflow accept` is refused with `acceptance_stale` and
`plan_epoch_stale`.

Cause: nothing re-stamps state after the epoch moves.

- `attempt.owner_epoch` stays at the epoch the attempt was registered under; acceptance
  requires it to equal the current epoch (`acceptance.ts`).
- The sealed `work-plan.json` carries `owner_epoch`, and the work-plan evaluator requires the
  plan, the accept envelope and the report envelopes to agree on one epoch
  (`work-plan.ts`).
- `workflow prepare` cannot be re-run: the sealed manifest names the old coordinator.

This is independent of the harness. It means a coordinator handoff is safe today only at a
**cohort boundary** (no non-terminal attempt, no completed-but-unaccepted attempt, no open
uncertainty). Mid-cohort, the successor cannot finish the work.

## Revised design

Two levels, in this order.

**Level 0, boundary handoff (needs no protocol change).** At a cohort boundary the successor
can take over with the existing `pappra checkpoint` / `pappra resume`, or with the
`collab handoff` coordinator flow, and start the next cohort under its own epoch. A guided
command should make this the safe default and refuse a handoff that the inventory shows is
mid-cohort, with the exact blocker (non-terminal attempts, unaccepted reports, open
uncertainty, or write claims held by the source). This is a read-and-check layer over
`handoffInventory`; it changes no persisted state.

**Level 1, mid-cohort succession (protocol change).** Needs an explicit, auditable
adoption step after a completed coordinator handoff, run by the new coordinator, that
re-establishes authority over the existing cohort:

- re-derive the work plan under the new epoch from the sealed assignments, bound to the
  handoff id and the transfer inventory digest, never by editing the sealed original;
- re-stamp the epoch of attempts that are still live, with the earlier epoch kept as
  evidence;
- decide explicitly what happens to reports and decisions already registered under the old
  epoch (valid evidence for the new plan, or re-confirmed by the worker).

This touches authorization, persisted state and recovery, so it needs its own written
specification and an independent review before any code. Do not start it from this document.

## Where Claude and Codex fit

The handoff protocol is the same for every harness. What differs, per host, is only how the
coordinator learns it should hand off, how a successor is started, and how it imports the
checkpoint. The Pi-specific quiescence machinery is irrelevant to this path.

```ts
interface CoordinatorHostSupport {
  readonly harness: 'pi' | 'codex' | 'claude';
  observeUsage(source): UsageObservation | 'unavailable'; // signal
  launchSuccessor(plan): SuccessorLaunch;                 // visible pane + seed
  importCheckpoint(successor, checkpoint): ImportReceipt; // resume
}
```

It is small, harness-keyed and additive; it is not a seam through the Pi state machine.

## Per-host adapters

### Claude Code

- **Signal.** An opt-in Pappra status-line wrapper writes a bounded, private usage
  observation (`used_percentage`, `context_window_size`, session id, timestamp) and then
  runs the user's existing status-line command unchanged. It never replaces or edits that
  command without explicit consent. A hook (for example `UserPromptSubmit`) reads the latest
  observation and prints a short advisory when use crosses a threshold. The hook never
  continues the conversation, starts a model or writes a checkpoint.
- **Capture.** The coordinator (the model, on the advisory) runs `pappra checkpoint` with its
  own authored summary; `PostCompact.compact_summary` is recorded as a native summary when
  present. The transcript at `transcript_path` is archived by an explicit CLI command as an
  opaque, digested artifact. It is never parsed for semantics because the format is
  undocumented.
- **Launch.** A visible sibling pane (Herdr) starts `claude "<seed prompt>"`, and a
  `SessionStart` hook injects the digest-verified checkpoint reference as context. Before
  any task preparation the existing one-time read-only identity handshake applies.
- **Fence.** The protocol coordinator handoff; no process stop is claimed or needed.
- Do not use `PreCompact` blocking to defer compaction: it makes a safety property depend on
  an undocumented interaction.

### Codex

- **Signal.** `thread/tokenUsage/updated` from the app-server the adapter is connected to.
- **Capture.** `thread/compact/start` for a native summary, plus `thread/read` to retain the
  lossless history under the private continuity directory, digested.
- **Launch.** `thread/start` (or `thread/fork`) then `thread/inject_items` with the
  digest-verified checkpoint, then `turn/start` with the next action; visible via a Herdr
  pane running the TUI against the same app-server when that is supported.
- **Fence.** The protocol coordinator handoff, as for Claude. Nothing observed proves a TUI
  process stopped, and none is needed for a coordinator.
- Phase 0 removed the gate: interactive sessions are on the shared daemon, so observation
  and compaction requests work without owning the runtime.

## Trigger policy

Handoff is coordinator-initiated and cooperative. A hook or watcher can only advise; the
coordinator runs the commands, at a protocol-safe point (no in-flight dispatch intent,
no pending reconcile), so no daemon and no hidden model launch is introduced. Thresholds are
configuration, not constants. A usage observation older than a bounded age is treated as
`unavailable`, never as "low".

## Reduce the need first (host independent)

Already landed: `inspect --limit` and batch `accept`. Candidates that shrink coordinator
context for every harness without any handoff:

- a `workflow digest` projection of one line per attempt (state, result, next action),
- REPORT bodies bounded and always accompanied by an output digest,
- reviewer assignments that return only findings files, never inline transcripts.

## Phases

| Phase | Content | Exit criteria |
| --- | --- | --- |
| 0 | Probes on pinned versions (done for Claude 2.1.308 and Codex 0.164.0; remaining probes listed below) | evidence recorded here; host validation matrix updated when a version is declared supported |
| 1 | Level 0 (`collab handoff check`, implemented): guided boundary handoff, read-only inventory check with exact blockers (mid-cohort, unaccepted reports, open uncertainty, source write claims); documentation of the checkpoint/resume and `collab handoff` path | no persisted-state change; tests for each blocker; independent review (it gates an ownership transfer) |
| 2 | Signals and advisories (see [context usage](context-usage.md)): Codex live observer, Claude status-line beacon (opt-in, chained), advisory in `workflow inspect`; no advisory hook is needed because the coordinator already calls `inspect` at every step | real-session acceptance; no hook starts a model or writes a checkpoint |
| 3 | Successor launch, identity evidence and checkpoint import per host (see "Phase 3 design"); implemented as `collab handoff successor` and `ack`, accepted in real Claude to Claude and Codex to Codex sessions | independent review |
| 4 | Level 1: mid-cohort succession (adoption step). Specification first, then implementation | written spec reviewed independently before any code |
| 5 | Digest projection and report bounds | context reduction measured on a real cohort |

Every phase touching ownership, persisted state or recovery requires an independent review
by an observed native participant before it is complete.

## Phase 3 design (from probes, 2026-10-27)

Probes ran against Claude Code 2.1.308 and Codex 0.164.0 in throwaway sessions started in
sibling Herdr panes in a scratch directory.

**Observed**

- Seeding works the same way for both hosts:
  `herdr agent start <name> --kind <claude|codex> --pane <pane> -- "<prompt>"` starts a visible
  interactive session that processes the initial prompt immediately.
- Claude: `--session-id <uuid>` pre-assigns the session id, and `herdr agent get` reports that
  exact value as `agent_session` as soon as the session starts. The successor's identity can
  therefore be known before it runs anything.
- Codex: `herdr` reports `agent_session: null` and no thread-id variable was found in the
  process environment. The daemon does know the thread: `thread/loaded/list` plus
  `thread/read` return its `cwd`, `createdAt` and `preview`, and the preview is the seed
  prompt. The TUI also loads a second, blank thread (empty preview) in the same directory, so
  a match must be on cwd and the exact seed preview, and exactly one match is required.
- Not needed for a fresh successor, so not probed: Claude `SessionStart` `source: resume|fork`,
  Codex `thread/fork`, `thread/inject_items` and `turn/interrupt`.

**Principles carried over.** The successor is a new, visible session in a sibling pane; focus
is not changed; no existing pane is typed into; no approval is answered for anyone; a launch
that may have happened is never repeated; identity comes from observed evidence (Herdr, the
daemon), never from prose. Routing evidence is not authentication and the report says so.

**Flow (as implemented).** Every step except the launch and the acknowledgement already existed.

1. `collab handoff check` must report `ready`. The launcher re-runs it, ignoring only the handoff
   it is driving, and refuses otherwise.
2. `collab handoff begin` for `kind: coordinator` with a placeholder receiver whose agent id is
   the planned Herdr agent name. The protocol already allows rebinding a receiver once its native
   session is observed.
3. **Launch.** `collab handoff successor <plan|apply>` splits one sibling pane in the
   coordinator's cwd, starts the same harness there, waits until Herdr reports the session
   interactive, and delivers a **fixed seed** with `herdr agent prompt` (addressed by the pane it
   split, never by a reusable agent name). Every native effect is journalled first in a
   task-local private directory, not in `task.json`; a repeat returns the recorded result or
   `reconcile_required`, and an unknown outcome is never replayed.
4. The launcher records identity evidence, then rebinds the observed identity into the handoff
   and records the transfer through the existing `rebind` and `transfer` actions. These are
   idempotent, so a run interrupted after the outcome was recorded finishes the bind on the next
   run without launching again.
5. **Acknowledgement.** The seed asks the successor to run one command, `collab handoff ack`. It
   verifies the caller, checks the digest-pinned checkpoint before registering anything,
   registers one `HANDOFF` confirmation message from the recorded identity to the current
   coordinator (the existing `confirmReceiver` identity and epoch checks apply unchanged), writes
   an ack marker, and prints the checkpoint as the briefing. There is no prefilled request file
   and no separate resume command.
6. The coordinator explicitly runs `collab handoff confirm` and `complete`; the successor then
   runs `release-dispatch` at the new epoch. Until then dispatch stays frozen.

**Seed.** Fixed text that substitutes only the task id, the handoff id and the one command (the
absolute CLI path and task root are shell-quoted; the request id is a validated safe id). It tells
the successor to run that command, reply with a fixed acknowledgement line and wait, and forbids
dispatching, accepting or releasing until the previous coordinator says dispatch is released.
Arbitrary prompt text is not accepted. The checkpoint reaches the successor only through the
command's output.

**Identity rules.**

- Claude: the launcher pre-assigns `--session-id`, derived from the task id, the handoff id and
  the request id (request ids are chosen by people, so two tasks must not share a session), and
  requires Herdr to report exactly that id before any seed is typed. The acknowledgement binds a
  Claude caller by the Herdr pane it runs in.
- Codex: exactly one loaded thread whose `cwd` equals the pane's and whose `preview` equals the
  delivered seed, created at or after the launch second (Codex stamps whole seconds, so no
  tolerance is used). Zero or several matches refuse; nothing is guessed. The acknowledgement
  binds a Codex caller by `CODEX_THREAD_ID`.
- The agent id used in the protocol is the Herdr agent name, as for the Pi path.

**Known identity limits.** A Codex coordinator pane normally reports no session to Herdr, so
the launch precondition for Codex only checks the pane's cwd and warns; anyone holding the
request file in that cwd could drive the launch, but gains no authority they did not already
have (`rebind` and `transfer` can be run directly). The acknowledgement proves the command ran in
the recorded pane (Claude) or thread (Codex), not that the recorded session is still alive: a
successor replaced in the same pane could register the same deterministic message.

**Out of scope here.** Replacing the old session (nothing stops it; the protocol fences it by
epoch), mid-cohort adoption (phase 4), and Pi (it has the managed handoff).

**Implementation split.** 3a identity discovery for both hosts and the launcher plan/apply with
its intent journal; 3b ACK request prefill, the fixed seed and docs; 3c end-to-end real-session
acceptance (Claude to Claude and Codex to Codex on a throwaway task). 3a and 3b touch an
ownership-transfer path and need independent review before 3c.

## Phase 3 real-session findings (2026-10-27)

Real sessions (Claude Code 2.1.308 and Codex 0.164.0, each a throwaway task whose coordinator
was a real session in a scratch directory) changed three parts of the design that the earlier
probes had not exposed:

- Herdr writes a refusal as JSON on **stderr** with exit code 1 (for example
  `agent_not_found`), not on stdout. The Herdr wrapper reads both.
- A freshly started session is not ready when `agent start` returns. Herdr reports
  `interactive_ready` and, for Claude, the session id only after the session's own startup
  (including the user's SessionStart hooks) finishes; a seed typed earlier was left unsubmitted
  in the input box. The launcher now waits for `interactive_ready`, an idle state and, for
  Claude, the pre-assigned id, and checks that the turn started.
- Codex tool commands run in the shared daemon, so `HERDR_PANE_ID` there is the daemon's, not
  the pane's. `CODEX_THREAD_ID` (equal to `CODEX_SESSION_ID`) is set and equals the thread the
  daemon identified from the seed. The acknowledgement binds a Codex caller by that thread id.

Result in both runs: the successor ran exactly one command, replied with the fixed
acknowledgement line, the coordinator ran `confirm` and `complete`, the epoch became 2 with the
previous coordinator recorded, and the previous coordinator's `release-dispatch` at epoch 1 was
refused as `stale_epoch`. In the Claude run the successor itself then released dispatch.

## Decisions for phase 3 (recorded 2026-10-27)

1. The successor acknowledges by running a prefilled, digest-pinned request whose identity was
   filled from observed Herdr or daemon evidence. This is not authentication.
2. The seed asks the successor to run exactly one command. That command both registers the
   acknowledgement and prints the briefing, so no separate resume command is needed. If the
   user's permission mode asks for approval of it, the user answers in the pane; Pappra never does.

## Decisions (recorded 2026-10-27)

1. A protocol-fenced handoff (no process-stop claim) is accepted for a claim-free
   coordinator. It is the only option for interactive Claude and Codex sessions, and it is
   what the existing coordinator handoff already is.
2. Pappra may ship an opt-in status-line wrapper that chains the user's existing command and
   never replaces or edits it without explicit consent.
3. An explicit CLI command may archive `transcript_path` as an opaque, digested artifact.
   Hooks still never read transcripts.
4. Phase 0 probes may run against the real Claude and Codex installations.

## Phase 0 results (observed 2026-10-27)

Probes ran against Claude Code 2.1.308 and Codex 0.164.0 in isolated scratch directories
with throwaway sessions; no user settings were edited. Claude's inline `--settings` carried
the probe hooks and status line. One side effect: Claude Code recorded folder trust for the
probe's scratch directory in the user's own configuration.

**Codex**

- A plain interactive `codex` TUI (no `--remote`) is loaded on the shared app-server daemon.
  `thread/loaded/list` over the control socket returned its thread id.
- The control socket speaks WebSocket (HTTP upgrade, then masked text frames of JSON-RPC)
  through `codex app-server proxy`, not newline-delimited JSON.
- Before any subscription, an external client already receives `thread/status/changed`,
  `thread/started` and `thread/name/updated` for that session.
- `thread/resume` on a thread that has never received a message fails with
  `no rollout found`; after the first message it succeeds and the client receives
  `turn/started`, `turn/completed` and `thread/tokenUsage/updated` for the TUI's turns.
- `thread/tokenUsage/updated` carries `modelContextWindow` (475000 for this model). Context
  occupancy is `last.totalTokens / modelContextWindow`; `total` is cumulative spend, not
  occupancy.
- `thread/read` with `includeTurns: true` returns the full turns and the rollout `path`, so
  a lossless capture does not need transcript parsing.
- `thread/compact/start` from an external client was accepted (`result: {}`) and ran a
  compaction turn on the TUI's thread. No `thread/compacted` notification was observed in
  40 s; completion has to be read from turn/item events and token usage.
- Not probed: `turn/interrupt`, `thread/inject_items`, `thread/fork` against a live TUI
  thread.

**Claude Code**

- The status line receives live JSON including `context_window.used_percentage`
  (integer percent), `remaining_percentage`, `context_window_size` (1000000 here),
  `total_input_tokens`, `current_usage`, `transcript_path`, `session_id` and `version`.
  Before the first response `used_percentage` and `current_usage` are null.
- Every hook payload observed (`SessionStart`, `PreCompact`, `PostCompact`) carries
  `transcript_path` and `session_id`. None carries usage.
- A manual `/compact` fires `PreCompact` (`trigger: manual`), then `SessionStart`
  (`source: compact`), then `PostCompact`. `PostCompact` carries the full `compact_summary`.
- `additionalContext` returned from `SessionStart` reached the model on `startup` and again
  on `compact`; after compaction the earlier startup injection was gone and only the
  `compact` one remained. Re-injecting a checkpoint reference after compaction therefore
  works as documented.
- Not probed: `source: resume`, `PreCompact` blocking, auto-compaction triggers.

**Consequences for the design**

- Codex signal needs no Pappra-owned runtime: a sidecar WebSocket client on the shared
  daemon observes any interactive Codex session. It must tolerate "no rollout yet" and
  treat a stale or missing observation as `unavailable`.
- Codex needs no process-stop proof for a coordinator handoff; an external client can
  observe and request compaction, which is all the signal and capture steps need.
- Claude's only usage signal is the status line, at 1% granularity, so thresholds must be
  coarse and the observation must carry its timestamp.

## Remaining probes before the matching phase

| Probe | Needed by |
| --- | --- |
| Claude `SessionStart` `source: resume` and `fork`; auto-compaction hook order | not needed for a fresh successor; only if resume-based takeover is ever added |
| Codex `turn/interrupt`, `thread/inject_items`, `thread/fork` on a live TUI thread | not needed for a fresh successor |
| Pinned-version matrix: Claude 2.1.292, Codex 0.163.0 | before declaring support |
