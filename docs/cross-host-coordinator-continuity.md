# Cross-host coordinator continuity

A coordinator accumulates context (reports, decisions, claims) over a long
cohort and eventually needs to hand the role to a fresh session. This document
describes how that handoff works for every supported harness, what each host can
honestly support, and the guarantees Pappra does and does not claim. Boundary
handoff, successor launch and mid-cohort succession are implemented; the
per-host observation layer is implemented for signal only, and the remaining
capture/launch adapters are marked as design below.

The goal is that any supported harness can be the coordinator and still reach
every continuity capability **that the host can honestly support**, with reports
saying exactly which guarantee was and was not obtained.

Non-goals: a role daemon, hooks that start models or write checkpoints, treating
idle/settled/`abort()` as proof that a process stopped, or inventing identities
and capabilities from prose.

## Coordinator handoff is not writer rollover

Two different successions exist, and conflating them is the main design trap:

- The Pi session-transition machinery (quiescence proof, managed SDK,
  `rollover`) is a **writer** rollover: it moves a worker's claims and attempt to
  a successor. It does not generalise into a coordinator path.
- A **coordinator handoff** already exists in the protocol (`kind: 'coordinator'`
  in `src/collab/handoff.ts`, driven by `pappra collab handoff
  begin|stopped|rebind|transfer|confirm|complete|abort|release-dispatch`). It is
  harness-agnostic and tested (`tests/collab/task-handoff-cli.test.ts`). By
  design it requires **no stop proof**: "a coordinator handoff has no writer
  process to stop: the freeze plus the captured inventory is the barrier".

The fence is the owner epoch. `complete` replaces `record.coordinator`, raises
`owner_epoch`, records `previous`, and freezes dispatch until the new coordinator
releases it. Commands signed by the old epoch are refused by the epoch checks.
Every handoff command is a cooperative record mutation; the CLI states its
limits as `cooperative_record_mutation_only, no_native_control`.

## The capability model

A coordinator handoff decomposes into five capabilities:

| # | Capability | Meaning |
| --- | --- | --- |
| 1 | Signal | Observe live context use, decide when to hand off |
| 2 | Capture | Preserve a lossy summary plus the lossless source |
| 3 | Launch | Start a successor of the same harness with the checkpoint imported |
| 4 | Fence | Make the old session unable to act as coordinator |
| 5 | Verify | Successor proves first work before the source retires |

Capability 4 is the protocol's coordinator handoff itself, on every host. The
other four depend on what the host exposes; the evidence below records what each
host actually provides.

## Evidence by host

Verified means observed locally in this repository's session; documented means
taken from vendor docs and must be re-checked against the pinned version before
use.

### Codex 0.164.0 (verified from `codex app-server generate-json-schema`)

- Signal: server notification `thread/tokenUsage/updated` carries `total`,
  `last` and `modelContextWindow` (nullable).
- Capture: `thread/read`, `thread/turns/list`, `thread/items/list`;
  `thread/compact/start` and `thread/compacted` for native compaction.
- Launch: `thread/start`, `thread/fork`, `thread/resume`, `thread/inject_items`,
  `turn/start`.
- Control: `turn/steer`, `turn/interrupt`, `thread/status/changed`,
  `thread/queue/changed`, `thread/unsubscribe`.
- CLI: `codex queue --thread`, `codex fork`, `codex resume`, `codex agents`
  (sessions on a shared local app-server daemon).
- Hooks: only `SessionStart` is verified at 0.163/0.164; `PostCompact` is
  unsupported ([host validation](host-plugin-validation.md)).
- The repository's transport spawns its own stdio `codex app-server`. An
  interactive TUI session runs on the shared daemon instead, so a sidecar client
  on that daemon can observe it without owning the runtime.

### Claude Code 2.1.308 (documented; items marked [summary] came from a doc summary)

- Signal: the status-line command receives stdin JSON with
  `context_window.used_percentage`, `remaining_percentage`,
  `context_window_size`, token totals, `current_usage` (null after `/compact`
  until the next call) and `transcript_path`. Hook payloads carry no usage.
  OpenTelemetry exposes token counts but not context size.
- Capture: `PostCompact` input includes `compact_summary`; the transcript JSONL
  is at `transcript_path`, but its entry format is internal and may change.
- Launch: `claude "<prompt>"` starts an interactive session seeded with a
  prompt; `--resume`, `--fork-session`, `--append-system-prompt-file`. A
  `SessionStart` hook (matchers `startup|resume|clear|compact|fork`) can add
  stdout/`additionalContext`.
- Control: `PreCompact` can block compaction [summary]; `continue:false` stops a
  turn from a tool hook [summary]. **No documented way to send input to, stop,
  or quiesce a running interactive session from outside.** `claude stop` and
  `attach` apply to background sessions only.

### Pi 1.4.0

Pappra owns the SDK runtime, which is why a scoped quiescence proof is possible.
That machinery serves the writer path and the managed handoff; see
[automatic handoff](automatic-handoff.md).

