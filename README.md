<p align="center">
  <img src="docs/assets/readme/hero.svg" width="100%" alt="Pappra, a workspace manager for coding agents: agent work belongs in files your workspace owns, not in one chat transcript. An excerpt of real pappra resume output shows the task is current, execution is not allowed, and the blocking reasons.">
</p>

Pappra keeps what a coding agent needs to continue a task — workspace configuration,
selected project knowledge, checkpoints, recovery context and bounded code navigation — in
files owned by the workspace, not in one chat transcript. The hosts you opt into read and
write the same state.

Pappra is the manager. External coding hosts, code-graph engines and collaboration
controllers are optional integrations, not installation prerequisites.

## What you get

- **Workspace configuration:** `.pappra/workspace.json`, plus checkout-local
  `.pappra/local/machine.json`.
- **Knowledge:** workspace and private document catalogs with explicit preview and apply
  steps; shared catalogs commit one record per file so parallel registrations do not
  collide on a single aggregate timestamp.
- **Continuity:** private checkpoints and bounded advisory resume packets. Resume never
  grants execution by itself; `executionAllowed:false` with blocking reasons is a normal,
  successful result.
- **Code intelligence:** status, explicit preparation and bounded query for selected
  repositories. Text and structure fallback works without a graph engine.
- **Integrations, all optional:** host hooks, agent tools over MCP, and bounded
  collaboration between agents.

## How it works

<p align="center">
  <img src="docs/assets/readme/how-it-works.svg" width="100%" alt="Optional hosts (Claude Code, Codex, Pi) call Pappra through hooks, an MCP server or the command line. Pappra reads and writes two places in your workspace: .pappra/workspace.json, which is shared and committed, and .pappra/local/, which is private and ignores itself. A resume reports state and never grants permission to execute.">
</p>

Hosts talk to Pappra through hooks, an MCP server or the command line. Pappra reads and
writes two places: `.pappra/workspace.json`, which is shared and committed, and
`.pappra/local/`, which is private and ignores itself. Registrations for code engines live
under `.pappra/local/code`, never inside a checkout.

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
workspace. For a non-interactive derived setup, `npx @phyzess/pappra@beta init --yes --apply
--json` derives repositories, knowledge sources, code engine, validation commands, excludes
and hosts from discovery. `--print-choices` prints the derived choices and writes nothing.

Development from a checkout works the same way: `pnpm install --frozen-lockfile`,
`pnpm build`, then invoke `dist/cli/main.js` by absolute path from the target workspace.

How `init` plans and applies, how the runtime copy is managed, and how to repair interrupted
state are in the [operations reference](docs/operations.md).

## Try a checkpoint and resume

Once the target is a Git worktree, create an advisory checkpoint and read it back. The
output at the top of this page is an excerpt of the last command.

```sh
npx @phyzess/pappra@beta checkpoint --task demo --objective 'Try Pappra' \
  --acceptance 'Resume stays advisory' \
  --author-session demo --native-session demo \
  --context-completeness complete --json
npx @phyzess/pappra@beta resume demo --session demo
```

A resume packet is advisory. Check `executionAllowed`: a readable checkpoint does not grant
permission to start work, and `executionAllowed:false` with blocking reasons is a successful
advisory result (exit `0`). Stale verification is what exits nonzero.

## Integrations

Everything here is optional and has prerequisites rather than generated files; none is
needed for the core workflow above.

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

| Capability                                            | Requirement                                              | Default                                         |
| ----------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| Workspace, init, doctor, checkpoint/resume, knowledge | Node.js only; Git for repository identity                | Core                                            |
| Code graph status/prepare/query                       | Optional external code-graph engine                      | Disabled unless selected; text fallback remains |
| Host hooks                                            | Explicitly selected Pi, Codex or Claude Code integration | Not installed automatically                     |
| Collaboration controller                              | Explicit `--controller <fixture\|pi-rpc>`                | No implicit controller                          |

Host names and protocol identifiers describe supported integration surfaces. They do not make
any host, model, graph engine or private workspace a prerequisite for core use.

## Documentation

- [Quick start](docs/quickstart.md) and the [operations reference](docs/operations.md)
- [API boundaries](docs/api.md) and [agent-native usage](docs/agent-native.md)
- [Support and limitations](docs/support.md), [portability](docs/portability.md) and
  [distribution](docs/distribution-plan.md)
- [Development](docs/development.md), which also covers `pnpm check`

## Status and limits

Pappra is development software (`0.1.0-beta.22`). The package is `@phyzess/pappra` with the
`beta` dist-tag. Releases are published from GitHub Actions with npm trusted publishing
(OIDC); no npm token is stored here. Pin either the moving `beta` tag or an exact version,
because pre-release versions are never republished.

The deterministic suite covers synthetic workspaces, fixtures and local process boundaries.
It does not establish real-model behaviour, native host callability on every platform,
graph-engine completeness, Windows/Linux parity or production performance. A host version
pin is an observed support claim, not proof that a particular installation loads or runs.

Review state, with every tracked finding and its current status, is in
[review closeout](docs/review-closeout.md). What the cold-start cases actually showed is in
[cold-start acceptance](docs/cold-start-acceptance.md).

## License

Pappra is licensed under the MIT License. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
