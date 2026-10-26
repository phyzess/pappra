<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="docs/assets/readme/hero.svg" width="100%" alt="Pappra, a workspace manager for coding agents: agent work belongs in files your workspace owns, not in one chat transcript. An excerpt of real pappra resume output shows the task is current, execution is not allowed, and the blocking reasons.">
</p>

**Pappra saves what your AI coding agent was doing as plain files inside your project, so any
agent can pick the work back up.**

## Why Pappra?

You ask a coding agent (Claude Code, Codex, Pi…) to do something big. Halfway through, the
chat gets too long, you switch tools, or you come back tomorrow, and the new session knows
nothing. The goal, the decisions already made and the next step were all trapped in one chat.

Pappra moves that knowledge out of the chat and into files in your project folder. Any agent
you choose can read the same files. You don't need an agent, a model account or any extra
service to try it: Node.js is enough.

## Words you will see

| Word                | What it means here                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------- |
| **Workspace**       | The project folder Pappra manages. Its files live in a `.pappra/` folder inside it.          |
| **Agent / host**    | The AI coding tool (Claude Code, Codex, Pi). Pappra calls the tool a "host".                 |
| **Checkpoint**      | A saved note about a task: the goal, how you know it is done, and what to do next.           |
| **Resume**          | Reading a checkpoint back. It only reports; it never starts any work.                        |
| **Knowledge**       | Project documents you choose to register, so agents can find them.                           |
| **Code navigation** | A bounded way to look up code. It works without extra tools, and can use a code graph later. |

## Try it in 5 minutes

