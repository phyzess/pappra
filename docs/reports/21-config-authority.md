# Task B report — configuration authority boundary (#21)

Status: **fix candidate committed, awaiting independent re-review.** Not
accepted, not pushed, no PR, no merge, no issue change, no release or external
message.

This file has three evidence sections that must not be merged: what the first
candidate claimed (round 1), what the reviewer found, and what this round
actually ran (round 2). Where a round-1 statement turned out to be wrong, it is
marked as such instead of being quietly rewritten.

## Base, candidate, head

|                               |                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| repository                    | `/Users/zimm.yu/personal/YU/pappra` (worktree `/tmp/pappra-21-config-authority`)                                                    |
| branch                        | `codex/21-config-authority` (continued; no rebase, no reset)                                                                        |
| base                          | `a351802` — `docs: balance workspace growth and collaborative delivery roadmap (#47)`                                               |
| round-1 candidate (reviewed)  | `15ecefb` — `docs(report): record the #21 configuration authority candidate`                                                        |
| round-1 implementation commit | `8a4ba7b` — `feat(config): classify configuration authority by layer (#21)`                                                         |
| round-2 head                  | `94ec898` — `fix(config): fail closed on unmodelled schema constructs (#21)`; the branch tip is that commit plus this report commit |

## Round 1 — what the reviewed candidate claimed

The implementation commit `8a4ba7b` and the report commit `15ecefb` added:

- `src/schemas/config-authority.ts`: a per-field `kind`/`gate` table for the 20
  `workspace.json` and 9 `machine.json` field paths, a walker over the zod
  shapes, `CROSS_LAYER_VALUE_COMPOSITIONS`, and coverage/violation inspection.
- `workspace.authority` in `pappra doctor`, `doctor_config_authority`
  diagnostic code, `configuration-authority` in `scope.checked`.
- `tests/workspace/config-authority.test.ts` with 8 tests, including a marker
  test for non-execution.
- `docs/configuration-authority.md` plus links from `docs/api.md` and
  `docs/operations.md`.

Round-1 evidence that still holds: 85 workspace+doctor tests passed,
`pnpm typecheck`, `pnpm source:check`, `pnpm format:check` and `pnpm build`
passed, and the marker test observed no execution.

Round-1 statement that was **wrong** (this is F1): the round-1 report said "A
schema construct it does not model would surface as a leaf path and fail the
coverage test rather than pass quietly". The walker actually pushed every
unmatched construct into the leaf list, so a classified leaf replaced by a union
kept the coverage check green. Round-1 also reported `pnpm format:check` as
covering the new docs; `docs/` is in `.prettierignore`, so it never did.

## Round 2 — reviewer findings

| id                  | finding                                                                                                                                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1                  | the schema walker can silently miss: a classified leaf replaced by a union (or another unmodelled construct) containing object fields still returned the original path, so the coverage check could pass incorrectly                                                                                 |
| F2                  | `doctor` wording conflated three different claims (static classification, test coverage, runtime observation); "no field is defined in both layers" was undefined and would be wrong if read as "no name is repeated"; "no validation executable was executed" read like a completed execution audit |
| F3                  | the marker test depended on unrelated doctor checks for a fixed total exit code 1, so it pinned the wrong thing                                                                                                                                                                                      |
| F1/F2 documentation | docs and report claimed coverage that the formatter does not actually apply to `docs/`                                                                                                                                                                                                               |

F4/F5 were explicitly out of scope for this round.

## Round 2 — changes

