# Configuration authority

Pappra keeps configuration in two layers with different owners. This page
classifies every field of both layers, states the invariant that separates a
shared proposal from an authorization, and records which values are composed
from more than one layer. It is the reference behind the `workspace.authority`
check in `pappra doctor` and behind
[src/schemas/config-authority.ts](../src/schemas/config-authority.ts).

## Two layers

| Layer | File | Who can write it | Shared |
| --- | --- | --- | --- |
| shared | `.pappra/workspace.json` | anyone who can commit to the repository, including an agent editing files | yes, through version control |
| private | `.pappra/local/machine.json` | only the person or process working in this checkout; `.pappra/local/` is ignored | no |

Both files are strict schemas (`pappra/workspace/1`, `pappra/machine/1`). An
unknown key is an error with migration advice, not a silent default.

## The invariant

> A committed `workspace.json` entry may propose authority-bearing behaviour. It
> never enables it. Enabling needs an explicit command, a value from this
> checkout's private layer, or an explicit user decision — and, where the
> behaviour touches the host, the current capability conditions as well.

Three consequences follow, and each is pinned below:

1. A shared declaration is a candidate, not a grant. `validation[].executable`
   names a command; no current entrypoint resolves or runs it.
2. `repositories[].access` is a policy ceiling. It says what Pappra will offer
   for a checkout. It is not operating-system isolation, it does not change file
   permissions, and it grants nothing the filesystem did not already allow.
3. The existence of a private file is not a universal authorization. A
   `machine.json` value binds a local identity, path or verified artifact; it
   does not make a committed declaration runnable, and a missing or mismatched
   file fails closed instead of falling back.

This is not a report of a present validation-execution vulnerability: nothing
executes validation entries today. It is the rule any future feature must
follow.

## Field classification

Each field is classified by what the value *is* (`kind`) and by what it cannot
do on its own (`gate`).

| kind | meaning |
| --- | --- |
| `descriptive` | a label, identity marker, format literal or recorded preference; enables nothing |
| `access-candidate` | names something Pappra may read or write, or the policy ceiling for it |
| `execution-candidate` | names something that may be executed |
| `selection` | chooses an engine, host or document visibility policy |
| `local-binding` | binds this checkout to a local identity, path or verified artifact |
| `open-container` | an open container whose interior is not part of the schema contract |

| gate | meaning |
| --- | --- |
| `none` | descriptive only |
| `explicit-command` | consumed only when a specific Pappra command runs |
| `local-binding` | inert until a value from this checkout's private layer binds it |
| `no-consumer` | nothing consumes it today; a future consumer needs an explicit decision |

The vocabulary deliberately has no "already effective because it is committed"
value. Every authority-bearing field is gated by a command, a private binding or
a decision, never by the shared file alone.

### Shared layer — `.pappra/workspace.json`

| field | kind | gate |
| --- | --- | --- |
| `schema` | descriptive | none |
| `workspaceId` | descriptive | none |
| `name` | descriptive | none |
| `runtimeVersion` | selection | explicit-command |
| `repositories[].id` | descriptive | none |
| `repositories[].path` | access-candidate | explicit-command |
| `repositories[].access` | access-candidate | explicit-command |
| `knowledge.sources[]` | access-candidate | explicit-command |
| `knowledge.newDocuments` | access-candidate | explicit-command |
| `knowledge.taskVisibility` | selection | explicit-command |
| `code.graph` | selection | explicit-command |
| `code.symbols` | selection | explicit-command |
| `code.prepare` | selection | no-consumer |
| `validation[].id` | descriptive | none |
| `validation[].repositoryId` | descriptive | none |
| `validation[].executable` | execution-candidate | explicit-command |
| `validation[].args[]` | execution-candidate | explicit-command |
| `excludes[]` | descriptive | none |
| `extensions` | open-container | none |
| `continuity.autoResume` | selection | no-consumer |

Notes that the per-field table cannot carry:

- `runtimeVersion` names the version this workspace targets. Verifying,
  installing or binding a runtime needs an explicit `init`/`runtime` command, and
  the verified executable is recorded in `machine.json`.
- `repositories[].path` resolves a relative path inside the workspace root.
  `external:<id>` is accepted there, but its absolute location can only come from
  `machine.json`; absolute paths and root escapes are rejected.
