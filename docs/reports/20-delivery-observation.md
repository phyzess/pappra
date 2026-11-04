# Task C report — delivery observation (#20)

Second candidate. The coordinator preflight of `4ebb888` rejected the first one
for two defects, both reproduced here and fixed in `cec2b81`. This change still
alters delivery and persisted semantics, so it stops here and awaits the
coordinator's preflight and an independent review. Nothing was pushed, no PR was
opened, no issue was closed or edited, no release or external message happened,
and no real participant was sent anything.

## Base and head

|                              |                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| repository                   | `/Users/zimm.yu/personal/YU/pappra` (worktree `/private/tmp/pappra-20-observation`)                                                           |
| branch                       | `codex/20-delivery-observation`, created from `origin/main`                                                                                   |
| base                         | `a351802` — `docs: balance workspace growth and collaborative delivery roadmap (#47)`                                                         |
| first candidate              | `346c704` implementation, `4ebb888` report — rejected by preflight                                                                            |
| head (implementation)        | `cec2b81` — `fix(collab): keep receipt unknown and bound the observation budget (#20)`; the branch tip is that commit plus this report commit |
| known merged bases confirmed | `a351802` (PR #47), `366f49f` (PR #40, #17)                                                                                                   |

`origin/main` was already `a351802` when the worktree was created; no other
branch, worktree or uncommitted change was touched. `pnpm dev:setup` prepared
this worktree's local code index and registered the workspace documents; that
state lives under `.pappra/local/` and is gitignored.

## Execution mode

Direct work in one tightly coupled write scope, as the task instructed. No
sub-agent, role plan or cohort was started, no model was launched, and no live
delivery experiment was run — including none for this revision. The independent
review remains outstanding and belongs to the coordinator; the last section
names what it should attack.

## What changed against `4ebb888`

| File                                                                                                                                                                                                | Change                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/collab-delivery-observation.ts`                                                                                                                                                            | `receipt` is now `unknown` on every path; the two activity reasons were renamed (`turn_activity_observed`, `no_turn_activity_observed`); the budget now covers waits and probes; a reading that arrives after the budget is recorded but never classified; `probeTimeoutMs` moved into the policy so the loop can clamp it; `window_ms` is the real elapsed time, capped at the schema bound with the true value in `detail` |
| `src/app/collab-notify.ts`                                                                                                                                                                          | the probe closure receives its budget from the observation loop and passes it to `transport.list({ timeoutMs })`; the separate probe-timeout option and constant were removed                                                                                                                                                                                                                                                |
| `src/schemas/collaboration.ts`                                                                                                                                                                      | receipt/reason semantics documented on the schema: `taken`/`not_taken` are message-level receipts that no supported transport can produce, and the two activity reasons replace the previous names                                                                                                                                                                                                                           |
| `tests/collab/delivery-observation.test.ts`                                                                                                                                                         | rewritten: 23 tests, including the three counter-examples and the injected-clock deadline matrix                                                                                                                                                                                                                                                                                                                             |
| `docs/collaboration-messages.md`, `docs/collaboration-reference.md`, `docs/transport-runtime-boundaries.md`, `skills/pappra/references/collaboration.md` (+ byte-identical `src/assets/...` mirror) | the receipt claim is withdrawn; the reason table, the budget guarantees and the read contract are stated instead                                                                                                                                                                                                                                                                                                             |

Nothing else was touched: no new protocol field, no new transport operation, no
retry, resend, key press, watcher or background poll.

## Phase 1 — what a supported Herdr actually exposes

Read-only inspection only. No prompt, no `send-keys`, no `agent wait`, no
transcript read, no experiment against a live participant.

| Evidence                                                      | Result                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `herdr --version`                                             | `herdr 0.9.5` (`/opt/homebrew/bin/herdr`)                                                                                                                                                                                                                          |
| `herdr api schema --json`                                     | `protocol: 22`, `schema_version: 1`, five schemas (`error_response`, `event`, `request`, `subscription_event`, `success_response`)                                                                                                                                 |
| `herdr agent list` (live, values not printed)                 | 9 agents. Keys observed: `agent`, `agent_session`, `agent_status`, `cwd`, `focused`, `foreground_cwd`, `pane_id`, `revision`, `screen_detection_skipped`, `state_change_seq`, `tab_id`, `terminal_id`, `terminal_title`, `terminal_title_stripped`, `workspace_id` |
| same call                                                     | `completion_seq` appeared only where non-null; `interactive_ready` and `launch_pending` appeared in no entry; no entry exposed a `name`                                                                                                                            |
| `herdr agent --help`, `agent get --help`, `agent wait --help` | `agent get <target>` exists; `agent wait --until <state>` waits indefinitely unless `--timeout` is passed                                                                                                                                                          |

### Basis of that read-only call, and what it does not establish

The three commands above were run from this worktree through the installed
`herdr` binary with no `--session`, `--machine` or `--remote` flag, so the CLI
used its own default resolution. I did **not** record `herdr status`,
`herdr session list` or the process environment (`HERDR_ENV`, `HERDR_PANE_ID`) at
that moment, so **which server, session or workspace those 9 agents belonged to,
and whether this shell was itself inside Herdr, is unverified**. The `agent get`
attempt used an empty target — the roster exposed no names — and returned an
error envelope, so it produced no additional evidence and was not retried; no
other server or participant was queried afterwards.

The `api schema` output is bundled with the installed CLI, so it is evidence
about what version 0.9.5 _declares_, not about any running session. The field
_kinds_ and their required-ness below come from that schema; the fact that
`agent list` returns some of them comes from the read above.

| Field               | Type                                        | Required | Declared meaning                                                                  |
| ------------------- | ------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `agent_status`      | `idle`/`working`/`blocked`/`done`/`unknown` | yes      | what the agent is doing                                                           |
| `state_change_seq`  | `uint64`, default `0`                       | no       | counter of detected state changes                                                 |
| `completion_seq`    | `uint64` \| `null`                          | no       | "The current idle transition completed work, independently of who has viewed it." |
| `terminal_id`       | `string`                                    | yes      | identity of the terminal the agent runs in                                        |
| `revision`          | `uint64`                                    | yes      | per-agent update counter                                                          |
| `interactive_ready` | `boolean`                                   | no       | whether the pane accepts input                                                    |
| `launch_pending`    | `boolean`                                   | no       | whether the agent is still launching                                              |
| `agent_session`     | `{source, agent, kind, value}`              | no       | reported native session                                                           |

### Why these signals cannot become a receipt

- **No message-level correlation.** The counters are per agent, not per prompt.
  A turn that starts after a pointer is submitted may have been started by that
  pointer, by another message, or by a human at the keyboard.
- **No input-box visibility.** Nothing in the API says whether the pointer text
  is sitting unsubmitted in the input; `agent read` would expose another agent's
  terminal content, which #20 keeps out of scope.
- **No queue truth.** A queued-but-unread pointer and a dropped Enter are
  indistinguishable from outside.

So the observation records what it saw and refuses to name a receipt:
`turn_activity_observed` (a turn started on that terminal, cause unknown),
`no_turn_activity_observed` (no turn started inside the window; a queued pointer
looks the same), or an `unknown` reason for everything that cannot be compared.

### The six facts, kept separate

| Fact                                  | Written by                                                                  | Never collapsed into          |
| ------------------------------------- | --------------------------------------------------------------------------- | ----------------------------- |
| persisted                             | `send --apply` → `submitMessage`                                            | notification                  |
| notified/submitted                    | `notify --apply` → one pointer handed to a transport                        | consumed                      |
| observed transport activity (**new**) | bounded roster observation after the submission; `receipt` always `unknown` | submitted, consumed, accepted |
| consumed/acknowledged                 | the recipient's own `ACK`                                                   | delivery                      |
| reported                              | the recipient's `REPORT`                                                    | acceptance                    |
| accepted                              | the coordinator's explicit decision                                         | anything on this surface      |

## Phase 2 — representation, classification and the budget

`pappra/collab-delivery-observation/1` is stored on the delivery attempt it
describes (`attempts[].observation`, optional, strict): `receipt` (always
`unknown` from a roster read), a closed `reason`, `source`, `started_at`,
`ended_at`, `window_ms`, `samples`, `before`/`after` state, and a bounded
`detail`. Unreported signals stay `null`, never `0`/`false`.

Decision order, first match wins (every branch returns `receipt: unknown`):

| #   | Condition                                                                  | Reason                                                                                |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | the transport outcome does not establish a submission                      | `submission_not_established`                                                          |
| 2   | recipient launching / not interactive-ready (only where a read reports it) | `recipient_not_ready`                                                                 |
| 3   | before reading lacks `terminal_id` or `state_change_seq`                   | `signals_unavailable`                                                                 |
| 4   | recipient was already `working`                                            | `recipient_already_working`                                                           |
| 5   | recipient was `blocked`                                                    | `recipient_blocked`                                                                   |
| 6   | before status is not `idle`/`done`                                         | `recipient_state_unknown`                                                             |
| 7   | probe failed / target gone / pane, harness, cwd or session changed         | `probe_failed`, `target_missing`, `target_identity_changed`, `target_session_changed` |
| 8   | a sample lacks counters                                                    | `evidence_incomplete`                                                                 |
| 9   | `terminal_id` differs from before                                          | `terminal_changed`                                                                    |
| 10  | a sample is not interactive-ready                                          | `recipient_not_ready`                                                                 |
| 11  | `working` with `state_change_seq` advanced past the before value           | `turn_activity_observed`                                                              |
| 12  | `working` without a moved counter                                          | `evidence_incomplete`                                                                 |
| 13  | status moved, but not into `working`                                       | `recipient_state_changed`                                                             |
| 14  | `state_change_seq`, `completion_seq` or `revision` moved while at rest     | `unattributed_activity`                                                               |
| 15  | the budget was spent before a sample could be classified                   | `window_expired`                                                                      |
| 16  | all samples quiet, budget complete                                         | `no_turn_activity_observed`                                                           |

### The budget covers waiting and probing

`windowMs` is a deadline, not just a sleep total. With the defaults — 3 samples,
1 s apart, 3 s window, 4 s probe cap:

1. Before any wait, the loop checks the remaining budget; no budget ends the
   observation as `window_expired`.
2. Each probe receives `min(probeTimeoutMs, remaining budget)`, so a cooperating
   transport cannot stretch the window; `notify` passes that number to
   `herdr agent list`'s own timeout.
3. After the probe returns, a reading later than the deadline is kept as raw
   evidence (`after`, `samples`) but is never classified: the outcome is
   `window_expired`. The first preflight reproduction (a 3000 ms window whose
   first probe returned `working` at 4000 ms) now records no activity
   conclusion, and the second (a third quiet probe returning at 5000 ms) is not a
   quiet window either.
4. `window_ms` is the real elapsed time.

**What this guarantees:** no probe is started without budget; no probe is asked
for more time than remains; no conclusion is formed from a late reading; an
observation whose probes answer inside their timeout is bounded by the window
plus scheduling noise.

**What it cannot guarantee:** `notify` has no cancellation channel into a
transport. A transport that ignores the requested timeout, or hangs before it can
enforce one, can overrun the window. The record then states the elapsed time
(capped at the schema bound of 600 000 ms, with the true value in `detail`) and
the reason stays `window_expired` — there is no unconditional hard wall-clock
limit, and the code no longer implies one.

## Ordering against #17 (unchanged)

1. The **before** reading is the roster entry `verifyLiveParticipant` already
   validated: no extra call and no extra await between the last admission check
   and the prompt.
2. `finalizeDelivery` writes the delivery status immediately after the prompt
   returns, exactly as before, so the reservation is not held open during
   observation and the old race window is neither widened nor shifted.
3. Observation runs afterwards as read-only roster reads; a probe never prompts,
   presses a key or retries.
4. The observation is written by a second guarded update
   (`updateReservedAttempt`) that re-reads the record under the same task-private
   lock, matches its own `reservation_id`, and cannot change `status`.
5. A crash after the status write leaves the attempt without an `observation`,
   which readers treat as unobserved. #35 freshness is untouched: the
   observation adds no reused native observation and no new age bound.

## Write scope

`src/app/collab-delivery-observation.ts` (new), `src/app/collab-notify.ts`,
`src/schemas/collaboration.ts`, `src/cli/commands/collaboration-message.ts`
(one bounded `receipt:` line in the human `notify` output),
`tests/collab/delivery-observation.test.ts` (new),
`tests/collab/bootstrap-app-cli.test.ts` (one `observation: null` field on the
existing `NotifyResult` fixture), and the four documentation files plus the skill
reference and its byte-identical asset mirror. Not touched: workspace/machine
schema, `doctor`/`status`, configuration-authority docs (task B), README,
`AGENTS.md`, roadmap, package/lockfile, global settings.

## Acceptance results

| #   | Requirement                                                                                                               | Test                                                                                                                                                                                                                                                                                                                                                    | Result |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | an admitted message still submits exactly one pointer and keeps the `submitted`/`consumed`/`taskAccepted` contract        | "an admitted message still submits one pointer and keeps the delivery contract"; `notify-record-acceptance.test.ts` "notify still forwards one pointer for a message the record accepted"                                                                                                                                                               | pass   |
| 2   | #17 rejections still reach no transport, create no delivery record and never observe                                      | `notify-record-acceptance.test.ts` (stale epoch, hand-placed envelope, content swap; `listCalls === 0`, no `notifications/*.json`); "planned notification observes nothing and writes no delivery state"                                                                                                                                                | pass   |
| 3   | corroborated receipt / non-receipt are **not** claimed; only activity is                                                  | "a started turn stays unknown: no roster signal ties it to this pointer"; "a queued pointer with no started turn is unknown, not non-receipt"                                                                                                                                                                                                           | pass   |
| 4   | missing signal, redraw-only activity, an already working recipient, a changed terminal, wrong identity, an expired window | "missing signals leave the receipt unknown without any probe", "a moved counter without a turn stays unknown rather than activity", "a working sample that cannot be attributed to the pointer stays unknown", "a blocked or unready recipient is never treated as activity", "identity, session and probe problems stay unknown with their own reason" | pass   |
| 5   | an observation failure or timeout never resubmits, keys or fabricates a conclusion                                        | "a failed probe leaves the recorded submission and never resends" (one prompt, status `submitted`, reason `probe_failed`); the six budget tests                                                                                                                                                                                                         | pass   |
| 6   | old/new records read and stay bounded; no #17/#35 regression                                                              | "an older delivery record without an observation still reads as unobserved" (byte-identical file after reading); the collaboration suite below                                                                                                                                                                                                          | pass   |

### Counter-examples the preflight asked for

| Case                                                        | Test                                                                      | Recorded outcome                                                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| the same recipient is woken by another input                | "another input waking the recipient is activity, never receipt"           | `receipt: unknown`, `turn_activity_observed`, detail names another input and says it is not receipt                                         |
| the pointer is queued but no turn started                   | "a queued pointer with no started turn is unknown, not non-receipt"       | `receipt: unknown`, `no_turn_activity_observed`, detail says a queued pointer looks the same                                                |
| a `working` state that cannot be attributed to this pointer | "a working sample that cannot be attributed to the pointer stays unknown" | `recipient_already_working`, then `terminal_changed`, then `evidence_incomplete` — all `unknown`                                            |
| a slow probe passes the deadline reporting a started turn   | "a probe that returns after the budget is recorded but never classified"  | `window_expired`, raw `working` state kept, no activity reason                                                                              |
| the last quiet probe overruns                               | "a final quiet probe that overruns is not a quiet window either"          | `window_expired`, not `no_turn_activity_observed`                                                                                           |
| the window is spent before a probe                          | "the window can be exhausted before a probe starts"                       | `window_expired`, 1 sample, no second probe                                                                                                 |
| a transport that hangs                                      | "a transport that hangs records the overrun instead of claiming a bound"  | `window_expired`, `window_ms` 30 000 with a 3 000 budget; a 700 000 ms overrun is recorded at the 600 000 cap with the true value in detail |

## Tests run

| Command                                                                                                                        | Result                                          |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `npx tsc -p tsconfig.build.json --noEmit` and `-p tsconfig.test.json --noEmit`                                                 | clean                                           |
| `pnpm source:check`                                                                                                            | `Source language policy passed.`                |
| `pnpm format:check`                                                                                                            | `All matched files use Prettier code style!`    |
| `node --test --test-concurrency=4 .build/test/tests/collab/*.test.js`                                                          | 791 tests, 788 pass, 0 fail, 3 skipped          |
| `node --test .build/test/tests/collab/delivery-observation.test.js`                                                            | 23 tests, 23 pass                               |
| `node --test .build/test/tests/hosts/skill-mirror.test.js .../pi-bootstrap-extension.test.js .build/test/tests/docs/*.test.js` | 30 tests, 30 pass (skill mirror byte-identical) |

### Documentation formatting, as instructed

`docs/` is listed in `.prettierignore`, so the previous report's
`pnpm format:check` result did **not** cover these files — that claim was
wrong. The four changed documents were formatted explicitly, with the real
output:

```sh
npx prettier --write --ignore-path /dev/null \
  docs/reports/20-delivery-observation.md \
  docs/collaboration-messages.md \
  docs/collaboration-reference.md \
  docs/transport-runtime-boundaries.md
# docs/reports/20-delivery-observation.md 71ms
# docs/collaboration-messages.md 107ms
# docs/collaboration-reference.md 150ms
# docs/transport-runtime-boundaries.md 90ms

npx prettier --check --ignore-path /dev/null \
  docs/reports/20-delivery-observation.md \
  docs/collaboration-messages.md \
  docs/collaboration-reference.md \
  docs/transport-runtime-boundaries.md \
  skills/pappra/references/collaboration.md \
  src/assets/integrations/skills/pappra/references/collaboration.md
# Checking formatting...
# All matched files use Prettier code style!
```

Prettier reflowed existing tables in those three long documents as well as the
sections this task changed; that part of the diff is formatting only. The skill
reference required no reformatting, and its `src/assets` mirror was re-synced
after the content edit (`cmp` clean, and `tests/hosts/skill-mirror.test.ts`
passes).

Tests use an injected clock and an injected sleeper, so no test sleeps in real
time: the three-sample window advances the fake clock by exactly 2 000 ms, and an
overrunning probe advances it by its scripted cost. The whole-repository gate
(`pnpm check`) is left to the coordinator's integration run, per the task.

## Compatibility

- The observation stays additive and optional (`attempts[].observation`). An
  attempt recorded before this change parses unchanged, reads as unobserved, and
  is never rewritten — pinned by the legacy-record test, which asserts the file
  bytes are identical after reading. An absent field is "not observed"; a
  present `unknown` is "observed and not attributable".
- A record written by `346c704` with the old reason names would not validate
  against the renamed enum. Those values only ever existed in this unmerged
  branch, so no released record can carry them; the coordinator's own
  reproduction records were built from this branch and must not be treated as
  fixtures for the new schema.
- `submitted` keeps its meaning; `consumed: false` / `taskAccepted: false` stay
  literal; `--retry` and its limit are untouched; the #7 work-run retry policy is
  neither re-implemented nor influenced by an observation.
- `NotifyResult` keeps a required `observation` field (`null` when nothing was
  observed). `HerdrTransport.list()` keeps its optional `timeoutMs`; the value
  now comes from the observation budget instead of a separate option.

## Remaining limits

- **No message-level correlation exists**, so `receipt` is `unknown` for every
  record this implementation can write. `taken`/`not_taken` are schema-defined
  and unreachable until a transport can correlate a state change with a specific
  message; a reviewer should confirm that keeping them defined-but-unreachable is
  preferable to removing them.
- **The readiness gate is inert for the default transport**: `agent list` on
  0.9.5 reports neither `interactive_ready` nor `launch_pending`, so
  `recipient_not_ready` cannot fire from it. The classification is tested and
  available to a transport that reports the flags.
- **No cancellation path**: a transport that ignores the requested timeout can
  overrun the window; the record states it rather than pretending otherwise.
- **Not verified live**: whether a real `herdr agent prompt` produces a
  rest → working transition inside the window on a real Pi/Codex/Claude pane and
  what the detection latency is; whether `revision` moves on a pure redraw
  (revision-only movement forces `unknown` either way, so the classification is
  safe, but the claim is inferred from the field's shape); the
  server/session/workspace those 9 agents belonged to, and whether the inspecting
  shell was inside Herdr.
- **The experiment that would close the live gap** (needs explicit authorization
  and a throwaway participant, so it is not run here): bootstrap one isolated
  pane, notify it once with observation enabled, and record `before`/`after` and
  `window_ms` for a real turn start; repeat with a deliberately dropped Enter to
  confirm the quiet window still cannot distinguish a queued pointer. It must
  resend nothing, press no key and touch no real cohort.

## For the coordinator preflight and the independent reviewer

1. Is `receipt: unknown` everywhere now the right reading of "no message-level
   correlation", and are the two activity reasons enough to keep the observation
   useful without smuggling a receipt back in?
2. Does the budget truly cover waits and probes (the four checks above), and is
   the stated guarantee — bounded when the transport honours its timeout, honest
   overrun when it does not — the accurate claim?
3. Are the counter-examples (another input, a queued pointer, an unattributable
   working state) covered by behaviour rather than by comments?
4. For the independent review this still needs: the second write, concurrency,
   crash and old-record-read contracts, none of which the preflight accepts on
   its own.
