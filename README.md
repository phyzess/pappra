# Pappra

Pappra is a portable workspace manager for coding-agent workflows. It keeps workspace
configuration, selected project knowledge, checkpoints, recovery context and bounded code
navigation in files owned by the workspace rather than in one chat transcript.

Pappra is the manager. External coding hosts, code-graph engines and collaboration
controllers are optional integrations, not installation prerequisites.

## Quick start

Requirements: Node.js 24 or later. `pnpm` 12.3.4 is required only for development inside
this repository; Git is required only when a command observes repository identity.

The package is published as `@phyzess/pappra`. Install it once for daily use
(`npm install -g @phyzess/pappra@beta`, the command is `pappra`), or run it with `npx` when
you want a zero-install, version-pinned invocation.

```sh
# In an empty target workspace (not this checkout)
mkdir -p <empty-dir> && cd <empty-dir>
curl -fsSL https://raw.githubusercontent.com/phyzess/pappra/main/examples/minimal-choices.json -o ./minimal-choices.json

# Preview first. JSON/config mode is non-interactive and does not prompt.
npx @phyzess/pappra@beta init --config ./minimal-choices.json --json

# Apply the same choices. Apply also installs and binds a durable runtime copy,
# so this converges with exit code 0; add --no-runtime to leave that work pending.
npx @phyzess/pappra@beta init --config ./minimal-choices.json --apply --json
npx @phyzess/pappra@beta doctor --json
```

`examples/minimal-choices.json` is complete for a host-free, no-graph, single-directory
workspace. The example intentionally has no repositories or optional hosts.

For a non-interactive derived setup, `npx @phyzess/pappra@beta init --yes --apply --json`
derives repositories, knowledge sources, code engine, validation commands, excludes and
hosts from discovery. `--print-choices` prints the derived `pappra/init-choices/1` document
and writes nothing; `--print-choices --reconfigure` prints the current represented choices.
`init --json` without selections returns the discovery candidates plus the suggested
document. JSON mode never prompts.

Development from a checkout works the same way: `pnpm install --frozen-lockfile`,
`pnpm build`, then invoke `dist/cli/main.js` by absolute path from the target workspace.

### Init and runtime semantics

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

### Runtime management

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

### Repair and local reset

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

### Interactive init

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

## Hosts, agent tools and collaboration

Optional examples have prerequisites rather than generated files; none is needed for the
core workflow above.

- **Host integration:** `pappra host install` merges Pappra-owned hook entries without
  taking over user configuration. Hooks ship as a dependency-free bundle; Claude Code uses
  `${CLAUDE_PROJECT_DIR}`, Pi imports its runtime relatively, and Codex is wired user-scope
  (`--scope user`). `host bundle --marketplace` exports registration material but does not
  register or trust anything. See [host plugin validation](docs/host-plugin-validation.md).
- **Agent-native tools:** `pappra mcp` serves bounded tools over stdio; write tools require
  trusted server startup policy, not an agent-supplied flag. `pappra host mcp install`
  registers it for Claude Code or Pi; Codex uses `codex mcp add`. `pappra task pin <id>
--auto-resume` lets hooks inject a bounded resume packet. See
  [agent-native usage](docs/agent-native.md).
- **Managed native sessions:** `pappra session plan|start|status|fence|stop --config
<absolute-file>` starts a controller-owned visible Pi TUI. The PTY mode reports queue,
  approval and in-flight inventory as unknown and `transferReady: false`; the opt-in SDK
  mode pins Pi 1.4.0 and proves only disposal of its owned runtime. See
  [managed Pi sessions](docs/managed-pi-session.md).
- **Collaboration:** `pappra collab workflow prepare|dispatch|ack|report|accept|release`
  composes the existing protocol for a declared cohort. Roles grant no authority, a report
  is not acceptance, and a notification is not execution. See
  [the workflow contract](docs/collaboration-workflow.md) and
  [bounded collaboration](skills/pappra/references/collaboration.md).

## What it manages

- **Workspace configuration:** `.pappra/workspace.json` and checkout-local
  `.pappra/local/machine.json`.
- **Knowledge:** workspace and private document catalogs with explicit preview/apply
  operations; shared catalogs commit one record per file so parallel registrations do not
  collide on a single aggregate timestamp.
- **Continuity:** private checkpoints and bounded advisory resume packets. Resume never
  grants execution by itself; `executionAllowed:false` with blocking reasons is a normal,
  successful advisory result.
- **Code intelligence:** status, explicit preparation and bounded query for selected
  repositories. Text/structure fallback works without a graph engine. Registrations live
  under `.pappra/local/code`, never inside a checkout.
- **Host integrations, agent tools and bounded collaboration:** as described above.

## Optional integrations

| Capability                                            | Requirement                                              | Default                                         |
| ----------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| Workspace, init, doctor, checkpoint/resume, knowledge | Node.js only; Git for repository identity                | Core                                            |
| Code graph status/prepare/query                       | Optional external code-graph engine                      | Disabled unless selected; text fallback remains |
| Host hooks                                            | Explicitly selected Pi, Codex or Claude Code integration | Not installed automatically                     |
| Collaboration controller                              | Explicit `--controller <fixture\|pi-rpc>`                | No implicit controller                          |

Host names and protocol identifiers describe supported integration surfaces. They do not make
any host, model, graph engine or private workspace a prerequisite for core use.

## Development checks

```sh
pnpm check
```

The check runs the source policy, type checks, formatting, deterministic tests and a local
package smoke test. The smoke test prefers an offline local tarball and an isolated fixture
home/state; it does not install a model or contact a provider. The deterministic runner
removes inherited `PAPPRA_*` controls and isolates global/system Git configuration; native
provider acceptance is a separate, explicitly selected run.

## Status and limits

Pappra is development software (`0.1.0-beta.20`) published as `@phyzess/pappra` under the
`beta` dist-tag. Releases are published from GitHub Actions with npm trusted publishing
(OIDC); no npm token is stored here. Pin either the moving `beta` tag or an exact version,
because pre-release versions are never republished.

The deterministic suite covers synthetic workspaces, fixtures and local process boundaries.
It does not establish real-model behaviour, native host callability on every platform,
graph-engine completeness, Windows/Linux parity or production performance. A host version
pin is an observed support claim, not proof that a particular installation loads or runs.

Review state, including the 84 tracked findings and their current status, is in
[review closeout](docs/review-closeout.md). What the cold-start cases actually showed is in
[cold-start acceptance](docs/cold-start-acceptance.md).

## License

Pappra is licensed under the MIT License. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

More detail: [quick start](docs/quickstart.md), [API boundaries](docs/api.md),
[support and limitations](docs/support.md), [distribution](docs/distribution-plan.md).