## Boundary handoff

At a cohort boundary — no in-flight attempts, no unreleased source claims, no
open uncertainty — a successor takes over with the existing
`pappra checkpoint` / `pappra resume`, or with the coordinator handoff flow, and
starts the next cohort under its own epoch.

`pappra collab handoff check` (and `check-mid-cohort`) is the read-and-check
layer over `handoffInventory`. It changes no persisted state and reports exact
blockers: an open handoff, attempts still running or awaiting input, claims held
by the source or by others, and unresolved uncertainty. The launcher re-runs it,
ignoring only the handoff it is driving, and refuses otherwise.

### Successor launch and acknowledgement

`pappra collab handoff successor --request <successor.json> [--apply]` starts the
successor; `pappra collab handoff ack --task-root <dir> --request <id>` is the
successor's one command. The flow:

1. `begin` the handoff for `kind: 'coordinator'` with a placeholder receiver
   whose agent id is the planned Herdr agent name. The protocol allows rebinding
   a receiver once its native session is observed.
2. The launcher splits one sibling pane in the coordinator's cwd, starts the
   same harness there, and waits until Herdr reports the session ready for
   input: `interactive_ready`, an idle state and — for Claude — the
   pre-assigned session id, plus a started turn. A seed typed earlier is left
   unsubmitted, so this wait is mandatory.
3. It delivers a **fixed seed** with `herdr agent prompt`, addressed by the pane
   it split, never by a reusable agent name. Every native effect (split, start,
   prompt) is journalled first in a task-local private directory, not in
   `task.json`; a repeat returns the recorded result or `reconcile_required`,
   and an unknown outcome is never replayed. Herdr reports a refusal as JSON on
   **stderr** with a non-zero exit, and the wrapper reads both streams.
4. The launcher records identity evidence, then rebinds the observed identity
   into the handoff and records the transfer through the existing `rebind` and
   `transfer` actions. These are idempotent, so a run interrupted after the
   outcome was recorded finishes the bind on the next run without launching
   again.
5. The seed asks the successor to run exactly one command, `collab handoff ack`.
   It verifies the caller, checks the digest-pinned checkpoint before
   registering anything, registers one `HANDOFF` confirmation message from the
   recorded identity to the current coordinator (the existing `confirmReceiver`
   identity and epoch checks apply unchanged), writes an ack marker, and prints
   the checkpoint as the briefing. There is no prefilled request file and no
   separate resume command.
6. The coordinator explicitly runs `collab handoff confirm` and `complete`; the
   successor then runs `release-dispatch` at the new epoch. Until then dispatch
   stays frozen.

The seed is fixed text that substitutes only the task id, the handoff id and the
one command (the absolute CLI path and task root are shell-quoted; the request
id is a validated safe id). It tells the successor to run that command, reply
with a fixed acknowledgement line and wait, and forbids dispatching, accepting
or releasing until the previous coordinator says dispatch is released. Arbitrary
prompt text is not accepted, and the checkpoint reaches the successor only
through the command's output.

### Identity rules and their limits

Identity comes from observed evidence (Herdr, the daemon), never from prose.
Routing evidence is not authentication, and the report says so.

- Claude: the launcher pre-assigns `--session-id`, derived from the task id, the
  handoff id and the request id (request ids are chosen by people, so two tasks
  must not share a session), and requires Herdr to report exactly that id before
  any seed is typed. The acknowledgement binds a Claude caller by the Herdr pane
  it runs in.
- Codex: exactly one loaded thread whose `cwd` equals the pane's and whose
  `preview` equals the delivered seed, created at or after the launch second
  (Codex stamps whole seconds, so no tolerance is used). Zero or several matches
  refuse; nothing is guessed. The TUI also loads a second, blank thread in the
  same directory, so the match must be on cwd and the exact seed preview. The
  acknowledgement binds a Codex caller by `CODEX_THREAD_ID`, which the daemon sets for the thread it identified from
  the seed — `HERDR_PANE_ID` inside a Codex tool command is the daemon's, not
  the pane's.
- The agent id used in the protocol is the Herdr agent name, as for the Pi path.

Known limits: a Codex coordinator pane normally reports no session to Herdr, so
the launch precondition for Codex only checks the pane's cwd and warns; anyone
holding the request file in that cwd could drive the launch, but gains no
authority they did not already have (`rebind` and `transfer` can be run
directly). The acknowledgement proves the command ran in the recorded pane
(Claude) or thread (Codex), not that the recorded session is still alive: a
successor replaced in the same pane could register the same deterministic
message.

## Mid-cohort succession

A mid-cohort coordinator handoff must not strand the cohort. After a completed
coordinator handoff, the successor runs an explicit, auditable adoption step
(`pappra collab workflow adopt`) that re-establishes authority over the existing
cohort:

- it writes exactly one document, the next binding generation
  (`binding.e<epoch>.json`), so notifications reach the successor, and reports
  what it adopted; no sealed document, attempt or message is rewritten;
