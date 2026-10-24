# Pappra

Pappra is a portable workspace manager for coding-agent workflows. It keeps workspace configuration, selected project knowledge, checkpoints, recovery context and bounded code navigation in files owned by the workspace rather than in one chat transcript.

Pappra is the manager. External coding hosts, code-graph engines and collaboration controllers are optional integrations, not installation prerequisites.

## Quick start

Requirements: Node.js 24 or later. `pnpm` 12.3.4 is required only for development inside this repository; Git is required only when a command observes repository identity.

The package is published as `@phyzess/pappra`. Install it once for daily use (`npm install -g @phyzess/pappra@beta`, the command is `pappra`), or run it with `npx` when you want a zero-install, version-pinned invocation.

```sh
# In an empty target workspace
mkdir -p /tmp/pappra-demo
cd /tmp/pappra-demo
curl -fsSL https://raw.githubusercontent.com/phyzess/pappra/main/examples/minimal-choices.json -o ./minimal-choices.json

# Preview first. JSON/config mode is non-interactive and does not prompt.
npx @phyzess/pappra@beta init --config ./minimal-choices.json --json

# Apply the same choices. Apply also installs and binds a durable runtime copy,
# so this converges with exit code 0; add --no-runtime to skip that work and
# leave a still-required runtime action pending.
npx @phyzess/pappra@beta init --config ./minimal-choices.json --apply --json
npx @phyzess/pappra@beta doctor --json
```

`examples/minimal-choices.json` is complete for a host-free, no-graph, single-directory workspace. The example intentionally has no repositories or optional hosts.

For a non-interactive derived setup, `npx @phyzess/pappra@beta init --yes --apply --json` derives repositories, knowledge sources, code engine, validation commands, excludes and hosts from discovery; with an existing workspace plus `--reconfigure` it keeps the current represented selections instead of deriving new ones, and `--print-choices --reconfigure` prints those current choices. `--print-choices` normally prints the derived `pappra/init-choices/1` document and writes nothing, and `init --json` without selections returns the discovery candidates plus the suggested document. JSON mode never prompts.

Development from a checkout works the same way: `pnpm install --frozen-lockfile`, `pnpm build`, then invoke `dist/cli/main.js` by absolute path from the target workspace.

`init` never writes during planning. `--apply` writes the planned files through a managed
journal. By default it then verifies an existing runtime for the workspace's recorded runtime
version and reuses it when the manifest, package contents, executable and smoke check all pass;
otherwise it packs and installs the current package under the Pappra data directory and binds
that runtime in `machine.json`. So an npx/dlx bootstrap survives cache eviction. If the current
package version differs from the workspace target, a previously installed verified target
runtime may still be reused; when none is reusable the configuration is applied and runtime
setup fails afterwards with a nonzero exit. Pass `--no-runtime` to suppress runtime verification,
installation and binding for that invocation. When a runtime action is still required afterwards,
the configuration is applied, that action stays pending, and the result is `ok:true` with
`status:"external-actions-pending"` and exit `0` for the requested configuration-only work.
A workspace that already has a bound runtime for its target and needs no file changes can instead
report `ok:true`, apply status `no-changes` and exit `0`; `initComplete` then stays `false`,
because that invocation verified no runtime.

For a new workspace or a new machine, `pappra onboard --dry-run --json` shows the plan and
the host version matrix; `pappra onboard --yes --apply-host --json` applies config, runtime
and verified host wiring (host trust still needs one approval). See
[portability](docs/portability.md).

The runtime copy can be managed directly:

```sh
npx @phyzess/pappra@beta runtime install --apply [--from self|tarball|registry]
npx @phyzess/pappra@beta runtime status --json
npx @phyzess/pappra@beta runtime verify --json
```

Runtime content hashes now use UTF-8 byte ordering, independent of system locale.
Beta.15 uses `pappra/runtime-manifest/2` with an explicit digest scheme and does not
migrate old beta state. Unsupported formats are reported as incompatible, separately
from corrupted content. Use the current package with `init --reconfigure --apply` to
initialize its runtime; existing state is preserved until explicitly removed.
Verification never rewrites a manifest to adopt an unexpected digest.
Runtime removal refuses unknown cross-workspace references;
`--force` is an explicit override after checking other workspaces.

Interrupted installations can be inspected and recovered explicitly:

```sh
pappra repair --root /path/to/workspace --json
pappra repair --root /path/to/workspace --apply
pappra repair --runtime-version 0.1.0 --json
pappra repair --runtime-version 0.1.0 --apply
```

