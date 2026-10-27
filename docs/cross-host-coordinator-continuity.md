# Cross-host coordinator continuity (design proposal)

Status: proposal, not implemented. Nothing here changes behaviour until a phase below lands.

## Problem

A coordinator accumulates context (reports, decisions, claims) over a long cohort. Today
only a Pi session that Pappra owns through the managed SDK can hand that role to a
successor automatically ([automatic handoff](automatic-handoff.md)). When Codex or Claude
Code is the coordinator, the same capability is missing: the transition request accepts
only `harness: 'pi'` (`src/app/collab-session-transition-request.ts`), the automatic
handoff constructs only Pi identities (`src/app/collab-auto-handoff.ts`), and dispatch
derives live evidence only for Pi.

The goal is that any supported harness can be the coordinator and still reach every
continuity capability **that the host can honestly support**, with the report saying
exactly which guarantee was and was not obtained.

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
| 4 | Fence | Make the old session unable to act as coordinator | scoped quiescence proof + epoch transfer |
| 5 | Verify | Successor proves first work before the source retires | correlated `handoff-first-work` REPORT |

The state machine (journal first, then effect; epoch and claim re-validation; retirement
is not archive) is already harness-neutral in intent. Only the identity check, the
quiescence proof and the launch/observe adapters are Pi-specific. The design keeps the
state machine and replaces those three with an adapter seam.

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

## Core decision: two fencing tiers, reported honestly

The expensive part of the Pi path is proving the source process stopped. That proof exists
because the source may hold write claims and a stray writer would corrupt a successor's
scope. For other hosts we cannot always get it, so we separate what each tier guarantees.

**Tier S, process-fenced.** Pappra owns the runtime of the source (Pi SDK today; a
Pappra-started Codex app-server thread; a Pappra-started `claude -p --input-format
stream-json` child). Quiescence is proven with the existing scoped, fresh,
inventory-digested receipt. Same guarantees as Pi.

**Tier P, protocol-fenced.** The source is an interactive session Pappra does not own
(a user-started Claude Code or Codex TUI). Nothing external can stop it. The fence is the
existing owner epoch: after the epoch transfers, the old coordinator is refused by
`accept`, `dispatch`, `reclaim`, `release` correlation and every `transact` epoch check
(`accept_not_coordinator`, `acceptance_stale`). The report states
`fence: protocol_fenced_only` and `process_quiescence: unavailable`; it never claims the
process stopped.

Tier P is safe only for a source that **coordinates but does not write under a claim**.
It is admitted only when all hold, re-checked at each effect boundary:

1. the source holds no unreleased `write` claim and has no active attempt as assignee;
2. the source is not a participant with a sealed write scope in the cohort;
3. the successor binding and live pane identity match (as for Pi);
4. the user's task authorization covers a protocol-fenced handoff.

If any fails, the transition refuses with a concrete reason instead of downgrading
silently. A source that is also a writer must finish or release first, or be a Tier S host.

## Adapter seam

Replace the `harness !== 'pi'` assertions with a typed adapter chosen by the observed
harness, never by name similarity:

```ts
interface ContinuityAdapter {
  readonly harness: 'pi' | 'codex' | 'claude';
  readonly tier: 'process-fenced' | 'protocol-fenced';
  observeUsage(source): UsageObservation | 'unavailable';   // capability 1
  captureCheckpoint(source): CheckpointCapture;             // capability 2
  launchSuccessor(plan): SuccessorLaunch;                   // capability 3
  fence(source): FenceReceipt;                              // capability 4
  observeFirstWork(successor): FirstWorkEvidence | 'unknown'; // capability 5
}
```

- The Pi adapter wraps existing code; phase 1 must leave every Pi test green and every Pi
  report byte-identical.
- Unsupported capabilities return `unavailable`; the report carries the exact blocker. The
  journal and effect receipts are unchanged.
- The report gains `fence_kind` and keeps `process_quiescence` as its own field so a Tier P
  report can never read as a Tier S one.

## Per-host adapters

### Claude Code (Tier P by default)

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
- **Fence.** Tier P. Tier S needs an owned stream-json child, which is not visible and so
  conflicts with the visible-peers default. It is out of scope for the first phases.
- Do not use `PreCompact` blocking to defer compaction: it makes a safety property depend on
  an undocumented interaction.

### Codex (Tier S where owned, Tier P otherwise)

- **Signal.** `thread/tokenUsage/updated` from the app-server the adapter is connected to.
- **Capture.** `thread/compact/start` for a native summary, plus `thread/read` to retain the
  lossless history under the private continuity directory, digested.
- **Launch.** `thread/start` (or `thread/fork`) then `thread/inject_items` with the
  digest-verified checkpoint, then `turn/start` with the next action; visible via a Herdr
  pane running the TUI against the same app-server when that is supported.
- **Fence.** Tier S for a thread on a Pappra-owned app-server: `turn/interrupt`, a settled
  `thread/status/changed`, and `thread/unsubscribe`, wrapped in the same scoped receipt.
  Tier P for a user-started TUI that is not on that server, exactly as Claude.
- Phase 0 removed the gate: interactive sessions are on the shared daemon, so Tier P
  observation and compaction requests work without owning the runtime.

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
| 0 | Probes on pinned versions (done for Claude 2.1.308 and Codex 0.164.0; remaining probes listed above) | evidence recorded here; host validation matrix updated when a version is declared supported |
| 1 | Adapter seam, Pi adapter only | no behaviour change; Pi suites green; independent review |
| 2 | Claude Tier P: usage beacon, advisory hook, checkpoint/launch path, claim-free precondition | real-session acceptance; independent review |
| 3 | Codex adapter per phase-0 outcome (Tier S, then Tier P) | real-session acceptance; independent review |
| 4 | Digest projection and report bounds | context reduction measured on a real cohort |

Every phase touching fencing, ownership, persisted state or recovery requires an
independent review by an observed native participant before it is complete.

## Decisions (recorded 2026-10-27)

1. A protocol-fenced handoff (`process_quiescence: unavailable`) is accepted for a
   claim-free coordinator. It is the only option for interactive Claude and Codex sessions.
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
- Codex fencing is still Tier P for a user-started TUI: an external client can observe and
  request compaction, but nothing observed proves the TUI process stopped.
- Claude's only usage signal is the status line, at 1% granularity, so thresholds must be
  coarse and the observation must carry its timestamp.

## Remaining probes before the matching phase

| Probe | Needed by |
| --- | --- |
| Claude `SessionStart` `source: resume` and `fork`; auto-compaction hook order | phase 2 |
| Codex `turn/interrupt`, `thread/inject_items`, `thread/fork` on a live TUI thread | phase 3 |
| Pinned-version matrix: Claude 2.1.292, Codex 0.163.0 | before declaring support |