- old-epoch artifacts stay authoritative through the epoch lineage, not through
  re-stamping;
- reports and decisions registered under the old epoch count as evidence of that
  epoch when they were applied before it ended; anything else does not count as
  evidence and does not block the successor from deciding again.

This touches authorization, persisted state and recovery; its specification and
review record live in [the mid-cohort succession
specification](mid-cohort-succession-spec.md).

Two operational consequences matter when the successor is Codex. Codex tools run
in a sandboxed shared daemon that cannot reach the Herdr socket: `adopt` binds a
Codex coordinator by `CODEX_THREAD_ID` and the launcher's recorded outcome, and
a Codex coordinator cannot notify anyone (`accept` records the decision and
reports a delivery warning), so the worker waits for the decision with
`pappra collab workflow await`. And an acknowledged-only worker keeps its
`registered_not_started` uncertainty until the operator resolves it with
`pappra collab recovery reconcile`.

## Signal: observing context use

Signal is implemented for Claude and Codex as a bounded, private,
numbers-only observation keyed by host and session id — no transcript content.
An absent, stale or malformed observation is `unavailable`, never "low"; a
read-only check with a default maximum age of 600 seconds guards this.

```sh
pappra context usage --host claude --session <id> [--advise-percent <1-99>]
pappra context usage --host codex --session <id>
pappra context statusline-plan [--project-dir <abs>] [--claude-home <abs>]
```

- Claude: an opt-in status-line wrapper writes the observation and then runs the
  user's existing status-line command unchanged with the original payload on
  stdin. It never replaces or edits that command without explicit consent;
  `statusline-plan` prints the exact setting to install. The status line is the
  only usage signal and has 1% granularity, so thresholds must be coarse and the
  observation carries its timestamp.
- Codex: a sidecar client on the shared app-server daemon reads
  `thread/tokenUsage/updated` for the thread. It must tolerate "no rollout yet"
  and treat a stale or missing observation as `unavailable`.
- `pappra collab workflow inspect` reports the advisory and the next action; no
  hook is needed because the coordinator already calls `inspect` at every step.
  See [context usage](context-usage.md) for the observation format.

Trigger policy: handoff is coordinator-initiated and cooperative. A hook or
watcher can only advise; the coordinator runs the commands, at a protocol-safe
point (no in-flight dispatch intent, no pending reconcile), so no daemon and no
hidden model launch is introduced. Thresholds are configuration, not constants.

## Capture and launch adapters (design)

The handoff protocol is the same for every harness. What differs, per host, is
only how the coordinator learns it should hand off, how a successor is started,
and how it imports the checkpoint. The adapter surface is small, harness-keyed
and additive; it is not a seam through the Pi state machine.

```ts
interface CoordinatorHostSupport {
  readonly harness: 'pi' | 'codex' | 'claude';
  observeUsage(source): UsageObservation | 'unavailable'; // signal
  launchSuccessor(plan): SuccessorLaunch;                 // visible pane + seed
  importCheckpoint(successor, checkpoint): ImportReceipt; // resume
}
```

Implemented today: the signal layer above, and the successor launch flow (which
runs one visible sibling pane per harness and reuses the host's own resume
import — `pappra resume` output as the briefing). Designed but not shipped as
general adapters:

- Codex capture through `thread/compact/start` for a native summary plus
  `thread/read` to retain the lossless history under the private continuity
  directory, digested; launch through `thread/start` (or `thread/fork`) then
  `thread/inject_items` with the digest-verified checkpoint, then `turn/start`.
- Claude capture through the coordinator-authored `pappra checkpoint` (with
  `PostCompact.compact_summary` recorded as a native summary when present); an
  explicit CLI command would archive `transcript_path` as an opaque, digested
  artifact — it is never parsed for semantics because the format is
  undocumented. No such command exists yet.
- Do not use `PreCompact` blocking to defer compaction: it makes a safety
  property depend on an undocumented interaction.

## Reducing the need first

Already shipped: `workflow inspect --limit` and batch `accept` (up to 32
decisions per request). Candidates that shrink coordinator context for every
harness without any handoff:

- a `workflow digest` projection of one line per attempt (state, result, next
  action),
- REPORT bodies bounded and always accompanied by an output digest,
- reviewer assignments that return only findings files, never inline
  transcripts.

## Limits

- Interactive-Pi takeover and native quiescence for arbitrary external writers
  remain unsupported; the pinned managed-SDK runtime has a separate scoped
  quiescence-proof path. Task retirement is not native session archive.
- Replacing the old session is out of scope: nothing stops it, and the protocol
  fences it by epoch.
- A new pinned host version must be probed against the host-version matrix before
  it is declared supported.
  Probe work that a fresh successor does not need — Claude `SessionStart`
  `source: resume|fork`, Codex `turn/interrupt`, `thread/inject_items`,
  `thread/fork` against a live TUI thread — stays unprobed.
- Every change touching ownership, persisted state or recovery requires an
  independent review by an observed native participant before it is complete.
