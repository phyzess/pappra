# Pappra

Pappra is a portable workspace manager for coding-agent workflows. It keeps workspace configuration, selected project knowledge, checkpoints, recovery context and bounded code navigation in files owned by the workspace rather than in one chat transcript.

Pappra is the manager. External coding hosts, code-graph engines and collaboration controllers are optional integrations, not installation prerequisites.

## Quick start

Requirements: Node.js 24 or later and `pnpm` 12.3.4. Git is required only when a command observes repository identity.

```sh
pnpm install
pnpm build
node dist/cli/main.js --help
node dist/cli/main.js init --help
node dist/cli/main.js doctor --json
```

Initialize a workspace from a choices file:

```sh
node dist/cli/main.js init --config init-choices.json --apply --json
```

A successful apply can still report `external-actions-pending`; inspect `pendingExternalActions` before assuming optional runtime or host wiring is complete.

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
