# Task C report — delivery observation (#20)

Candidate, not accepted. This changes delivery and persisted semantics, so it
stops here: the implementation is committed locally and awaits an independent
review by a fresh context. Nothing was pushed, no PR was opened, no issue was
closed or edited, no release or external message happened, and no real
participant was sent anything.

## Base and head

| | |
| --- | --- |
| repository | `/Users/zimm.yu/personal/YU/pappra` (worktree `/private/tmp/pappra-20-observation`) |
| branch | `codex/20-delivery-observation`, created from `origin/main` |
| base | `a351802` — `docs: balance workspace growth and collaborative delivery roadmap (#47)` |
| head (implementation) | `346c704` — `feat(collab): observe receipt of a delivered pointer (#20)`; the branch tip is that commit plus this report commit |
| known merged bases confirmed | `a351802` (PR #47), `366f49f` (PR #40, #17) |

The worktree was created from `origin/main` after `git fetch origin main`;
`origin/main` was already `a351802` and the primary checkout was clean. No other
branch, worktree or uncommitted change was touched. `pnpm dev:check` reported
`code-index` and `docs-registration` as pending, so `pnpm dev:setup` prepared the
local code index and registered the 34 documents; that state lives under
`.pappra/local/` and is gitignored, and `git status` stayed clean.

## Execution mode

Direct work in one tightly coupled write scope, as the task instructed. No
sub-agent, role plan or cohort was started, and no model was launched. The
independent review remains outstanding and belongs to the coordinator; this
report names what that review should attack.

## Phase 1 — what a supported Herdr actually exposes

Read-only inspection only. No prompt, no `send-keys`, no `agent wait`, no
transcript read, no experiment against a live participant.

| Evidence | Result |
| --- | --- |
| `herdr --version` | `herdr 0.9.5` (installed CLI on this machine) |
| `herdr api schema --json` | `protocol: 22`, `schema_version: 1`, five schemas: `error_response`, `event`, `request`, `subscription_event`, `success_response` |
| `herdr agent list` (live, values not printed) | 9 agents. Present keys: `agent`, `agent_session`, `agent_status`, `cwd`, `focused`, `foreground_cwd`, `pane_id`, `revision`, `screen_detection_skipped`, `state_change_seq`, `tab_id`, `terminal_id`, `terminal_title`, `terminal_title_stripped`, `workspace_id` |
| same call | `completion_seq` appeared only on entries where it was non-null; `interactive_ready` and `launch_pending` did **not** appear in any entry |
| `herdr agent --help` / `agent get` / `agent wait` | `agent get <target>` and `agent wait --until <idle\|working\|blocked\|done\|unknown> --timeout <ms>` exist; `--until` without `--timeout` waits indefinitely |

`AgentInfo` in the bundled schema (the shape `agent list`/`agent get` return):

| Field | Type | Required | Reported meaning |
| --- | --- | --- | --- |
| `agent_status` | `idle`/`working`/`blocked`/`done`/`unknown` | yes | what the agent is doing |
| `state_change_seq` | `uint64`, default `0` | no | counter of detected state changes |
| `completion_seq` | `uint64` \| `null` | no | "The current idle transition completed work, independently of who has viewed it." |
| `terminal_id` | `string` | yes | identity of the terminal the agent runs in |
| `revision` | `uint64` | yes | per-agent update counter |
| `interactive_ready` | `boolean` | no | whether the pane accepts input |
| `launch_pending` | `boolean` | no | whether the agent is still launching |
| `agent_session` | `{source, agent, kind, value}` | no | reported native session |

### Signal semantics as implemented, and their limits

| Signal | Used for | Limit that keeps the conclusion honest |
| --- | --- | --- |
| `agent_status` | `idle`/`done` are rest states; `working` is a turn | "working" alone proves nothing when the recipient was already working, and a `working → idle`/`done` shift proves a turn ended without proving which input started it |
| `state_change_seq` | whether **any** state change happened, and that a `working` sample is new | a redraw or unrelated activity can move it; movement alone is never receipt |
| `completion_seq` | corroborates that a completed turn is **not** attributable on its own | it says a turn completed, not which prompt it came from |
| `terminal_id` | the comparison is only valid on the same terminal | a changed id means the program was restarted, so nothing before and after is comparable |
| `revision` | detects activity that is not a state change | revision-only movement is `unknown`, never receipt and never non-receipt |
| `interactive_ready` / `launch_pending` | refuse to attribute a turn start to a pane that is not at a prompt | **not reported by `agent list` on 0.9.5**, so this gate is inert for the default transport and cannot fire today (see gaps) |

### What the API cannot prove

- **No message-level correlation.** Herdr's counters are per agent, not per
  prompt. Any other input can start the same turn; nothing in the API names the
  prompt a state change belongs to.
- **No input-box visibility.** The API has no signal for "the text is sitting
  unsubmitted in the input"; `agent read` would show another agent's terminal
  content, which is exactly the transcript reading #20 keeps out of scope.
- **No queue truth.** A queued-but-unread pointer and a dropped Enter look the
  same from outside.

So the representable facts are narrow, and they are what the code records:
`taken` = "a turn started on this terminal after this submission", `not_taken` =
"no turn start was observed inside the window", `unknown` = everything else.
None of the three is consumption, acknowledgement or acceptance.

### The six facts, kept separate

| Fact | Written by | Never collapsed into |
| --- | --- | --- |
| persisted | `send --apply` → `submitMessage` | notification |
| notified/submitted | `notify --apply` → one pointer handed to a transport | consumed |
| observed receipt (**new**) | bounded roster observation after the submission | submitted, consumed, accepted |
| consumed/acknowledged | the recipient's own `ACK` | delivery |
| reported | the recipient's `REPORT` | acceptance |
| accepted | the coordinator's explicit decision | anything on this surface |

## Phase 2 — representation and classification

`pappra/collab-delivery-observation/1` is stored on the delivery **attempt** it
describes (`attempts[].observation`, optional, strict):

| Field | Content |
| --- | --- |
| `receipt` | `taken` \| `not_taken` \| `unknown` |
| `reason` | closed code (17 values) naming the evidence |
| `source` | `herdr-agent-state` |
| `started_at`, `ended_at`, `window_ms`, `samples` | the bound that was actually used |
| `before`, `after` | normalized transport state (`agent_status`, `terminal_id`, `state_change_seq`, `completion_seq`, `revision`, `interactive_ready`, `launch_pending`, `observed_at`); unreported signals stay `null`, never `0`/`false` |
| `detail` | bounded human sentence |

Bound: at most 3 probes, 1 s apart, inside a 3 s window, each probe its own
4 s transport timeout. `normalizeDeliveryObservationPolicy` clamps anything a
caller passes (samples 2–8, interval ≤ 30 s, window ≤ 60 s), so no caller can
turn the loop into a watcher.

Decision order, first match wins (`src/app/collab-delivery-observation.ts`):

| # | Condition | Receipt | Reason |
| --- | --- | --- | --- |
| 1 | the transport outcome does not establish a submission (`blocked`/`refused`/`failed`) | `unknown` | `submission_not_established` |
| 2 | recipient was launching / not interactive-ready before | `unknown` | `recipient_not_ready` |
| 3 | before reading lacks `terminal_id` or `state_change_seq` | `unknown` | `signals_unavailable` |
| 4 | recipient was already `working` | `unknown` | `recipient_already_working` |
| 5 | recipient was `blocked` | `unknown` | `recipient_blocked` |
| 6 | before status is not `idle`/`done` | `unknown` | `recipient_state_unknown` |
| 7 | a probe fails / the name is gone / pane, harness, cwd or session changed | `unknown` | `probe_failed`, `target_missing`, `target_identity_changed`, `target_session_changed` |
| 8 | a sample lacks counters | `unknown` | `evidence_incomplete` |
| 9 | `terminal_id` differs from before | `unknown` | `terminal_changed` |
| 10 | a sample is not interactive-ready | `unknown` | `recipient_not_ready` |
| 11 | `working` **and** `state_change_seq` advanced past the before value | **`taken`** | `turn_observed` |
| 12 | `working` without a moved counter | `unknown` | `evidence_incomplete` |
| 13 | status moved, but not into `working` | `unknown` | `recipient_state_changed` |
| 14 | `state_change_seq`, `completion_seq` or `revision` moved while at rest | `unknown` | `unattributed_activity` |
| 15 | the window expired before the sample budget was collected | `unknown` | `window_expired` |
| 16 | all samples quiet, budget complete | **`not_taken`** | `no_observed_turn` |

Only two of these can produce a positive or negative receipt, and both need
correlation the API can supply: same name, pane, harness, cwd, native session and
terminal, a rest state before, and an unbroken observation window.

## Ordering against #17

1. The **before** reading is the roster entry `verifyLiveParticipant` already
   validated. The observation adds no call and no await between the last
   admission check and the prompt, so the #17 window is unchanged.
2. The delivery status is written by `finalizeDelivery` immediately after the
   prompt returns, exactly as before this change. The reservation is therefore
   **not** held open during observation — the old race window is neither widened
   nor shifted.
3. Observation then runs as read-only roster reads. A probe never prompts, never
   presses a key and never retries the delivery.
4. The observation is written by a second guarded update
   (`updateReservedAttempt`) that re-reads the record inside the same
   task-private lock, matches its own `reservation_id`, and cannot change
   `status`. A concurrent `notify`/`notify --retry` therefore observes the same
   states as before (`already_recorded`, `in_flight_unknown`, or an operator
   retry), and the two writes serialize on the existing lock.
5. A crash after the status write leaves the attempt without an `observation`,
   which readers treat as unobserved. A crash before it leaves the existing
   `submitting` reservation, unchanged by this task.

## Write scope

| File | Change |
| --- | --- |
| `src/app/collab-delivery-observation.ts` (new) | bounded probe loop, classification, policy normalization |
| `src/app/collab-notify.ts` | receipt signals on `HerdrAgentObservation`, `list({timeoutMs})`, probe closure, observation wiring, `updateReservedAttempt` split, `NotifyResult.observation` |
| `src/schemas/collaboration.ts` | `collabDeliveryObservationSchema`, receipt/reason/state schemas, optional `attempts[].observation` |
| `src/cli/commands/collaboration-message.ts` | one bounded `receipt:` line in the human `notify` output |
| `tests/collab/delivery-observation.test.ts` (new) | classification matrix, wiring, persistence, read contract, bounds |
| `tests/collab/bootstrap-app-cli.test.ts` | one field (`observation: null`) on the existing `NotifyResult` fixture |
| `docs/collaboration-messages.md` | six facts, new "Observed receipt" section, reason codes, read contract |
| `docs/collaboration-reference.md` | receipt observation in the visible-bootstrap delivery step |
| `docs/transport-runtime-boundaries.md` | delivery-record field table, `HerdrTransport` seam note, §3.3 "may claim" |
| `skills/pappra/references/collaboration.md` + `src/assets/integrations/skills/pappra/references/collaboration.md` | observed receipt and the unobserved read contract (byte-identical mirror, enforced by `tests/hosts/skill-mirror.test.ts`) |

Not touched: workspace/machine schema, `doctor`/`status`, configuration-authority
docs (task B), README, `AGENTS.md`, roadmap, package/lockfile, global settings.

## Acceptance results

| # | Requirement | Test | Result |
| --- | --- | --- | --- |
| 1 | an admitted message still submits exactly one pointer and keeps the `submitted`/`consumed`/`taskAccepted` contract | `delivery-observation.test.ts` "a legitimately accepted message still submits one pointer and records taken"; `notify-record-acceptance.test.ts` "notify still forwards one pointer for a message the record accepted" | pass |
| 2 | #17 rejections still reach no transport, create no delivery record and never observe | `notify-record-acceptance.test.ts` (stale epoch, hand-placed envelope, content swap; `listCalls === 0`, no `notifications/*.json`); `delivery-observation.test.ts` "planned notification observes nothing and writes no delivery state" | pass |
| 3 | corroborated receipt, and non-receipt where the API supports it | `delivery-observation.test.ts` "a corroborated turn start is taken…", "a complete quiet window is not_taken…" | pass |
| 4 | missing signal, redraw-only activity, an already working recipient, a changed terminal, wrong identity, an expired window | `delivery-observation.test.ts` "missing signals…", "a moved counter without a turn…", "an already-working recipient…", "a changed terminal identity…", "identity, session and probe problems…", "an expired window…" | pass |
| 5 | an observation failure or timeout never resubmits, keys or fabricates success | "a failed probe leaves the recorded submission and never resends" (one prompt, status `submitted`, receipt `unknown`); "an expired window reports unknown instead of guessing" | pass |
| 6 | old/new delivery records read and stay bounded; no #17/#35 regression | "an older delivery record without an observation still reads as unobserved" (byte-identical file after reading); `notify-record-acceptance.test.ts`, `native-observation-age.test.ts`, `messages.test.ts` unchanged and green | pass |

## Tests run

| Command | Result |
| --- | --- |
| `npx tsc -p tsconfig.build.json --noEmit` and `-p tsconfig.test.json --noEmit` | clean |
| `pnpm source:check` | `Source language policy passed.` |
| `pnpm format:check` | `All matched files use Prettier code style!` |
| `node --test .build/test/tests/collab/*.test.js` (whole collaboration suite) | 789 tests, 786 pass, 0 fail, 3 skipped |
| `node --test .build/test/tests/collab/delivery-observation.test.js` | 21 tests, 21 pass |
| `node --test .build/test/tests/hosts/skill-mirror.test.js .build/test/tests/hosts/pi-bootstrap-extension.test.js` | 20 tests, 20 pass (skill mirror byte-identical) |
| `node --test .build/test/tests/docs/*.test.js .build/test/tests/usage/*.test.js` | 36 tests, 36 pass |

Tests use an injected clock and an injected sleeper, so no test sleeps in real
time: the three-sample window advances a fake clock by exactly 2 000 ms. The
whole-repository gate (`pnpm check`) is left to the coordinator's integration
run, per the task.

## Compatibility

- The observation is additive and optional in the schema
  (`attempts[].observation`). A record written before this change parses
  unchanged, reads as unobserved, and is never rewritten — pinned by the legacy
  record test, which asserts the file bytes are identical after reading.
- Missing evidence is never reported as `unknown` in the record: an absent field
  means "not observed", a present `unknown` means "observed and not provable".
- `submitted` keeps its meaning. `consumed: false` / `taskAccepted: false` stay
  literal, `--retry` and its limit are untouched, and the #7 work-run retry
  policy is not re-implemented or influenced by a `not_taken` result.
- `NotifyResult` gains a required `observation` field (`null` when nothing was
  observed). One existing test fixture needed the field; every other consumer
  reads it as an extra property.
- `HerdrTransport.list()` accepts an optional `timeoutMs`. Implementations that
  ignore it remain assignable, so no test double had to change.

## Live coverage gap

**Not verified live.** No real participant was prompted, so the following are
fixtures and schema evidence, not live proof:

- that a real `herdr agent prompt` produces a rest → `working` transition inside
  the 3 s window on a real Pi, Codex or Claude pane, and what the detection
  latency actually is;
- whether `revision` moves on a pure screen redraw (the code treats revision-only
  movement as `unknown` in either case, so the classification is safe, but the
  claim "a redraw moves it" is inferred from the field's shape, not observed);
- whether `state_change_seq` moves for activity that is not a state change;
- the readiness gate (`recipient_not_ready`) cannot fire from the default
  transport today: `agent list` on 0.9.5 does not report `interactive_ready` or
  `launch_pending`, even though `AgentInfo` allows them. The classification is
  covered by tests and available to any transport that reports those flags; it
  is not exercised by the installed CLI.

**Verified live (read-only):** the field set, types and required-ness of
`AgentInfo` on `herdr 0.9.5` / protocol 22, and the exact key set `agent list`
returns for 9 running agents. That is what the parser and the tests are built
on.

**The experiment that would close the gap** (needs explicit authorization and a
throwaway participant, so it is not run here): bootstrap one isolated pane,
notify it once with observation enabled, and record `before`/`after` plus
`window_ms` for a real turn start; then repeat with a deliberately dropped Enter
to see whether the quiet window still classifies `not_taken`. It must not resend,
press keys or touch any real cohort.

## For the independent reviewer

The two writes, the unknown/`not_taken` boundary and the doc claims are where a
review should aim:

1. Is "status first, observation second, same lock, status never rewritten"
   enough to keep persisted retry semantics unchanged?
2. Is `not_taken` defensible under #20's rule that "no change" must not prove
   non-receipt without sufficient correlation? The condition is: same terminal,
   same name/pane/harness/cwd/session, rest before, three unbroken samples.
3. Is `taken` too weak or too strong? It requires a rest → working transition
   **and** an advanced state counter on the same terminal, and it is explicitly
   not consumption.
4. Are the docs' claims about the API accurate against `herdr 0.9.5`
   (`api schema`, `agent list`), and is the live gap stated precisely?
