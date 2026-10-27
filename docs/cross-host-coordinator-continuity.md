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
| 1 | Level 0: guided boundary handoff, read-only inventory check with exact blockers (mid-cohort, unaccepted reports, open uncertainty, source write claims); documentation of the checkpoint/resume and `collab handoff` path | no persisted-state change; tests for each blocker; independent review (it gates an ownership transfer) |
| 2 | Signals and advisories: Codex sidecar observer, Claude status-line beacon (opt-in, chained), advisory hook | real-session acceptance; no hook starts a model or writes a checkpoint |
| 3 | Successor launch and checkpoint import per host (visible pane, seed, `SessionStart` injection) | real-session acceptance; independent review |
| 4 | Level 1: mid-cohort succession (adoption step). Specification first, then implementation | written spec reviewed independently before any code |
| 5 | Digest projection and report bounds | context reduction measured on a real cohort |

Every phase touching ownership, persisted state or recovery requires an independent review
by an observed native participant before it is complete.

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
| Claude `SessionStart` `source: resume` and `fork`; auto-compaction hook order | phase 2 |
| Codex `turn/interrupt`, `thread/inject_items`, `thread/fork` on a live TUI thread | phase 3 |
| Pinned-version matrix: Claude 2.1.292, Codex 0.163.0 | before declaring support |
