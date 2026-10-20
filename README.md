# Pappra

Pappra is a portable workspace manager for coding-agent workflows. It keeps workspace configuration, selected project knowledge, checkpoints, recovery context and bounded code navigation in files owned by the workspace rather than in one chat transcript.

Pappra is the manager. External coding hosts, code-graph engines and collaboration controllers are optional integrations, not installation prerequisites.

## Quick start

Requirements: Node.js 24 or later and `pnpm` 12.3.4. Git is required only when a command observes repository identity.

Build the checkout, then invoke the built CLI by an explicit path from the **target workspace**; there is no global `pappra` binary to install for this workflow.

```sh
# In the Pappra checkout
pnpm install --frozen-lockfile
pnpm build
CHECKOUT="$(pwd)"
PAPPRA_CLI="$CHECKOUT/dist/cli/main.js"

# In a separate empty target workspace
mkdir -p /tmp/pappra-demo
cd /tmp/pappra-demo
cp "$CHECKOUT/examples/minimal-choices.json" ./minimal-choices.json

# Preview first. JSON/config mode is non-interactive and does not prompt.
node "$PAPPRA_CLI" init --config ./minimal-choices.json --json

# Apply the same choices. With no runtime installed, apply intentionally
# reports external-actions-pending and exits nonzero after writing config.
node "$PAPPRA_CLI" init --config ./minimal-choices.json --apply --json
node "$PAPPRA_CLI" doctor --json
```

`minimal-choices.json` is complete for a host-free, no-graph, single-directory
workspace. The example intentionally has no repositories or optional hosts.
`init --json` without `--config` fails closed because JSON mode does not open the
interactive wizard; run `node "$PAPPRA_CLI" init` without `--json` in a TTY if you want to
enter selections interactively. `--config` and `--json` never prompt.

An apply result can be `ok:true` with `status:"external-actions-pending"` and a
nonzero process exit. That is a successful, partial configuration write, not a
claim that a runtime or external tool was installed. Inspect `pendingExternalActions`
and run `doctor` before adding optional integrations.

Optional examples have prerequisites rather than generated files: code-graph and
host commands require the selected external CLI/support, and collaboration
requires an explicit controller. They are not needed for the core workflow above.

## What it manages

- **Workspace configuration:** `.pappra/workspace.json` and checkout-local `.pappra/local/machine.json`.
- **Knowledge:** workspace and private document catalogs with explicit preview/apply operations.
- **Continuity:** private task checkpoints and bounded advisory resume packets. Resume never grants execution by itself.
- **Code intelligence:** status, explicit preparation and bounded query for selected repositories. Text/structure fallback is available when the optional graph engine is absent.
- **Host integrations:** optional Pi, Codex and Claude Code adapters that merge Pappra-owned entries without taking over user configuration.
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

The check runs the source policy, type checks, formatting, deterministic tests and a local package smoke test. The package smoke test uses an offline local tarball and an isolated fixture home/state; it does not install a model or contact a provider.

## Status and limits

Pappra is currently development software (`0.1.0-dev.0`). The repository is intentionally `private: true` in `package.json` so it cannot be published to npm accidentally. A public GitHub source repository does not authorize an npm release.

The deterministic suite covers synthetic workspaces, fixtures and local process boundaries. It does not establish real-model behavior, native host callability on every platform, CodeGraph completeness, Windows/Linux parity or production performance. A host adapter version pin is an observed support claim, not proof that a particular native installation will load or run correctly.

## License

Pappra is licensed under the MIT License. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

More detail: [quick start](docs/quickstart.md), [API boundaries](docs/api.md), [support and limitations](docs/support.md).
