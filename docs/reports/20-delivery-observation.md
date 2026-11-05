# Task C report — delivery observation (#20)

Fourth candidate. Coordinator preflight rejected `4ebb888` for its receipt
semantics and budget; the independent review of `7119f93` returned F1–F5 (fixed in
`32444a6`), and the targeted review of `f523532` returned F6–F8, fixed in
`af52665` and now **passed** by the independent technical review. This revision
changes nothing but this report's verification record (D1): the counts, who ran
them, and the one unreproduced failure. The change still alters delivery and
persisted semantics. Independent technical review covered the second write,
injected retry/reservation and write-failure cases, and old-record reads.
Formal Pappra workflow admission and acceptance remain outstanding; real
cross-process concurrency, process-kill crash tests and an old-binary run were
not performed. Nothing was
pushed, no PR was opened, no issue was closed or edited, no release or external
message happened, and no real participant was sent anything.

**Scope of this observation, stated plainly.** It is a manual/API on-demand
observation: `notify --observe`, or a caller passing an observation policy. The
automatic dispatch paths (visible bootstrap, work-execution dispatch, workflow
ack/report/accept) do **not** observe — they notify exactly as before, with no
probe and no wait. Every record this implementation writes keeps
`receipt: unknown`, and there is **no real-host delivery proof**: whether a real
prompt on a real pane starts a turn, how fast, and whether a redraw moves
`revision` all remain unverified, and no live experiment was run.

## Base and head

