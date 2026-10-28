# AGENTS.md

Project-owned policy for every coding agent working in this repository. It
complements the user's instructions; the user's instructions take precedence.

## Start from the project's own capabilities

1. Read this repository's `skills/pappra/SKILL.md`, not a globally installed copy.
   Use `pnpm dev:check` to inspect project skill aliases, the selected index and
   workspace knowledge. `pnpm dev:setup` applies the owned setup described in
   [docs/development.md](docs/development.md); missing builds and engines remain
   explicit prerequisites.
   In this checkout, use `node dist/cli/main.js` for every Pappra operation,
   including collaboration; examples using bare `pappra` are shorthand, not an
   instruction to use an older globally installed executable.
2. Establish the project code entry before navigating source, with the repository
   CLI rather than an older global `pappra` binary:

   ```sh
   node dist/cli/main.js code status --repo pappra --json
   node dist/cli/main.js code query --repo pappra \
     --kind explore --query "<symbol or question>" --json
   ```

   `ready` is a navigation aid, not proof of complete coverage. Run the query
   before declaring the index stale or unavailable. Fill actual stale, missing
   or clipped coverage with bounded current source reads. Known-file reads need
   no additional exploration query. Never build an unrelated index or borrow
   another workspace to hide a missing result.

## Assess before nontrivial work

Before a change that is not a trivial, reversible, local edit, assess the actual
work: current behaviour, callers and tests in the blast radius, whether the change
is one write scope or several disjoint ones, and whether risk (release, protocol,
security, persistence, cross-cutting behaviour) warrants an independent reviewer.

- Coordination artifacts (briefs, request JSON, scratch) are the coordinator's
  direct work; keep those edits simple, reversible and free of ceremony.
- Repository source is implemented by participants, never by the coordinator
  itself. The coordinator assesses, plans, writes briefs, dispatches, accepts
  or rejects reports, and runs the single final integration gate;
  implementation and review are done by other participants, visible Pi peers
  by default. Small trivially-local edits are not exempt for repository source
  in this project.

A single write scope does not remove the need for independent review. Changes
to authorization, resource ownership, persisted state/recovery or release
execution require an independent review before completion, performed by a
separate reviewer participant through Pappra's workflow using observed native
participants. For disjoint implementation scopes, delegate them to different
writers when doing so reduces the critical path. Record this choice before
implementation. A review-only assignment can itself be that independent
review; it does not need another reviewer recursively.

If no capable participant can be launched, the coordinator reports the exact
blocker instead of implementing itself. If the native channel, identity or
required capability is unavailable, report the exact blocker and retain the
outstanding review requirement. Do not silently substitute self-review,
self-implementation, a different harness or an unrelated global tool.

## Independent implementation and review

Roles and participants are chosen from the real work split, never from a fixed
count. For a new cohort, prefer the typed workflow entry described in
[docs/collaboration-workflow.md](docs/collaboration-workflow.md):

```sh
node dist/cli/main.js collab workflow prepare --request <abs prepare.json> [--apply] --json
node dist/cli/main.js collab workflow dispatch --request <abs dispatch.json> [--apply] --json
node dist/cli/main.js collab workflow inspect --task-root <abs task root> --json
```

Participants use its `ack`, `report` and `release` actions; the coordinator makes
an explicit `accept` decision. Observed identities and current native capability
evidence remain prerequisites. Use the existing lower-level commands for manual
protocol operations and recovery; there is no role daemon:

```sh
node dist/cli/main.js collab role-plan expand --request <abs role-plan.json> --json
node dist/cli/main.js collab plan --task-root <abs> --config <abs expanded-plan.json> --json
node dist/cli/main.js collab work-run --request <abs work-execution.json> [--apply] --json
node dist/cli/main.js collab role-run --request <abs role-orchestration.json> [--apply] --json
node dist/cli/main.js collab role-plan aggregate --request <abs role-plan.json> \
  --task-root <abs> --config <abs expanded-plan.json> --json
```

- Disjoint write scopes belong to different writers; shared or dependent work does
  not. Add a separate acceptance/reviewer participant when risk warrants it.
- Roles describe responsibility and scope. They grant no authority, approve
  nothing, and pick no participant by themselves.
- A registered `ASSIGN`, an `ACK`, a `REPORT`, or a submitted notification is not
  acceptance. Acceptance stays an explicit coordinator decision.
- Agent ids, native sessions, capability cards and claim holders come from
  observed evidence. Never invent them from prose, and never substitute a
  different harness (for a Codex subagent, for example) for a participant the task
  named.

When the workflow bootstraps a visible sibling pane, placement is adaptive and
keeps the coordinator readable. `--ratio` is the fraction the original pane
keeps. The first split of the caller pane goes `right` with ratio 0.6, so the
coordinator keeps roughly half the tab width or more, and once a task-owned
sibling exists the coordinator pane is never split again. Later siblings split
the largest task-owned sibling (ties go to the earliest created) along its
longer visual dimension (`right` when its width exceeds twice its height,
else `down`) at ratio 0.5. Refuse an anchor whose result would be narrower
than 40 columns or shorter than 10 rows; when no sibling can host another
pane, the bootstrap reports `pane_layout_exhausted` and tells the host to
close or reclaim finished panes instead of squeezing the coordinator. An
explicit `target.direction` keeps the legacy caller split exactly, and
geometry that cannot be read falls back to a right split of the caller with
ratio 0.6 rather than failing the launch. A task-owned sibling is a pane the
task's own launch reservations created that is still present in the layout.

When the coordinator starts Pi participants it picks a suitable GLM or Kimi
model explicitly (`--provider openrouter --model moonshotai/kimi-k2.7-code`
for code work, `~z-ai/glm-latest` for general work, `moonshotai/kimi-k3` for
long-context review) and never falls back to a default model silently.

## Authorization and safety

- Use checks for the affected behavior during implementation. Coordinate one
  full integration gate at the release boundary rather than running the entire
  suite in each worker. Respect the user's requested test cadence. Shared
  `dist/` and `.build/` rebuilds must not race other participants' builds or tests.

- Authorization the user already gave for a task persists for that task. Do not
  re-request the same delegation on every step.
- No approval is auto-answered, no cancellation is inferred from an
  acknowledgement, and no destructive or irreversible action is taken without
  explicit user intent.
- Preserve user settings, unrelated files and existing modifications.

## What the product does not do

Hooks record bounded lifecycle observations and never select roles or launch
models. The backend validates explicitly requested assignments and launches;
it does not infer semantic roles or choose participants. The host agent chooses
roles and requests dispatch through the commands above.
