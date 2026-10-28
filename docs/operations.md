# Operations reference

Detail for operating a Pappra workspace: what `init` writes and when, how the durable
runtime copy is managed, how to repair interrupted state, and how interactive and scripted
use differ. The [README](../README.md) keeps only the shortest path to a first run, and the
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
unexpected digest. Removal checks only explicitly registered workspace roots: unknown coverage
blocks removal, and `--force` accepts that unknown coverage but never bypasses a verified active
reference. `runtime archive --runtime-version <v>`
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
malformed or empty lock, `repair --quarantine-unowned-locks --apply` moves the lock plus a receipt
into private quarantine without claiming owner death; the flag itself is the explicit operator
assertion that every affected writer is stopped. Never use either
escape while a writer is alive or paused.

Every first private-state write creates `.pappra/local/.gitignore` with a final `*` rule,
including writes performed without `init`. Checkpoint payloads retain tracked diffs, but
untracked files contribute only their path, object type and content digest; their contents
and symlink target text are not copied into the checkpoint.

## Interactive and scripted use

Pappra prompts only for a person at a terminal: both stdin and stdout are TTYs, the invocation
has no `--json` and no `--no-interactive`, and `CI` is unset or false. `init` applies the same
rule, so a CI job that allocates a PTY does not open its wizard. `--no-interactive` is accepted
by every command, and it (like `--json`, `CI` or a non-TTY stream) makes a bare `pappra` print
the usage summary instead of opening the guided flow; the `--help` text says so.

A bare `pappra` uses that mode:

- With no workspace in the directory it starts the guided setup: the `init` wizard, a preview
  of the plan, one confirmation that applies it, and then the optional steps — prepare the
  code index, register knowledge documents, connect coding agents (Claude Code, Codex, Pi,
  including MCP registration) and a health check. Every optional step can be skipped. Trust
  prompts inside a coding agent are still answered by the person in that agent; Pappra never
  approves them.
- In an existing workspace it prints a short status and a menu: resume a task, prepare the
  code index, scan documents, connect coding agents, health check, reconfigure, exit.

On a terminal, commands that change state (`docs scan`, `docs relocate`, `docs forget`,
`code prepare`, `host install`, `host uninstall`, `host mcp install`, `repair`) print their
plan and then ask one confirmation instead of telling you to rerun with `--apply`. Answering
yes performs exactly the apply the flag would; declining or cancelling writes nothing.
Destructive operations default to "no", and a prompt never adds `--force`,
`--quarantine-unowned-locks`, `--reset-local` or `--all-writers-stopped`; pass those yourself
when you mean them. A missing required `--repo`, `--host` or resume task id is asked with a
picker; a single candidate is used without asking, cancelling the picker prints
`Nothing selected; nothing was done.` and exits `0`, and no candidate prints one line and
exits `1`. `host mcp install` asks only when it has something to write: an entry that already
matches is reported without a question, and a conflicting entry is reported without one and
needs an explicit `--force`.

Scripts, agents and CI keep the explicit contract: `--json` never prompts, `--apply` never
prompts, `init` takes `--yes` or `--config`, and `--no-interactive`, `CI=true` or a non-TTY
stream turns every prompt off. `pappra onboard` with no flags on a terminal runs the guided
setup when there is no workspace; in an existing workspace it runs the optional steps (code
index, documents, coding agents, health check) and does not show the menu. Its flags keep
working unchanged.

## Interactive init

A TTY opens the full wizard only when selections are actually needed: a plain `init` in a
workspace that already has a valid configuration reuses it and asks only for missing local
state, and `--reconfigure` opens the editor. Repository and knowledge sections pre-select the
current choices and offer **Add existing repository…** and **Add existing knowledge file or
folder…**; that action inspects only the workspace-relative path you type and never scans
ancestors or the home directory. Advanced preferences are opt-in. Graph, symbol, preparation,
validation and host declarations are recorded preferences only: a confirmed apply records
them and does not install, index, execute or wire anything by itself.

A TTY run that collected selections without `--apply` prints the plan and asks one
confirmation when configuration writes are planned; declining prints `Nothing was applied.`
and exits `0` with no files written. When no file changes are planned, `init` reports
`Workspace files are already up to date.` and asks whether to verify the runtime and
continue with the optional setup steps (`--no-runtime` asks only about those steps);
declining prints `Nothing was applied.` and writes nothing. Cancelling the wizard exits
`130` for `pappra init`, while the guided entries (bare `pappra` and a flagless
`pappra onboard`) print `Setup cancelled.` and exit `0`. `--apply` never prompts,
`--config` without `--apply` stays a preview, and `--print-choices` writes nothing.

After a confirmed apply from a terminal, `pappra init` also offers the optional follow-up
steps: prepare the code index, register the discovered knowledge documents, connect coding
agents including MCP registration, and run a health check. Each step asks before it writes and
can be skipped; `--apply`, `--yes`, `--config` and `--json` never run them.

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