|                              |                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| repository                   | `/Users/zimm.yu/personal/YU/pappra` (worktree `/private/tmp/pappra-20-observation`)                                                                  |
| branch                       | `codex/20-delivery-observation`, created from `origin/main`                                                                                          |
| base                         | `a351802` — `docs: balance workspace growth and collaborative delivery roadmap (#47)`                                                                |
| first candidate              | `346c704` implementation, `4ebb888` report — rejected by preflight                                                                                   |
| second candidate             | `cec2b81` implementation, `7119f93` report — needs-fix from independent review                                                                       |
| third candidate              | `32444a6` implementation, `f523532` report — targeted review returned F6–F8                                                                          |
| head (implementation)        | `af52665` — `fix(collab): report the most recent attempt and bound the composed detail (#20)`; the branch tip is that commit plus this report commit |
| known merged bases confirmed | `a351802` (PR #47), `366f49f` (PR #40, #17)                                                                                                          |

`origin/main` was already `a351802` when the worktree was created; no other
branch, worktree or uncommitted change was touched. `pnpm dev:setup` prepared this
worktree's local code index and registered the workspace documents; that state
lives under `.pappra/local/` and is gitignored.

## Execution mode

Direct work in one write scope, as the task instructed: the two delivery guards,
the observation and delivery-write path, the message CLI, their tests and the
documents that describe them. No sub-agent, role plan or cohort was started, no
model was launched, and no live delivery experiment was run — including none for
this revision. The independent review of the second write, concurrency, crash and
old-record contracts remains outstanding; the last section names the re-review
entry points.

## F1–F5, item by item

### F1 — the probe budget now reaches the transport

Both delivery guards implemented `list()` without a parameter, so a caller's
remaining observation budget was silently replaced by the transport default.

| Guard                                                       | Before                          | Now                                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `guardedBootstrapTransport` (`src/app/collab-bootstrap.ts`) | `list: () => underlying.list()` | `list: (options) => underlying.list(options)`                                                                                          |
| work-execution guard (`src/app/collab-work-execution.ts`)   | `list: () => transport.list()`  | extracted to `guardedWorkExecutionTransport(transport, finalAuthorityCheck)` with `list: (listOptions) => transport.list(listOptions)` |

Both guards are now exported and tested as the real guard functions, not as
same-shape copies: `tests/collab/transport-guard-passthrough.test.ts` drives the
actual `guardedBootstrapTransport` and `guardedWorkExecutionTransport` values and
asserts the underlying transport received `{ timeoutMs: 777 }` / `{ timeoutMs:
1_234 }` unchanged, and `undefined` when the caller passed nothing. The same file
re-asserts the prompt boundaries that must not move: the work-execution guard
still blocks without a final-authority callback, blocks on a callback that throws
or declines, and forwards exactly once when the callback allows; the bootstrap
guard still refuses a foreign recipient before anything is prompted.
`verifyCaller` forwarding is asserted for both.

### F2 — a broken observation can no longer damage a valid record

| Requirement                                              | Implementation                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| untrusted `detail` is bounded and marked                 | `boundDetail()` in `collab-delivery-observation.ts` shortens only the free-text detail: the observation's own `detail` at 1 024 chars (its schema bound), the attempt `detail` at 4 096 in the write path. A shortened value ends with ` …[truncated]`                                                                                                                                                           |
| never truncate identity or state to make a "legal" value | no identity or state field is ever shortened. An observation whose state is out of schema is rejected by the writer instead of being trimmed into a different value that looks valid                                                                                                                                                                                                                             |
| validate before the atomic publish                       | `writeDelivery` validates the candidate against `pappra/collab-delivery/1` before the temp file is created, and `updateReservedAttempt` pre-checks so it can report the precise code instead of a generic write failure                                                                                                                                                                                          |
| failure keeps the valid status/attempts and says so      | `updateReservedAttempt` now returns a typed outcome (`delivery_state_busy`, `delivery_state_unreadable`, `delivery_record_invalid`, `delivery_state_unwritable`). On failure nothing is written; the result reports `observation: null` and appends `The transport observation (receipt/reason) was not recorded (<code>: <detail>)` to its detail, so an unrecorded value is never presented as stored evidence |

This is not a repository-wide safe-write refactor: it touches the one atomic
publish this surface already owned.

Fault regressions (all in `tests/collab/delivery-observation.test.ts`):

| Fault                                                                               | Test                                                                              | Asserted outcome                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| over-long exception/probe diagnostic                                                | "an over-long diagnostic is bounded and marked, and the observation is kept"      | observation stored, `detail` ≤ 1 024 with the truncation marker, reason `probe_failed`                                                                                                                                     |
| over-long attempt detail                                                            | "an over-long attempt detail is bounded and marked, and the status is kept"       | attempt `detail` ≤ 4 096 with the marker, status `submitted`                                                                                                                                                               |
| observation the schema rejects (300-char status)                                    | "an observation the schema would reject is not recorded, and the status survives" | `observation: null`, detail names `delivery_record_invalid` and `agent_status`, record keeps `submitted` + one attempt with no observation, and a later `notify` reports `already_recorded` — not `delivery_state_invalid` |
| observation write fails (delivery directory made unwritable during the observation) | "a failed observation write leaves the delivery record intact"                    | `observation: null`, detail names `delivery_state_unwritable`, record readable with status `submitted`, later `notify` reports `already_recorded`. Skipped when running as root                                            |
| different attempt keeps its own evidence                                            | "a retry keeps its own attempt and observation"                                   | two attempts, each `submitted` with its own `receipt: unknown` observation, one prompt per attempt                                                                                                                         |
| old record                                                                          | "an older delivery record without an observation still reads as unobserved"       | byte-identical file after reading                                                                                                                                                                                          |

The concurrent-reservation, lock-contention and stale-reservation regressions
stay in `tests/collab/messages.test.ts` and `notify-record-acceptance.test.ts`,
which are unchanged and green.

### F3 — observation is opt-in, with read-back

- **Default off.** `NotifyOptions.observation` is now off when omitted or
  `false`; `notify` sends one pointer and returns with no probe and no extra wait,
  exactly as before this task. Verified by "a notification without an explicit
  request observes nothing and waits for nothing": one `verifyCaller`, one
  `list()` call with no options, one prompt, no observation in the record.
- **Explicit API opt-in** stays: pass a policy (`{}` for the defaults) to observe.
- **CLI opt-in.** The existing flags on this surface are short verbs
  (`--apply`, `--retry`) plus `--caller-pane`; the new flag follows that and is
  `notify --observe`. It is declared in `src/cli/options.ts`, allowed only for the
  `notify` action in `src/cli/collaboration-routing/messages.ts`, rejected for
  other message actions, and rejected by the other command routers
  (`run.ts`, `collaboration-routing/native.ts`,
  `collaboration-routing/execution.ts`) the same way `--retry` already is. No
  global policy framework was introduced.
- **Read-back.** `message read` reports the saved observation of the **most
  recent** attempt together with that attempt's status
  (`receipt: unknown (no_turn_activity_observed), 3 sample(s) over 2000 ms; most
recent attempt submitted`), and `unobserved for the most recent attempt
(<status>)` when that attempt has no observation — see F6. The JSON `delivery`
  object keeps every attempt, so earlier observations stay readable.
  `message list` and `workflow inspect` are untouched, and nothing watches in the
  background.

CLI coverage (`tests/collab/messages-cli.test.ts`): `message read` on a record
with an observation, on a record without one, `message list --observe` rejected
as `invalid_arguments`, `message notify --observe` accepted by routing (outcome
is still the transport's `herdr_unavailable`), and the help text listing
`--observe`.

### F4 — late failure versus late reading

The loop checks a probe's own diagnosis first and the budget second, so the two
are different facts, and both the code comments and the documents now say so:

- a **late failure** keeps `probe_failed` (or `target_missing`,
  `target_identity_changed`, `target_session_changed`): "the read failed" is a
  diagnosis about the probe;
- a **late reading** is recorded as raw evidence but never classified:
  `window_expired`, because the window it was meant to cover has already ended.

Test: "a late failure keeps its diagnosis while a late reading does not" — the
same 4 000 ms overrun on a 3 000 ms window yields `probe_failed` for a failure
and `window_expired` for a reading.

### F5 — the record clock and the budget clock are separate

`options.clock` stamps the record (`attempts[].at`, `created_at`, `updated_at`);
the observation budget runs on its own `now()`, advanced only by the loop's waits.
Neither substitutes for the other: a fixed record timestamp never shortens a
deadline, and a budget reading never rewrites a record timestamp. Tests that need
both to agree must inject both explicitly.

Test: "the record clock and the observation clock stay independent" runs one
notification with `clock = 2026-11-12T08:00:00Z` and an observation clock starting
at `2030-05-06T07:08:09Z`, then asserts the record carries the first and
`started_at`/`ended_at`/`window_ms` the second.

## F6–F8, item by item (targeted review of `f523532`)

### F6 — `message read` reports the most recent attempt

The behaviour was already "last attempt", but the comment, the user document and
the previous report described it as "the attempt that delivered the pointer",
which is a different claim once a retry exists. All three now say the same thing:
the human summary describes the **most recent** attempt and never borrows an
earlier attempt's evidence.

`receipt:` now carries the attempt status it refers to:

- an observation exists: `unknown (reason), N sample(s) over M ms; most recent attempt <status>`;
- no observation: `unobserved for the most recent attempt (<status>)`;
- no delivery at all: `not-notified`.

Regression ("message read summarises the most recent attempt and JSON keeps
earlier evidence", `tests/collab/messages-cli.test.ts`): attempt 1 is `submitted`
with a bounded observation, attempt 2 is a refused `--retry` sent **without**
observation. The human summary prints `receipt: unobserved for the most recent
attempt (refused)` and never prints the earlier `no_turn_activity_observed`; the
JSON result keeps both attempts, with `attempts[0].observation.receipt ===
"unknown"` and no observation on `attempts[1]`.

### F7 — the detail is composed first and bounded once

The previous `finish()` bounded the free-text detail and then appended the
over-run note, so an over-long transport error plus a >600 000 ms elapsed time
produced a detail longer than the schema allows — which the F2 validation would
then reject, losing the real elapsed time and the cap explanation.

`observationDetail()` now builds the complete sentence first and bounds once. The
over-run note is appended _after_ the free-text part has been shortened to leave
room for it, so both facts always survive and the field stays within 1 024
characters. `window_ms` is 600 000 with the true elapsed time in the note.

Test: "an over-long error and an over-run window are both kept inside the bound" —
a 5 000-character probe error with a 700 000 ms probe on a 3 000 ms window yields
`window_ms: 600000`, a detail ≤ 1 024 that contains the truncation marker, the
`capped at 600000 ms` sentence and `ran for 700000 ms`, and an observation that
passes `collabDeliveryObservationSchema`. The companion case ("an over-run window
without a long error keeps the whole note") asserts the exact composed sentence.
Both use the injected clock; nothing waits.

### F8 — the truncation marker is exact and the bound is respected

The old marker printed `text.length - limit` as the removed count, which
understated the cut by the marker's own length, and the arithmetic had to be
computed against the space the count itself consumes. The marker is now
` …[truncated]` with no number: it cannot misreport, and `boundDetail` returns a
value of at most `limit` characters (exactly `limit` when it shortens, by
construction). A bound smaller than the marker still returns a bounded value
rather than overshooting.

Test: "the truncation marker is exact and never exceeds the field bound" asserts
the exact length, the marker suffix, the kept prefix, the pass-through case, the
`null` case and the degenerate small-bound case.

## What the observation still says (unchanged from `cec2b81`)

`receipt` is `unknown` on every path. A Herdr roster read is agent-level: no
signal names the prompt that caused a state change, a turn can be started by
another message or by a human, and a pointer typed into the input without a
started turn looks exactly like one that was never typed. The record keeps the
raw before/after state, the sample count, the window and a closed reason
(`turn_activity_observed`, `no_turn_activity_observed`, or an `unknown` reason).
`taken`/`not_taken` stay defined for a transport that can correlate a state
change with one message; nothing here emits them.

## Preserved boundaries

#17 record acceptance (content digest, closed `applied`/`recorded` allow-list),
the no-transport refusals, the final revalidation before submission, and #35
reused-observation freshness are untouched. One pointer per attempt, no resend,
no key press, no automatic takeover, `consumed: false` / `taskAccepted: false`
literal, and the `--retry` policy are unchanged. The observation still starts
after the delivery status is durable, so the reservation window is not widened.

## Verification

Every number below names who ran it and on which candidate. A count this author
did not run is attributed to the reviewer who did, never presented as the
author's own run.

| Check                                                                                                                            | Result                                                                                                                                         | Executed by              | Candidate                                                    |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------ |
| `npx tsc -p tsconfig.build.json --noEmit` and `-p tsconfig.test.json --noEmit`                                                   | clean                                                                                                                                          | author                   | `d0673c8` (F6–F8 report)                                     |
| `pnpm source:check`                                                                                                              | `Source language policy passed.`                                                                                                               | author                   | `d0673c8`                                                    |
| `pnpm format:check`                                                                                                              | `All matched files use Prettier code style!`                                                                                                   | author                   | `d0673c8`                                                    |
| `node --test --test-concurrency=4 .build/test/tests/collab/*.test.js`                                                            | **807 tests, 804 pass, 0 fail, 3 skipped**                                                                                                     | author                   | `d0673c8`                                                    |
| `node --test .build/test/tests/collab/delivery-observation.test.js .build/test/tests/collab/transport-guard-passthrough.test.js` | **37 tests, 37 pass**                                                                                                                          | **independent reviewer** | F6–F8 candidate (`af52665` implementation, `d0673c8` report) |
| the same pair, before the three F7/F8 tests existed                                                                              | 34 tests, 34 pass                                                                                                                              | author                   | `f523532` (F1–F5 candidate)                                  |
| `delivery-observation.test.js` alone, after the F7/F8 tests were added                                                           | 34 tests, 34 pass                                                                                                                              | author                   | `d0673c8`                                                    |
| `node --test .build/test/tests/collab/messages-cli.test.js`                                                                      | 3 tests, 3 pass (read-back of a saved observation and of an old record, the `--observe` routing cases, and the most-recent-attempt regression) | author                   | `d0673c8`                                                    |
| directed set: `delivery-observation`, `transport-guard-passthrough`, `messages-cli`, `hosts/skill-mirror`, `docs/*`, `cli/*`     | 86 tests, 86 pass                                                                                                                              | author                   | `d0673c8`                                                    |
| `git diff --check` (working tree, then `f523532..HEAD`)                                                                          | no whitespace errors                                                                                                                           | author                   | `d0673c8`                                                    |

The explicit 37/37 pair count is the reviewer's independent result for this
candidate. The author never ran that exact two-file invocation after adding the
three F7/F8 tests: the author's last pair run predates them (34/34 at `f523532`),
and the added tests were verified by the author through the single-file run
(34/34) and, together with the guard tests, inside the 86-test directed set above
— so the pair's 37 tests did pass in the author's runs, but the pair figure itself
is quoted from the reviewer rather than restated as an author command.

### One unreproduced single-run failure

The first full collaboration run on this candidate reported **807 tests, 803
pass, 1 fail, 3 skipped**. That run's output was piped through a summary filter,
so the failing test's name and message were never captured and cannot be
reported; the run log was not kept.

Three subsequent runs of the same command each reported **807 / 804 / 0 fail /
3 skipped**, and a timing-sensitive subset (`pane-reclaim`, `workflow-await`,
`recovery-executor`, `process`) reported 71/71. The failure did not reproduce.

This is recorded as an unreproduced single-run failure at `d0673c8`. It is not
inferred to be a pre-existing problem, not attributed to a specific test, and not
treated as evidence of stability either.

### Documentation formatting

`docs/` is in `.prettierignore`, so `pnpm format:check` does not cover it. The
changed documents were formatted and then checked explicitly:

```sh
npx prettier --write --ignore-path /dev/null \
  docs/reports/20-delivery-observation.md \
  docs/collaboration-messages.md \
  docs/collaboration-reference.md \
  docs/transport-runtime-boundaries.md \
  skills/pappra/references/collaboration.md
# docs/collaboration-messages.md 255ms (unchanged)
# docs/collaboration-reference.md 186ms (unchanged)
# docs/transport-runtime-boundaries.md 65ms
# skills/pappra/references/collaboration.md 68ms (unchanged)

npx prettier --check --ignore-path /dev/null \
  docs/collaboration-messages.md docs/collaboration-reference.md \
  docs/transport-runtime-boundaries.md \
  skills/pappra/references/collaboration.md \
  src/assets/integrations/skills/pappra/references/collaboration.md
# All matched files use Prettier code style!
```

The skill reference mirror is byte-identical (`cmp` clean) and
`tests/hosts/skill-mirror.test.ts` passes. The whole-repository gate
(`pnpm check`) is left to the coordinator's integration run.

## Diff against `f523532`

Two report-only revisions follow `af52665`: the F6–F8 report commit and this D1
correction (verification counts, their executor, and the unreproduced failure).
Neither changes code.

The implementation diff is the targeted fixes only: the composed-then-bounded detail and the numberless
truncation marker (`src/app/collab-delivery-observation.ts`), the
most-recent-attempt summary (`src/cli/commands/collaboration-message.ts`), their
tests, the read-back wording in `docs/collaboration-messages.md` and the skill
reference (+ mirror), and this report. No schema, admission or retry change.

## Diff against `7119f93`

18 files, +1 112/−115: the two guards (F1), the observation module and the
delivery write path (F2/F4/F5), the notify default and result composition (F2/F3),
the message CLI and option routing (F3), their tests, and the four documents plus
the skill reference and its mirror.

## Remaining limits and unverified scope

- **No message-level correlation**, so `receipt` is `unknown` for every record
  this implementation writes; `taken`/`not_taken` are define-but-unreachable.
- **The readiness gate is inert for the default transport**: `agent list` on
  0.9.5 reports neither `interactive_ready` nor `launch_pending`.
- **No cancellation path**: a transport that ignores the requested timeout can
  overrun the window; the record states the elapsed time rather than claiming a
  hard bound. The forwarded budget in F1 only helps a transport that honours it.
- **Not verified live**: that a real `herdr agent prompt` produces a rest →
  working transition inside the window and what the latency is; whether
  `revision` moves on a pure redraw; the server/session/workspace the earlier
  read-only roster came from, and whether the inspecting shell was inside Herdr.
  The live experiment that would close this needs explicit authorization and a
  throwaway participant; it was not run.
- **Not exercised end-to-end**: the bootstrap guard's prompt path is covered by
  the visible-bootstrap suite, while the F1 test drives its read path with a
  minimal context because `BootstrapContext` is internal. The work-execution guard
  is covered on both paths.

## Review record and outstanding questions

1. F1: is forwarding `list(options)` in both guards sufficient, and does the
   extraction of `guardedWorkExecutionTransport` preserve the prompt/authority
   behaviour exactly?
2. F2: is "validate the candidate before the atomic publish, bound only free
   text, reject out-of-schema state, report `observation: null` plus a
   not-recorded reason" the right shape — and is the 1 024/4 096 bound split
   acceptable?
3. F3: is `--observe` the right opt-in name and routing, and is `message read`
   the right (and only) read-back surface?
4. F4/F5: are the late-failure/late-reading distinction and the two-clock
   responsibilities documented as narrowly as the code delivers them?
5. ~~F6/F7/F8: most-recent-attempt read-back, composed-then-bounded detail, and
   the numberless truncation marker.~~ Passed the independent technical review;
   this revision only corrects the verification record it was asked to fix.
6. Formal Pappra workflow admission and coordinator acceptance remain
   outstanding. Prior independent technical review includes injected
   second-write/retry cases and old-record reads; it is not evidence of real
   cross-process pressure, process-kill crash tests or an old-binary run.
