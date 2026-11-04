# Task C report — delivery observation (#20)

Third candidate. Coordinator preflight rejected `4ebb888` for its receipt
semantics and budget; the independent review of `7119f93` then returned a
needs-fix set (F1–F5), fixed here in `32444a6`. This change still alters delivery
and persisted semantics, so it stops here and awaits the targeted re-review.
Nothing was pushed, no PR was opened, no issue was closed or edited, no release or
external message happened, and no real participant was sent anything.

## Base and head

|                              |                                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| repository                   | `/Users/zimm.yu/personal/YU/pappra` (worktree `/private/tmp/pappra-20-observation`)                                                                               |
| branch                       | `codex/20-delivery-observation`, created from `origin/main`                                                                                                       |
| base                         | `a351802` — `docs: balance workspace growth and collaborative delivery roadmap (#47)`                                                                             |
| first candidate              | `346c704` implementation, `4ebb888` report — rejected by preflight                                                                                                |
| second candidate             | `cec2b81` implementation, `7119f93` report — needs-fix from independent review                                                                                    |
| head (implementation)        | `32444a6` — `fix(collab): forward the probe budget, protect the delivery record, observe on request (#20)`; the branch tip is that commit plus this report commit |
| known merged bases confirmed | `a351802` (PR #47), `366f49f` (PR #40, #17)                                                                                                                       |

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
| untrusted `detail` is bounded and marked                 | `boundDetail()` in `collab-delivery-observation.ts` shortens only the free-text detail: the observation's own `detail` at 1 024 chars (its schema bound), the attempt `detail` at 4 096 in the write path. A shortened value ends with ` …[truncated N chars]`                                                                                                                                                   |
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
- **Read-back.** `message read` reports the saved observation for the delivered
  attempt (`receipt: unknown (no_turn_activity_observed), 3 sample(s) over
2000 ms`) and `receipt: unobserved` when the record has none — an old record and
  a notification sent without `--observe` look the same and neither becomes an
  `unknown` receipt. The JSON `delivery` object already carries the observation.
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

| Command                                                                                                                          | Result                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `npx tsc -p tsconfig.build.json --noEmit`, `-p tsconfig.test.json --noEmit`                                                      | clean                                                                          |
| `pnpm source:check`                                                                                                              | `Source language policy passed.`                                               |
| `pnpm format:check`                                                                                                              | `All matched files use Prettier code style!`                                   |
| `node --test --test-concurrency=4 .build/test/tests/collab/*.test.js`                                                            | 803 tests, 800 pass, 0 fail, 3 skipped                                         |
| `node --test .build/test/tests/collab/delivery-observation.test.js .build/test/tests/collab/transport-guard-passthrough.test.js` | 34 tests, 34 pass                                                              |
| `node --test .build/test/tests/collab/messages-cli.test.js`                                                                      | 2 tests, 2 pass (includes the two read-back and two `--observe` routing cases) |
| `node --test .build/test/tests/hosts/skill-mirror.test.js .build/test/tests/docs/*.test.js .build/test/tests/cli/*.test.js`      | 46 tests, 46 pass                                                              |

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

## For the targeted re-review

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
5. Still outstanding for the independent review: the second write, concurrency,
   crash windows and old-record reads.
