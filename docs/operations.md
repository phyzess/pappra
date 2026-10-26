# Operations reference

Detail for operating a Pappra workspace: what `init` writes and when, how the durable
runtime copy is managed, how to repair interrupted state, and how the interactive wizard
behaves. The [README](../README.md) keeps only the shortest path to a first run, and the
[quick start](quickstart.md) walks through setup; this page is the reference for the rest.

## Init and runtime semantics

`init` never writes during planning. `--apply` writes the planned files through a managed
journal. By default it then verifies an existing runtime for the workspace's recorded
runtime version and reuses it when the manifest, package contents, executable and smoke
check all pass; otherwise it packs and installs the current package under the Pappra data
directory and binds that runtime in `machine.json`, so an npx/dlx bootstrap survives cache
eviction.

- `--no-runtime` suppresses runtime verification, installation and binding for that
  invocation. When a runtime action is still required, the configuration is applied, the
  result is `ok:true` with `status:"external-actions-pending"`, and the command exits `0`
  for the requested configuration-only work. Inspect `pendingExternalActions`.
- A workspace that already has a bound matching runtime and needs no file changes reports
  `ok:true`, apply status `no-changes`, and exit `0`; `initComplete` stays `false` because
  that invocation verified no runtime.
- Exit `0` means the requested work completed, `1` conflict or incomplete requested work,
  `2` invalid input, `3` unavailable environment.

An existing valid `.pappra/workspace.json` is never rewritten silently: a plain `init`
reuses it and plans only missing local state. `--reconfigure` is the explicit opt-in that
rewrites it from the current selections and preserves the workspace identity,
`extensions`, `continuity`, custom validation entries with their checkout binding, and
existing local machine settings; the previous file is backed up under
`.pappra/local/backups`. `--yes --reconfigure` therefore keeps the represented selections
instead of re-deriving them, while `--config <file> --reconfigure` applies explicitly
supplied edits.

## Runtime management

```sh
npx @phyzess/pappra@beta runtime install --apply [--from self|tarball|registry]
npx @phyzess/pappra@beta runtime status --json
npx @phyzess/pappra@beta runtime verify --json
npx @phyzess/pappra@beta runtime remove --apply
```

Runtime content hashes use UTF-8 byte ordering, independent of system locale. The manifest
records `digestScheme: sha256-utf8-byte-order-v1`; a manifest with a different or missing
scheme is reported as incompatible, separately from corrupted content. Old beta state is
not migrated: use the current package with `init --reconfigure --apply`, and preserve old
data until you explicitly remove it. Verification never rewrites a manifest to adopt an
unexpected digest. Removal refuses unknown cross-workspace references; `--force` is an
explicit override after checking other workspaces. `runtime archive --runtime-version <v>`
previews an evidence-preserving exit for corrupt, legacy or abandoned state, and applying
it requires explicit unknown-reference acceptance and a reason.

## Repair and local reset

```sh
pappra repair --root /path/to/workspace --json
pappra repair --root /path/to/workspace --apply
pappra repair --runtime-version 0.1.0 --json
```

`repair` finds the nearest workspace from a subdirectory and previews incomplete journals
plus install, knowledge and checkpoint writer locks. `--apply` reclaims a lock only when its
recorded owner is provably dead, rolls back files with verified ownership, and restores
journaled reconfiguration backups. Live or unknown owners, modified files, invalid journals
and unproven paths are preserved and reported. `doctor` reports dead or unknown writers and
points to the same surface.

For copied or moved beta workspaces, stop every affected writer before explicitly starting
fresh local state; this preserves the old bytes instead of migrating machine bindings:

```sh
pappra repair --reset-local --json
pappra repair --reset-local --all-writers-stopped --apply
pappra init --yes --apply
```

The old tree remains under ignored `.pappra/local-archive/<id>`. The stopped-writers flag is
an operator assertion for unknown/imported ownership, not process-stop proof. For a single
malformed or empty lock, `repair --quarantine-unowned-locks --apply` uses the same
precondition and preserves the lock plus a receipt in private quarantine. Never use either
escape while a writer is alive or paused.

Every first private-state write creates `.pappra/local/.gitignore` with a final `*` rule,
including writes performed without `init`. Checkpoint payloads retain tracked diffs, but
untracked files contribute only their path, object type and content digest; their contents
and symlink target text are not copied into the checkpoint.

## Interactive init

A TTY opens the full wizard only when selections are actually needed: a plain `init` in a
workspace that already has a valid configuration reuses it and asks only for missing local
state, and `--reconfigure` opens the editor. Repository and knowledge sections pre-select the
current choices and offer **Add existing repository…** and **Add existing knowledge file or
folder…**; that action inspects only the workspace-relative path you type and never scans
ancestors or the home directory. Advanced preferences are opt-in. Graph, symbol, preparation,
validation and host declarations are recorded preferences only: `init` does not install,
index, execute or wire them.

A TTY run that collected selections without `--apply` prints the plan and asks one
confirmation when configuration writes are planned; declining exits `130` with no files
written. `--apply` never prompts, `--config` without `--apply` stays a preview, and
`--print-choices` writes nothing.

## Development checks

```sh
pnpm check
```

The check runs the source policy, type checks, formatting, deterministic tests and a local
package smoke test. The smoke test prefers an offline local tarball and an isolated fixture
home/state; it does not install a model or contact a provider. The deterministic runner
removes inherited `PAPPRA_*` controls and isolates global/system Git configuration; native
provider acceptance is a separate, explicitly selected run. See
[development](development.md) for the project-local setup commands.
