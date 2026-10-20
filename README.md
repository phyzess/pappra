# Pappra

Pappra is a portable workspace manager for coding-agent workflows. It keeps workspace configuration, selected project knowledge, checkpoints, recovery context and bounded code navigation in files owned by the workspace rather than in one chat transcript.

Pappra is the manager. External coding hosts, code-graph engines and collaboration controllers are optional integrations, not installation prerequisites.

## Quick start

Requirements: Node.js 24 or later. `pnpm` 12.3.4 is required only for development inside this repository; Git is required only when a command observes repository identity.

The package is published as `@phyzess/pappra`. Run it with `npx` from the target workspace, or install it globally when you use it every day.

```sh
# In an empty target workspace
mkdir -p /tmp/pappra-demo
cd /tmp/pappra-demo
curl -fsSL https://raw.githubusercontent.com/phyzess/pappra/main/examples/minimal-choices.json -o ./minimal-choices.json

# Preview first. JSON/config mode is non-interactive and does not prompt.
npx @phyzess/pappra@beta init --config ./minimal-choices.json --json

# Apply the same choices. With no runtime installed, apply intentionally
# reports external-actions-pending and exits nonzero after writing config.
npx @phyzess/pappra@beta init --config ./minimal-choices.json --apply --json
npx @phyzess/pappra@beta doctor --json
```

`examples/minimal-choices.json` is complete for a host-free, no-graph, single-directory workspace. The example intentionally has no repositories or optional hosts.

For a non-interactive derived setup, `npx @phyzess/pappra@beta init --yes --apply --json` derives repositories, knowledge sources, code engine, validation commands, excludes and hosts from discovery. `--print-choices` prints that `pappra/init-choices/1` document and writes nothing, and `init --json` without selections returns the discovery candidates plus the suggested document. JSON mode never prompts; only a TTY without selections opens the wizard.

Development from a checkout works the same way: `pnpm install --frozen-lockfile`, `pnpm build`, then invoke `dist/cli/main.js` by absolute path from the target workspace.

`init --apply` also installs a durable runtime copy of the executing package under the
Pappra data directory and binds it in `machine.json`, so an npx/dlx bootstrap survives
cache eviction and the command converges with exit code `0`. Pass `--no-runtime` to leave
that action pending instead; the result is then `ok:true` with
`status:"external-actions-pending"` and a nonzero exit, which is a partial configuration
write rather than a claim that a runtime exists.

The runtime copy can be managed directly:

```sh
npx @phyzess/pappra@beta runtime install --apply [--from self|tarball|registry]
npx @phyzess/pappra@beta runtime status --json
npx @phyzess/pappra@beta runtime verify --json
```

A workspace that already has a valid `.pappra/workspace.json` is never rewritten silently.
`init --yes --reconfigure --apply` rebuilds it from discovery (for example to move the
recorded runtime version to the running package), backing the previous file up under
`.pappra/local/backups`. Apply also reports advisory `nextActions`: `pappra code prepare`
for a selected code engine and `pappra docs scan --apply` to register documents from the
configured knowledge sources.

Optional examples have prerequisites rather than generated files: code-graph and
host commands require the selected external CLI/support, and collaboration
requires an explicit controller. They are not needed for the core workflow above.

## What it manages

- **Workspace configuration:** `.pappra/workspace.json` and checkout-local `.pappra/local/machine.json`.
- **Knowledge:** workspace and private document catalogs with explicit preview/apply operations.
- **Continuity:** private task checkpoints and bounded advisory resume packets. Resume never grants execution by itself.
- **Code intelligence:** status, explicit preparation and bounded query for selected repositories. Text/structure fallback is available when the optional graph engine is absent.
- **Host integrations:** optional Pi, Codex and Claude Code adapters that merge Pappra-owned entries without taking over user configuration. Hooks are copied as a dependency-free bundle into the host root; `host bundle --marketplace` exports a local marketplace that Claude Code and Codex accept, without registering it. `host install --mode plugin` fails closed until plugin registration and callability are verified in a real session.
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

Pappra is development software (`0.1.0-beta.5`) published as `@phyzess/pappra` under the `beta` dist-tag. Releases are published from GitHub Actions with npm trusted publishing (OIDC), so no npm token is stored in this repository. Pin either the moving `beta` tag or an exact version such as `@phyzess/pappra@0.1.0-beta.5`, because pre-release versions are never republished.

The deterministic suite covers synthetic workspaces, fixtures and local process boundaries. It does not establish real-model behavior, native host callability on every platform, CodeGraph completeness, Windows/Linux parity or production performance. A host adapter version pin is an observed support claim, not proof that a particular native installation will load or run correctly.

## License

Pappra is licensed under the MIT License. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

More detail: [quick start](docs/quickstart.md), [API boundaries](docs/api.md), [support and limitations](docs/support.md).