| File                                       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/schemas/config-authority.ts`          | walker replaced with a closed allowlist: `object`, `array`, `optional`, `nullable`, `default`, `readonly`, scalar definition types (`string` incl. `uuid`/`iso.datetime`, `number`, `bigint`, `boolean`, `date`, `literal`, `enum`, `null`, `undefined`, `void`, `never`), and `record`/`unknown`/`any` as one open boundary. Every other construct is reported as `ConfigUnsupportedField { path, construct }` and is never flattened into a leaf. `scanConfigSchema()` replaces `configSchemaFields()` and returns `{ fields, unsupported }`. `inspectConfigAuthority(sources?)` emits an explicit violation per unsupported construct, keeps such a path out of `stale` (so the message names the construct, not a missing entry), and reports `duplicatePaths` (names present in both layers) without treating them as failures |
| `src/app/config-authority-check.ts`        | new internal module (not re-exported) holding `configAuthorityCheck`; accepts an optional `inspection` so a candidate can be rendered as a check, and keeps the check wording in one place                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/app/doctor-check.ts`                  | new internal module holding the moved `CheckInput`, `truncateText`, `makeCheck`, `fileEvidence`. Pure move out of `doctor.ts`; `doctor.ts` imports them and its exported surface is unchanged (`runDoctor`, `DoctorOptions` before and after)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/app/doctor.ts`                        | imports the two modules, passes `inspectConfigAuthority()` to the check, no other behaviour change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tests/workspace/config-authority.test.ts` | 12 tests (round 1 had 8): added the unsupported-construct regression, the root-unsupported case, the controlled-warning check, and the "current schemas use only modelled constructs" assertion; CLI assertions decoupled from exit code; summary assertions updated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `docs/configuration-authority.md`          | new "Asserted, pinned, observed" section, the allowlist and unsupported-construct rule, the precise meaning of "no field path in both layers" (with `schema` named as the only overlap), and the corrected coverage-test sentence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `docs/reports/21-config-authority.md`      | this file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

What did **not** change: configuration wire formats, the field classification
decisions themselves, the doctor exit-code contribution of the check (still
`ok`/`info`, or `warning` only when the contract and the schemas disagree), the
validation discovery code, `src/app/collab-notify.ts`, notify/transport tests,
collaboration message/reference docs, skill mirrors, README, `AGENTS.md`, central
roadmap docs, dependencies and global configuration.

### F1 evidence

The reviewed walker was rebuilt from `15ecefb` in a throwaway worktree (temporary
directory, removed afterwards) and run against a candidate schema whose
`runtimeVersion` leaf became `z.union([z.string(), z.strictObject({...})])`:

```
OLD walker fields: [{"path":"name","open":false},{"path":"runtimeVersion","open":false}]
OLD gaps for that table: {"unclassified":[],"stale":[]}
```

Both coverage lists are empty, so the check passed with an unclassified interior
— the reviewer's finding reproduced, not guessed.

The same candidate against this round's code:

```
NEW scan: {"fields":[{"path":"name","open":false}],"unsupported":[{"path":"runtimeVersion","construct":"union"}]}
NEW violations: [".pappra/candidate-workspace.json: runtimeVersion uses the unmodelled schema construct \"union\"; the classification (selection) cannot cover its interior"]
```

### F2 evidence

The check now opens with `Static field classification of the two configuration
schemas, not a runtime observation:`, names the overlapping paths with their
meaning (`Field path(s) occurring in both files: schema; a repeated name is not
by itself one effective value, and each overlap needs its own read-path
evidence.`), and scopes its own observation (`it resolved, spawned and executed
nothing, and it is not an execution audit of another code path.
Non-execution of validation candidates is pinned by tests over current
entrypoints, not observed here.`). `coverage` reads `schema field
classification; nothing resolved or executed; candidate non-execution is
test-pinned`.

`docs/configuration-authority.md` now states what "no field in both layers"
means (no field _path_ in both schemas), names `schema` as the only repeated name
with its independent literal per file, and separates asserted / test-pinned /
observed in a table.

### F3 evidence

The marker test no longer asserts a total exit code. It asserts the CLI process
completed without a signal, produced no stderr, emitted parseable JSON with
schema `pappra/doctor-report/1`, ran the whole check set (`checks.length >= 10`,
both `workspace.validation` and `workspace.authority` present), reported
`workspace.authority` as `ok`, and that the marker file still does not exist. A
crash or an empty/failed run fails the test through the parse and completion
assertions; running the marker fails it through the marker assertion.

## Round 2 — commands and results

All commands ran in `/tmp/pappra-21-config-authority` against this worktree's own
`dist/` and `.build/`.