`repair` finds the nearest workspace from a subdirectory and previews incomplete journals plus
install, knowledge and checkpoint writer locks. Add `--install-id <uuid>`
to select one incomplete journal. `--apply` reclaims a lock only when its recorded owner is
provably dead, rolls back files with verified ownership, and restores journaled reconfiguration
backups. For runtimes it removes only journal-owned staging, or finalizes an already published
copy whose manifest and contents still match, without executing the runtime. Live or unknown
owners, modified files, invalid journals and unproven backup paths are preserved and reported.
Reconfiguration holds the same workspace lock and journal through replacements and creations.
Files created before their inode reached the journal remain in place, with an explicit
preservation audit; their ownership is not adopted. Lock publication is atomic, so a new
writer never exposes an empty named owner record. `doctor` reports dead or unknown writers
and points to the same repair surface.

For copied or moved beta workspaces, stop every affected writer before explicitly starting
fresh local state; this preserves the old bytes instead of migrating machine bindings:

```sh
pappra repair --reset-local --json                 # read-only plan
pappra repair --reset-local --all-writers-stopped --apply
pappra init --yes --apply
```

The old tree remains under ignored `.pappra/local-archive/<id>`. Reset has its own recoverable
journal and refuses verified live owners. The stopped-writers flag is an operator assertion
for unknown/imported ownership, not process stop proof. For a single malformed or empty lock,
`repair --quarantine-unowned-locks --apply` provides the same explicit stop-all-writers
precondition and preserves the lock plus a receipt in private quarantine. Never use either
escape while a writer is alive or paused.

Every first private-state write creates `.pappra/local/.gitignore` with a final `*`
rule, including writes performed without init. Checkpoint payloads retain tracked
diffs, but untracked files contribute only their path, object type and content digest;
their contents and symlink target text are not copied into the checkpoint.

A workspace that already has a valid `.pappra/workspace.json` is never rewritten silently: a
plain `init` reuses it and only plans missing local state. `--reconfigure` is the explicit opt-in
that re-derives `workspace.json` from the current selections, and it preserves the workspace
identity, `extensions`, `continuity`, custom validation entries with their original checkout
binding, and existing local machine settings; the previous file is backed up under
`.pappra/local/backups`. `--yes --reconfigure` therefore keeps the represented selections instead
of re-deriving them from discovery, while `--config <file> --reconfigure` applies explicitly
supplied edits.

Knowledge sources and the document destination are different settings. `knowledge.sources` lists
existing rules and documents that stay in place and are only registered later by
`pappra docs scan --apply`; `knowledge.newDocuments` is merely the destination for future
authored documents and is not created by `init`. Apply also reports advisory `nextActions`:
`pappra code prepare` for a selected code engine and `pappra docs scan --apply` to register
documents from the configured knowledge sources.

### Interactive init

A TTY opens the full wizard only when selections are actually needed: a plain `init` in a
workspace that already has a valid configuration reuses it and asks only for missing local
state, and `--reconfigure` is what opens the editor. The workspace name, new-document
destination and excludes are editable text fields seeded with the current or derived value, so
the suggested value is visible and can be changed before submitting; an invalid entry is
reported at that field and re-asked. Repository and knowledge sections pre-select the current
choices and offer **Add existing repository…** and **Add existing knowledge file or folder…**.
That action inspects only the workspace-relative path you type: it checks portability,
canonical containment, workspace exclusions, nested-workspace boundaries, unsafe symlinks and,
for repositories, that the path is the exact Git checkout root. It never scans ancestors or the
home directory, never reads document bodies, and empty knowledge folders are valid sources.
Advanced preferences are opt-in (`Keep current advanced settings` is the default), sections after
the first offer `Back` alongside `Review selections`, the review screen can reopen one section, and
`Cancel` (also Ctrl-C) discards the draft before anything is written. Graph/symbols/preparation
choices, validation candidates and host declarations are recorded preferences only: `init` does not
install, index, execute or wire them.

A TTY run that collected selections without `--apply` prints the plan and then asks one
confirmation when configuration writes are planned; declining exits `130` with no files written.
`--apply` never prompts, `--config` without `--apply` stays a preview even on a TTY, and an empty
read-only plan performs no runtime work and asks nothing. `--print-choices` prints the
`pappra/init-choices/1` document and writes nothing, `--config` reads that document,
`--yes`/`--no-interactive` derive selections non-interactively, and `--json` never prompts.
Exit `0` means the requested work completed. `--no-runtime` deliberately defers runtime work
and keeps `initComplete:false`; a failure in a requested runtime step returns nonzero.

Optional examples have prerequisites rather than generated files: code-graph and
host commands require the selected external CLI/support, and collaboration
requires an explicit controller. `--controller pi-rpc` is the host-directs/Pi-executes
path, verified end to end against Pi 1.3.0; see [Pi RPC collaboration](docs/pi-rpc.md).
They are not needed for the core workflow above.