You need [Node.js](https://nodejs.org/) 24 or later and Git. Check your version first:

```sh
# Should print v24 or higher
node --version
```

**1. Create a practice folder and start Pappra in it.** In a terminal, running Pappra with no
arguments is the whole setup: it reads the folder, asks a few questions, prints the plan it
will write, and applies it after one confirmation. Then it offers the optional steps one at a
time — prepare the code index, register knowledge documents, connect your coding agents
(Claude Code, Codex, Pi, including MCP registration) and run a health check — and each one
can be skipped.

```sh
mkdir pappra-demo && cd pappra-demo
git init
npx @phyzess/pappra@beta
```

You now have a `.pappra/` folder. `.pappra/workspace.json` is shared and meant to be
committed; `.pappra/local/` is private and ignores itself, so it never lands in Git. The
setup also puts one copy of Pappra under your user data folder so `npx` cache cleaning cannot
break it. You can repeat the read-only check at any time with `pappra doctor`: a few
`[WARNING]` or `[UNKNOWN]` lines for things you have not set up, such as hosts, are normal,
and `[ERROR]` lines are the ones to fix.

Scripts and CI use explicit flags instead, which never prompt:

```sh
npx @phyzess/pappra@beta init --yes
npx @phyzess/pappra@beta init --yes --apply
npx @phyzess/pappra@beta doctor
```

`init --yes` only prints the plan and writes nothing; adding `--apply` writes it.

**2. Save a checkpoint, then read it back.**

```sh
npx @phyzess/pappra@beta checkpoint --task demo --objective 'Try Pappra' \
  --acceptance 'Resume stays advisory' \
  --author-session demo --native-session demo \
  --context-completeness complete --json
npx @phyzess/pappra@beta resume demo --session demo
```

The output at the top of this page is an excerpt of the last command.

**3. Read the result.** You should see `Execution allowed: no` and some `Blocked:` lines.
That is the correct result, not an error. Resume only reports the state of a task. It never
gives an agent permission to start working, and this demo checkpoint has no decisions or next
steps yet, so Pappra honestly says the context is incomplete. The command exits with `0`;
only stale verification makes it exit non-zero.

That is the whole core idea. Everything below is optional.

## How it works

<p align="center">
  <img src="docs/assets/readme/how-it-works.svg" width="100%" alt="Optional hosts (Claude Code, Codex, Pi) call Pappra through hooks, an MCP server or the command line. Pappra reads and writes two places in your workspace: .pappra/workspace.json, which is shared and committed, and .pappra/local/, which is private and ignores itself. A resume reports state and never grants permission to execute.">
</p>

Agents talk to Pappra through hooks, an MCP server or the command line. Pappra reads and
writes two places in your workspace: `.pappra/workspace.json` (shared, committed) and
`.pappra/local/` (private, ignores itself). Code-engine registrations live under
`.pappra/local/code`, never inside your checkout.

## What you get

- **Workspace configuration:** `.pappra/workspace.json`, plus `.pappra/local/machine.json` for
  settings that only apply to this computer.
- **Knowledge:** a catalog of the documents agents should know about. Registering is always
  preview-then-apply, and each document is its own file, so two people registering at once
  do not collide.
- **Continuity:** private checkpoints and resume reports that agents can read.
- **Code navigation:** status, preparation and lookup for the repositories you select. Plain
  text and structure search works with no code graph installed.
- **Integrations, all optional:** agent hooks, agent tools over MCP, and collaboration
  between agents.

## Next steps

Pick what you need. None of it is required.

- **Install it once:** `npx` downloads Pappra on each run. If you use it every day, install
  it so the command is just `pappra`:

  ```sh
  npm install -g @phyzess/pappra@beta
  ```

- **Let your agent use it:** `pappra mcp` gives an agent a few safe tools over stdio. For
  Claude Code or Pi, register it with the command below; Codex uses `codex mcp add`. Tools
  that write need trusted server startup policy, not a flag the agent passes itself. See
  [agent-native usage](docs/agent-native.md).

  ```sh
  pappra host mcp install --host claude --apply
  ```

- **Hooks:** `pappra host install` adds Pappra's own hook entries without taking over your
  configuration. `pappra task pin <id> --auto-resume` lets a hook hand an agent a bounded
  resume packet. See [host plugin validation](docs/host-plugin-validation.md).
- **Managed sessions:** `pappra session` starts a visible Pi terminal session that Pappra
  owns. See [managed Pi sessions](docs/managed-pi-session.md).
- **Collaboration:** `pappra collab workflow` coordinates several agents on one task. Roles
  grant no authority, a report is not acceptance, and a notification is not execution. See
  [the workflow contract](docs/collaboration-workflow.md) and
  [bounded collaboration](skills/pappra/references/collaboration.md).
- **Come back later:** running `pappra` with no arguments inside a workspace shows the current
  status and a short menu: resume a task, prepare the code index, scan documents, connect
  coding agents, health check, reconfigure, exit.

| Capability                                            | Needs                                          | Default                                        |
| ----------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| Workspace, init, doctor, checkpoint/resume, knowledge | Node.js only; Git to identify repositories     | Core, always available                         |
| Code graph status/prepare/query                       | An optional external code-graph engine         | Off unless selected; text fallback still works |
| Host hooks                                            | You choose Pi, Codex or Claude Code explicitly | Never installed automatically                  |
| Collaboration controller                              | An explicit `--controller <fixture\|pi-rpc>`   | No implicit controller                         |

Naming a host or protocol here only says Pappra can integrate with it. None of them is needed
for the core workflow above.

## Documentation

- [Quick start](docs/quickstart.md) and the [operations reference](docs/operations.md), which
  explains how `init` plans and applies, how the runtime copy is managed and how to repair
  interrupted state
- [API boundaries](docs/api.md) and [agent-native usage](docs/agent-native.md)
- [Support and limitations](docs/support.md), [portability](docs/portability.md) and
  [distribution](docs/distribution-plan.md)
- [Development](docs/development.md), for working inside this repository (`pnpm check`)

## Status and limits

Pappra is development software (`0.1.0-beta.22`), published as `@phyzess/pappra` under the
`beta` dist-tag. Pin either `beta` or an exact version, because pre-release versions are never
republished. Releases come from GitHub Actions through npm trusted publishing (OIDC); no npm
token is stored here.

The automated tests use synthetic workspaces, fixtures and local processes. They do not show
real-model behaviour, that every host works on every platform, that a graph engine is
complete, Windows/Linux parity or production performance. A host version listed as supported
is an observed claim, not proof that your installation loads or runs it.

Review state, with every tracked finding and its status, is in
[review closeout](docs/review-closeout.md). What the cold-start cases actually showed is in
[cold-start acceptance](docs/cold-start-acceptance.md).

## License

Pappra is licensed under the MIT License. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