| Command                                                                                                                                               | Result                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck`                                                                                                                                      | pass (build, test and script projects)                                                                                                                                                                                                                             |
| `pnpm source:check`                                                                                                                                   | pass                                                                                                                                                                                                                                                               |
| `pnpm format:check`                                                                                                                                   | pass — but `docs/` is in `.prettierignore`, so the repository-wide check never looks at this report or the new doc page                                                                                                                                            |
| `./node_modules/.bin/prettier --check --ignore-path /dev/null docs/configuration-authority.md docs/reports/21-config-authority.md docs/operations.md` | pass (explicit, ignore overridden — this is the check that actually applies)                                                                                                                                                                                       |
| `./node_modules/.bin/prettier --check --ignore-path /dev/null docs/api.md`                                                                            | **fails, and failed at base `a351802` too** (long table rows are not prettier-padded). Not reformatted, per instruction; the added section was verified not to be rewritten by prettier (`prettier --ignore-path /dev/null` diff contains none of the added lines) |
| `pnpm build`                                                                                                                                          | pass                                                                                                                                                                                                                                                               |
| `node --test --test-concurrency=4 .build/test/tests/workspace/*.test.js .build/test/tests/doctor/*.test.js`                                           | 89 tests, 89 pass, 0 fail (round 1: 85)                                                                                                                                                                                                                            |
| `node --test .build/test/tests/workspace/config-authority.test.js`                                                                                    | 12 tests, 12 pass, 0 fail                                                                                                                                                                                                                                          |
| `node dist/cli/main.js doctor --json` in this worktree                                                                                                | `workspace.authority` = `ok` / `info`, summary as quoted above; `workspace.validation` still reports "none are executed"                                                                                                                                           |
| old-walker reproduction (temporary worktree at `15ecefb`, removed afterwards)                                                                         | reproduced the silent pass, output quoted above                                                                                                                                                                                                                    |

Not run: the full `pnpm check` / integration gate and a full `pnpm test` run. The
coordinator schedules one integration gate; running it here would race other
workers' builds.

Local-only state under the ignored `.pappra/local/`, `.codegraph/`, `dist/` and
`.build/` is not part of the commit. `docs/` registration state in
`.pappra/local` was updated by the project's own `dev:setup` / `docs review`
commands; it is local review bookkeeping, not acceptance of this change.

## Limits and what this does not claim

- Not a report of a present validation-execution vulnerability. Nothing executed
  a validation entry before or after this change.
- The walker is a closed allowlist, not a zod interpreter. It models the
  constructs listed above; anything else is reported as unsupported. Extending it
  is a deliberate change with a test, not an automatic consequence of a zod
  update.
- The marker test covers configuration inspection, workspace discovery,
  `doctor` in process and the `doctor` CLI. It does not prove that a future code
  path could never execute a candidate, and it asserts process completion rather
  than an exit code.
- The `workspace.authority` check is a static classification report plus a
  per-file observation. It is not an execution audit, and a clean result says
  nothing about code paths it does not read.
- `extensions` remains an open boundary: interior keys are not enumerated and no
  claim is made about arbitrary extension content.
- `code.prepare` and `continuity.autoResume` remain `no-consumer`; `init` and
  `--reconfigure` only preserve them, and resume decisions read the
  checkout-private task pin.
- The passive runtime-archive inspection still falls back from `runtimeVersion`
  to `machine.runtime.version`; that behaviour is unchanged and documented as a
  read-time composition.
- `repositories[].access` is still a policy ceiling, not operating-system
  isolation.
- `docs/api.md` is not prettier-clean at the base commit; it was not reformatted.

## Delta scope for the original reviewer

1. `src/schemas/config-authority.ts` — the allowlist itself: is it the right
   closed set, does it match the constructs the two schemas actually use, and is
   the fallthrough truly fail-closed (unsupported reported, never a leaf)? Check
   the `definitionType` fallback (`unmodelled`) and the `stale`-exclusion rule.
2. `src/app/config-authority-check.ts` and `src/app/doctor-check.ts` — the
   `makeCheck`/`fileEvidence` move is meant to be pure; confirm `src/app/doctor.ts`
   still exposes only `runDoctor`/`DoctorOptions`, that no new name reaches
   `@phyzess/pappra/doctor`, and that the check cannot change `doctor`'s exit
   code unless the contract and schemas disagree.
3. F2 wording — whether the three claims are now genuinely separate and whether
   the "no field path in both files / `schema` is an independent literal" sentence
   is accurate and stays accurate if a field is added to both layers.
4. F3 test — whether the CLI assertions would still catch a real regression
   (crash, no report, marker executed) now that the exit code is not pinned.
5. `docs/configuration-authority.md` and this report — that no claim outruns the
   tests, and that the formatter statement is honest about `docs/` being ignored
   by default and about `docs/api.md`.