For a fresh controller-owned visible Pi TUI, use `pappra session plan` then
`pappra session start --config <absolute-file>`. The controller preserves normal
Pi configuration, selects an explicit OpenRouter model, journals terminal input
and exposes a private status/fence/stop endpoint. See
[managed Pi sessions](docs/managed-pi-session.md). Opt-in SDK mode pins Pi 1.4.0
and observes native queues and dialogs within its owned runtime. External writers
and unowned descendants remain outside that proof. [Controlled resume](docs/managed-pi-resume.md)
checks process death and current task authority before reopening an idle session;
[provider diagnostics](docs/managed-provider-diagnostics.md) retain redacted transport details.
Threshold-driven checkpoint
and bundle capture are available through [automatic handoff](docs/automatic-handoff.md);
ownership transfer still requires the existing supported transition contract.
[Role plans](docs/collaboration-role-plan.md) support an optional planner before
independent writers and a final reviewer; [event orchestration](docs/collaboration-role-orchestration.md)
dispatches ready assignments and aggregates authoritative results.

## What it manages

- **Workspace configuration:** `.pappra/workspace.json` and checkout-local `.pappra/local/machine.json`.
- **Knowledge:** workspace and private document catalogs with explicit preview/apply operations.
- **Continuity:** private task checkpoints and bounded advisory resume packets. Resume never grants execution by itself.
- **Code intelligence:** status, explicit preparation and bounded query for selected repositories. Text/structure fallback is available when the optional graph engine is absent. Registrations are stored under the workspace `.pappra/local/code`, never inside a repository checkout, so a multi-repository workspace does not turn its checkouts into nested workspaces.
- **Host integrations:** optional Pi, Codex and Claude Code adapters that merge Pappra-owned entries without taking over user configuration. Hooks are copied as a dependency-free bundle; Claude Code uses `${CLAUDE_PROJECT_DIR}` and Pi imports its runtime relatively, while Codex 0.163.0 loads hooks only from `$CODEX_HOME/hooks.json` (`host install --host codex --scope user`). `host bundle --marketplace` exports a marketplace that Claude Code and Codex accept without registering it. Plugin hooks are verified for Pi 1.3.0 and Claude Code 2.1.292 (startup) and unsupported for Codex, so `host install --mode plugin` fails closed with the per-host registration commands. See [host plugin validation](docs/host-plugin-validation.md).
- **Agent-native tools:** `pappra mcp` exposes read-only and gated write tools over stdio MCP; `pappra host mcp install` registers it for Claude Code or Pi, and Codex uses `codex mcp add`. `pappra task pin <id> --auto-resume` lets hooks inject a bounded resume packet. See [agent-native usage](docs/agent-native.md).
- **Bounded collaboration:** an optional, explicitly controlled one-request workflow. It is not a scheduler or daemon.

## Optional integrations and support

| Capability                                            | Requirement                                              | Default                                                   |
| ----------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Workspace, init, doctor, checkpoint/resume, knowledge | Node.js only; Git for repository identity                | Core                                                      |
| Code graph status/prepare/query                       | Optional external code-graph engine                      | Disabled unless selected; text fallback remains available |
| Host hooks                                            | Explicitly selected Pi, Codex or Claude Code integration | Not installed automatically                               |
| Collaboration controller                              | Explicit `--controller <fixture\|pi-rpc>`                | No implicit controller                                    |

Host names and external protocol identifiers describe supported integration surfaces. They do not make any host, model, graph engine or private workspace a prerequisite for core use.

## Development checks

```sh
pnpm check
```

The check runs the source policy, type checks, formatting, deterministic tests and a local package smoke test. The package smoke test prefers an offline local tarball (falling back to registry resolution when the runner has no offline metadata) and an isolated fixture home/state; it does not install a model or contact a model provider.

## Status and limits

Pappra is development software (`0.1.0-beta.14`) published as `@phyzess/pappra` under the `beta` dist-tag. Releases are published from GitHub Actions with npm trusted publishing (OIDC), so no npm token is stored in this repository. Pin either the moving `beta` tag or an exact version such as `@phyzess/pappra@0.1.0-beta.14`, because pre-release versions are never republished.

The deterministic runner removes inherited `PAPPRA_*` controls and isolates global/system
Git configuration. Test cases inject required Pappra variables explicitly. Native provider
acceptance is run separately against its selected test file, rather than enabled by ambient
opt-in flags during `pnpm check`.

The deterministic suite covers synthetic workspaces, fixtures and local process boundaries. It does not establish real-model behavior, native host callability on every platform, CodeGraph completeness, Windows/Linux parity or production performance. A host adapter version pin is an observed support claim, not proof that a particular native installation will load or run correctly.

## License

Pappra is licensed under the MIT License. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

More detail: [quick start](docs/quickstart.md), [API boundaries](docs/api.md), [support and limitations](docs/support.md).
