# Reuse-first project adoption

Adopt the project's existing rules, documents and validation commands before
adding integration. This recipe uses existing CLI surfaces; it neither changes
the product's dependencies nor requires a graph, host wiring or collaboration.
Use [task context](task-context.md) for the evidence retained from this assessment.

## Select the target before applying

Record the canonical workspace root, the selected repository id and checkout
path, the starting Git revision and existing modifications. The process cwd
selects the workspace for commands without a root option; a repository id then
selects a declared checkout inside it. A Pappra development checkout is only the
CLI source, not the target workspace. Never infer the target from another chat,
the last session, or the location of the CLI executable.

Read the target's existing `AGENTS.md` or equivalent rules, package scripts,
curated design/roadmap documents and any `.pappra/workspace.json` first. Preserve
their meaning and unrelated keys. Do not replace project instructions with this
skill, add product dependencies just to adopt Pappra, or register every discovered
checkout. Select only the repositories and document sources needed for the task;
exclude generated output, vendored dependencies and unrelated worktrees.

In a target workspace, with its explicitly selected installed CLI:

```sh
pappra init --print-choices --json
pappra init --config /absolute/private/adoption-choices.json --no-runtime --json
```

The first command discovers choices without writing. Keep a reviewed
`pappra/init-choices/1` document at the second path and narrow it before planning.
For an existing configuration, `pappra init --print-choices --reconfigure --json`
prints the represented choices; use those as the starting point. Record why each
repository, document source and validation candidate was selected or omitted,
plus the observed baseline and any unresolved prerequisites, before any apply.

The no-graph baseline selects `code.graph: "none"`, `code.symbols: "none"`,
`hosts: []` and private task visibility in that choices document. Keep the
explicit selected repository entry even without an index. Checkpoint/resume and
knowledge records do not require CodeGraph. Review `knowledge.sources` as existing
inputs and `knowledge.newDocuments` as the destination for future authored
documents; init does not create that destination.

Only within the user's authorized setup scope, apply the reviewed plan:

```sh
pappra init --config /absolute/private/adoption-choices.json --no-runtime --apply --json
pappra doctor --json
pappra docs scan --json
```

`--no-runtime` leaves runtime verification, installation and binding pending;
configuration-only success does not prove the runtime or host is ready. Existing
valid workspace configuration is reused unless `--reconfigure` is explicitly
requested. Do not add that flag merely to make a plan pass. Inspect conflicts
and pending external actions rather than deleting state or installing engines.
Runtime installation, optional engine preparation and host wiring are separate
decisions, not adoption prerequisites. Pappra's own `pnpm dev:setup` is specific
to its development checkout and is not a generic target-project bootstrap.

## Register and verify only the intended knowledge

`docs scan --json` is the noninteractive plan; `docs scan --apply --json`
registers the selected existing documents when authorized. It never accepts
changed bytes for an existing registration. Inspect those with `docs check` and
use explicit document review when warranted, preserving the original content.

Private document details are hidden by default. Opt in deliberately when the
task requires them:

```sh
pappra docs list --include-private --json
pappra docs check --include-private --json
```

Omitting private details is not evidence that no documents exist. Local private
records and task artifacts under `.pappra/local/` are distinct from shared
configuration and knowledge records. `--include-private` permits inspection in
this output; it does not authorize copying that output into a shared artifact,
assignment, issue or message. Check the actual source visibility before sharing.

## Keep navigation and validation claims bounded

For a declared repository, inspect and query its selected code entry before
falling back, including when the graph selection is `none`:

```sh
pappra code status --repo selected-repo --json
pappra code query --repo selected-repo --kind explore --query 'Relevant symbol or question' --limit 10 --max-bytes 12000 --json
```

Replace `selected-repo` with the declared id. `ready` is a navigation aid, not
complete coverage. After the query, record missing, stale, unsupported or clipped
coverage and fill only the actual gap with bounded current source reads. In a
deliberate no-graph baseline, record that selection and use bounded text or
structure reads; do not build an unrelated index or borrow another workspace.
Preparing the optional engine is a separate explicit action.

`doctor` is read-only diagnosis. A configured validation entry is an execution
candidate, not permission to run it; a healthy doctor result proves neither that
tests ran nor that their commands are trusted. Check the command, arguments,
checkout binding and current task authorization before execution. Keep unrun
checks and unavailable services visible. Setup success alone is not an accepted
implementation task or proof that the project's remaining roadmap is unblocked.