- `knowledge.sources[]` and `knowledge.newDocuments` are read and write
  candidates. Paths escaping the root, absolute paths and `external:` references
  are diagnostics, and discovery copies no content.
- `code.graph` and `code.symbols` are declarations. `doctor` probes PATH
  presence only; `pappra code prepare` and `pappra code query` stay explicit
  commands, and a `symbols: auto` value proves nothing.
- `code.prepare` and `continuity.autoResume` have no consumer today. `init` and
  `--reconfigure` only preserve them. Honouring either one — scheduling index
  preparation, or resuming a task from a committed value — would need a decision
  in the private layer first, because resume decisions currently read the
  checkout-private task pin.

### Private layer — `.pappra/local/machine.json`

| field | kind | gate |
| --- | --- | --- |
| `schema` | descriptive | none |
| `workspaceRealpath` | local-binding | local-binding |
| `checkoutId` | local-binding | local-binding |
| `externalRepositories[].id` | descriptive | none |
| `externalRepositories[].path` | local-binding | local-binding |
| `selectedHosts[]` | selection | local-binding |
| `runtime.version` | local-binding | local-binding |
| `runtime.executable` | local-binding | local-binding |
| `runtime.verifiedAt` | descriptive | none |

`selectedHosts[]` records which hosts this person selected. Wiring one still
needs an explicit `host install` command, and native trust, reload and
callability remain unverified — a recorded selection is not a loaded plugin.

## Open containers

`extensions` is an open key/value container. Classification stops at that
boundary: its interior keys are not part of the schema contract, and Pappra
currently reads no extension key as authority. A future consumer of an extension
key must classify that key and its gate before acting on it; the coverage test
below cannot enumerate what the schema does not declare, and this page makes no
claim about arbitrary extension content.

## Values composed from more than one layer

No field is defined in both layers, so there is no per-field precedence chain and
no "same setting from two files" case. Three values are still assembled from more
than one source at read time, and each one keeps its source visible:

| value | shared input | private input | rule |
| --- | --- | --- | --- |
| repository checkout root | `repositories[].path` as `external:<id>` | `externalRepositories[].path` | the logical id is shared, the absolute location is private; an unmapped id fails closed |
| checkout id in continuity records | — | `checkoutId` | the private binding wins; when it is absent Pappra derives a digest of the repository root and never writes it back |
| retained-runtime-state version `doctor` inspects | `runtimeVersion` | `runtime.version` | `doctor` inspects the shared target version and falls back to the private binding only to look for retained state; the install target stays `runtimeVersion` |

`pappra doctor` reports these facts in the `workspace.authority` check, whose
`source` is the shared configuration file and whose evidence lists both files
with their digests. The `workspace.config` and `workspace.machine` checks keep
their own file as `source`, so a reader can always tell which layer a value came
from.

## What the pin is, and what it is not

`tests/workspace/config-authority.test.ts` pins the classification to the
schemas:

- It walks `workspaceConfigSchema` and `machineConfigSchema` and fails when a
  field has no classification, or when a classification names a field the schema
  no longer has. Adding a field to either schema therefore fails until it is
  classified in `src/schemas/config-authority.ts`.
- It asserts the kind/gate consistency rules, including that no shared
  authority-bearing field is enabled by the committed file alone.
- Its marker test writes a workspace whose `workspace.json` declares a validation
  entry pointing at a marker executable, then runs configuration inspection,
  workspace discovery, `pappra doctor` in-process and the `pappra doctor` CLI.
  The marker file must never appear, and the report must state that no validation
  executable was resolved, spawned or executed.

What it does **not** prove: that no future code path can ever execute a candidate.
The test covers the entries that exist today. A new feature that runs a
validation entry must add its own decision point in the private layer and its own
evidence; the classification table, the invariant and this page tell it what it
owes, and the drift test tells it to update the table.

## Adding a field

1. Add the field to the schema.
2. Add one classification entry: `path`, `layer`, `kind`, `gate`, and a note
   explaining what the value can name and what still has to be true for it to
   have an effect. Use `no-consumer` while nothing reads it.
3. If the value is assembled with another layer, add it to
   `CROSS_LAYER_VALUE_COMPOSITIONS` and to the table above.
4. Run `pnpm typecheck` and the workspace tests; the coverage test fails until
   steps 1–3 agree.
