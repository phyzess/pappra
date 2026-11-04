# Task B report — configuration authority boundary (#21)

Candidate, not accepted. This task concerns authorization, so it stops here:
implementation is committed locally and awaits an independent review by a fresh
context. Nothing was pushed, no PR was opened, no issue was closed, and no
release or external message happened.

## Base and head

| | |
| --- | --- |
| repository | `/Users/zimm.yu/personal/YU/pappra` (worktree `/tmp/pappra-21-config-authority`) |
| branch | `codex/21-config-authority`, created from `origin/main` |
| base | `a351802` — `docs: balance workspace growth and collaborative delivery roadmap (#47)` |
| head | `8a4ba7b` — `feat(config): classify configuration authority by layer (#21)`; the branch tip is that commit plus this report commit |
| known merged bases confirmed | `a351802` (PR #47), `366f49f` (PR #40, #17) |

The worktree was created fresh from `origin/main` after `git fetch --prune`;
`origin/main` was already `a351802` and the primary checkout was clean. No other
branch, worktree or uncommitted change was touched.

## Execution mode

Direct work in one tightly coupled write scope, as the task instructed. No
sub-agent was started, and no role plan or cohort was created. Independent
review remains outstanding and belongs to the coordinator.

## What the task asked to check first

Reused rather than rewritten:

- `docs/host-native-boundaries.md` (#29) — the host/Pappra ownership split. This
  change adds the configuration-layer split beside it and does not restate the
  execution policy.
- `src/workspace/validation.ts`, `src/app/doctor.ts` (`workspace.validation`) —
  both already promise that candidates are not executed, PATH-resolved or proven
  runnable. That promise is now pinned by a test instead of only asserted.
- `src/schemas/workspace.ts`, `src/schemas/machine.ts`, `src/workspace/config.ts`
  — the strict schemas and the fail-closed inspection path. No wire format
  changed.

Existing state per acceptance item:

| Requirement | State before this change |
| --- | --- |
| Classification of every field | missing; no per-field inventory existed |
| Test that fails on an unclassified field | missing |
| Test pinning "committed layer cannot execute a validation entry" | missing (the non-execution claim was prose only) |
| Source-layer reporting for multi-layer values | missing; only per-file `source` on two doctor checks |

## Behaviour change

`pappra doctor` gains one check, `workspace.authority`
(`doctor_config_authority`):

```
Shared .pappra/workspace.json classifies 20 field(s): 7 descriptive, 12
authority-bearing (10 command-gated, 0 checkout-local-binding, 2 with no consumer
today) and 1 open container. 9 machine.json field(s) are classified as
checkout-local. No field is defined in both layers; 3 read-time composition(s)
keep their own source layer (external-repository-location,
continuity-checkout-identity, runtime-archive-inspection-version). No validation
executable was resolved, spawned or executed.
```

- Status `ok` / severity `info` in the normal case, so `doctor` exit codes and
  `needs_attention` classification are unchanged.
- Status `warning` / severity `warning` only when the classification table and
  the schemas disagree — a code defect the tests already fail on, surfaced at
  runtime as well.
- `configuration-authority` was added to `scope.checked`, and the not-registered
  branch reports the check as not checked with the same title.
- No executable is resolved, spawned or executed by the new check. No validation
  entry runs anywhere.

`src/schemas/config-authority.ts` adds the classification contract:

- `kind`: `descriptive`, `access-candidate`, `execution-candidate`, `selection`,
  `local-binding`, `open-container`.
- `gate`: `none`, `explicit-command`, `local-binding`, `no-consumer`. There is
  deliberately no "already effective because it is committed" value.
- `configSchemaFields()` walks the real zod shapes (unwrapping optional,
  nullable, default and readonly; marking array elements with `[]`; stopping at
  open containers), so the table is checked against the schema instead of a
  hand-copied list.
- `CROSS_LAYER_VALUE_COMPOSITIONS` records the three values assembled from more
  than one layer at read time.

## Acceptance results (#21)

| #21 item | Result | Evidence |
| --- | --- | --- |
| `docs/` classifies every `workspace.json` and `machine.json` field and states the invariant, linked from `docs/api.md` or `docs/operations.md` | done | `docs/configuration-authority.md` (20 shared + 9 private fields, invariant, open-container rule, compositions); linked from `docs/api.md` "Configuration authority" and `docs/operations.md` |
| A test fails if a field is added to either schema without a classification | done | `inspectConfigAuthority()` reports `unclassified`/`stale` against the walked schemas; `classifies every workspace.json and machine.json field` asserts both are empty, and `a field added without a classification is reported as drift` proves the mechanism detects a removed entry and a ghost entry |
| A test pins that the committed layer alone cannot cause a validation entry to be executed | done | marker test: `a committed validation entry is never executed by doctor or discovery` writes a `workspace.json` whose `validation[0].executable` is an executable marker script, then runs `inspectWorkspaceConfig`, `discoverWorkspace`, `runDoctor` in-process and the `pappra doctor` CLI; the marker file never appears and the report states nothing was executed |
| `workspace status` or `doctor` reports the source layer for effective values from more than one layer, or the docs say explicitly that none exists | done, both ways | docs state that no field is defined in both layers and list the three read-time compositions with their source layer; `doctor` reports the same facts in `workspace.authority`, and `workspace.config`/`workspace.machine` keep their own file as `source` |

Additional invariant pinned by `the committed layer never activates an
authority-bearing field by itself`: every shared authority-bearing field must be
gated by `explicit-command`, `local-binding` or `no-consumer`, and every
authority-bearing field must have an enabling condition.

## Files

| File | Change |
| --- | --- |
| `src/schemas/config-authority.ts` | new: field table, schema walker, coverage/violation inspection, summaries, cross-layer compositions |
| `src/schemas/index.ts` | export the new module |
| `src/schemas/errors.ts` | add `doctor_config_authority` |
| `src/app/doctor.ts` | `workspace.authority` check, `scope.checked` entry, not-registered title |
| `tests/workspace/config-authority.test.ts` | new: 8 tests (coverage, drift detection, invariant, summaries, compositions, marker non-execution, layer reporting, not-checked branch) |
| `docs/configuration-authority.md` | new: the contract |
| `docs/api.md`, `docs/operations.md` | links to the contract |

Untouched, as instructed: `src/app/collab-notify.ts`, notify/transport tests,
collaboration message/reference docs, skill mirrors, README, `AGENTS.md`, central
roadmap docs, `package.json`, `pnpm-lock.yaml`, global configuration,
`src/app/init.ts`, and every schema shape.

## Commands and results

All commands ran in `/tmp/pappra-21-config-authority` against this worktree's own
`dist/` and `.build/`; no shared build output was reused.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --prefer-offline` | ok, 7.1 s from the local store; no dependency version changed, no network install observed |
| `pnpm dev:check` (before setup) | 2 actions: code index missing, 34 documents unregistered |
| `pnpm dev:setup` | ok, converged: codegraph index ready, 34/34 documents registered |
| `node dist/cli/main.js code status --repo pappra --json` | `ok:true`, `health.state: ready`, engine codegraph 1.4.1 |
| `node dist/cli/main.js code query --repo pappra --kind explore --query "workspace and machine config fields, validation candidate execution and effective source precedence" --json` | `ok:true`, coverage partial (`explore_output_clipped`); caller/relationship data was sufficient and was filled in with bounded source reads |
| `pnpm typecheck` | pass (build, test and script projects) |
| `pnpm source:check` | pass. One earlier failure: the word `any` in a doc comment matched the policy's `any` guard; the comment was reworded, policy unchanged |
| `pnpm format:check` | pass |
| `pnpm build` | pass |
| `node --test .build/test/tests/workspace/*.test.js .build/test/tests/doctor/*.test.js` | 85 tests, 85 pass, 0 fail |
| `node --test .build/test/tests/workspace/config-authority.test.js .build/test/tests/doctor/*.test.js` | 42 tests, 42 pass, 0 fail |
| `node dist/cli/main.js doctor --json` in this worktree | `workspace.authority` = ok; `workspace.validation` still reports "none are executed" |
| `pnpm dev:check` after the change and an explicit `docs review --apply` of the two edited docs | converged, 35/35 registered |

Not run: the full `pnpm check` / integration gate. The task assigns one full gate
at the release boundary to the coordinator, and running it here would race other
workers' builds.

Local-only state created by `dev:setup` / `docs review` lives under the ignored
`.pappra/local/`, `.codegraph/`, `dist/` and `.build/`; nothing there is part of
the commit.

## Limits and what this does not claim

- This is not a report of a present validation-execution vulnerability. Nothing
  executed a validation entry before this change and nothing does now.
- The marker test covers the entries that exist today (configuration inspection,
  workspace discovery, `doctor` in process and the `doctor` CLI). It does not
  prove that a future code path could never execute a candidate; the coverage
  table, the invariant and the docs state what such a feature owes.
- `extensions` is classified as an open container. Interior keys are not
  enumerated and no claim is made about arbitrary extension content; a future
  consumer must classify its own keys first.
- `code.prepare` and `continuity.autoResume` are classified `no-consumer`.
  Neither is honoured today (`init`/`--reconfigure` only preserve them; resume
  decisions read the checkout-private task pin). If either gains a consumer, it
  must be gated in the private layer first.
- `doctor`'s passive runtime-archive inspection still falls back from
  `runtimeVersion` to `machine.runtime.version`. That behaviour was left
  unchanged and is documented as a read-time composition; it does not change
  which runtime is installed, bound or executed.
- `repositories[].access` remains a policy ceiling. This change documents that it
  is not operating-system isolation; it does not add an isolation layer.
- No configuration wire format changed, no automatic validation execution was
  added, and no earlier beta state was migrated.

## Where a reviewer should look hardest

1. `src/schemas/config-authority.ts` — whether the table's claims match the code:
   especially `repositories[].path` (`explicit-command` plus a private binding for
   `external:<id>`), `repositories[].access` (policy ceiling, not a grant),
   `runtimeVersion` (target selection, binding lives in `machine.json`),
   `extensions` (open container, no interior claim), and both `no-consumer`
   entries. A wrong classification is the failure mode this issue exists to
   prevent, and the test can only check consistency, not correctness of the note.
2. `inspectConfigAuthority()` — whether the walker can silently under-report:
   it unwraps optional/nullable/default/readonly and stops at records and
   unknown values. A schema construct it does not model would surface as a leaf
   path and fail the coverage test rather than pass quietly; confirm that is
   true for anything added later.
3. The distinction between "tested" and "proved": the non-execution pin is a
   marker test over current entrypoints, plus prose in the docs about future
   code. It must not be read as a general execution guarantee.
4. `workspace.authority` in `src/app/doctor.ts` — that it is genuinely
   information-only (status `ok`, severity `info`, no exit-code effect), that its
   `source` and evidence name the right layers, and that it cannot fail closed in
   a way that blocks unrelated work.
5. Scope: no shared file outside the listed set changed; the parallel task C
   files (notify/transport, collaboration message and reference docs, skill
   mirrors) are untouched.
