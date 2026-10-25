# AGENTS.md

Project-owned policy for every coding agent working in this repository. It
complements the user's instructions; the user's instructions take precedence.

## Start from the project's own capabilities

1. Read this repository's `skills/pappra/SKILL.md`, not a globally installed copy.
   Use `pnpm dev:check` to inspect project skill aliases, the selected index and
   workspace knowledge. `pnpm dev:setup` applies the owned setup described in
   [docs/development.md](docs/development.md); missing builds and engines remain
   explicit prerequisites.
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

- Simple, reversible, local change: implement it directly. Do not add
  coordination ceremony to small work.
- Cohesive work without an independent slice can stay with the current agent.
  Use Pappra's role commands when independent implementation or review is
  justified by the assessment.

## Independent implementation and review

Roles and participants are chosen from the real work split, never from a fixed
count. The installed commands are the whole surface; there is no role daemon:

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

## Authorization and safety

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
