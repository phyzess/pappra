# Agent-native usage

Pappra exposes its workspace capabilities to agents over MCP plus a small CLI surface.
Everything stays workspace-local; tools never infer identity, approval or a task from chat
text.

## MCP server

```sh
pappra mcp                 # stdio server for the current workspace
pappra mcp --root <dir>    # explicit workspace root
pappra mcp --help          # tool catalog
```

Read-only tools: `workspace_status`, `resume`, `docs_list`, `docs_check`, `code_status`,
`code_query`, `runtime_status`.

Write tools, gated by arguments:

| Tool | Gate |
| --- | --- |
| `checkpoint` | `apply: true` |
| `docs_scan` | `apply: true` registers; omitted/`false` only plans |
| `code_prepare` | `apply: true` mutates; omitted/`false` only plans |
| `runtime_install` | `apply: true`; only `from: "self"`, no source/version overrides |
| `collab_prepare` | writes the prepared goal/claims from an explicit goal; generates no card |
| `collab_start` | always returns `cli_required`; never launches from MCP |

`collab_prepare` accepts `{ domainRoot, goal }`, where `goal` is the shared strict
`pappra/collaboration-goal/1` document — the same document the installed CLI consumes
through `pappra collab prepare --goal <file> --domain-root <dir>`. Coordinator
(`agent_id`/`session_id`/`harness`/`owner_epoch`), assignee
(`agent_id`/`session_id`/`harness`/`surface`/`configuration_id`/`cwd`), resources,
`roles` and `required`/`preferred` capabilities are supplied explicitly; nothing is
inferred from prose, resource paths or defaults, and the assignee cwd must be a real
existing directory. Preparation maps the assignee harness to its established runner on
the assignment (`pi` → `pi-cli`, `codex` → `codex-exec`, `claude` → `claude-cli`); other
harnesses are refused before any task or claim is written. Explicit bounded unique
`roles` are copied to the assignment; omitting them defaults to `['implementer']`, and
`phase` never replaces an explicit role.

The earlier flat MCP form (`objective`, `task`, `acceptance`, `resources`,
`coordinatorSession`, `assigneeSession`, `harness`, `subtaskId`, `attempt`, `phase`,
`prompt` as tool arguments) is intentionally unsupported. Missing `goal`, mixed
legacy/new fields and unknown fields are refused by schema validation before any task
metadata, claim or card write. Migrate by building the goal document explicitly — the
same fields move under `goal` with snake_case protocol names, the coordinator/owner
epoch become required, and the assignee gains `surface`/`configuration_id`/`cwd`.

Preparation returns the existing prepared bundle and goal. It no longer synthesizes a
`card.declared.json` and no longer returns the removed `cardPath`/`card` outputs: a
declared card never authorized a launch. Callers supply actual capability evidence
separately — observe the receiving session, derive a runtime card with
`pappra collab capabilities derive`, check it with `pappra collab preflight`, then ask
the user to launch through `pappra collab run --prepared <file> --capabilities <file>
--controller <controller> --confirm`. Agent-supplied `confirm:true` is not user approval;
the MCP tool cannot launch. Tarball and registry runtime installs also require the CLI.
Declared, stale or mismatched evidence is still
refused by admission. This is metadata support only: live controllers remain
`fixture` and `pi-rpc`; `collab run` rejects a real controller whose
harness does not match the assignment without launching, and no Codex/Claude live
controller is added here.

An explicit `collab_prepare` call:

```json
{
  "domainRoot": "/absolute/domain",
  "goal": {
    "schema": "pappra/collaboration-goal/1",
    "task_id": "FIJI-123456",
    "subtask_id": "c10-explicit-preparation",
    "attempt": 1,
    "phase": "fix",
    "objective": "Prepare one bounded collaboration slice.",
    "acceptance": ["prepared references verify"],
    "prompt": "Use only the frozen prompt.",
    "roles": ["implementer"],
    "coordinator": {
      "agent_id": "pappra-coordinator",
      "session_id": "coordinator-native-session",
      "harness": "codex",
      "owner_epoch": 1
    },
    "assignee": {
      "agent_id": "pappra-implement",
      "session_id": "assignee-native-session",
      "harness": "pi",
      "surface": "cli",
      "configuration_id": "daily-herdr",
      "cwd": "/absolute/assignee/working/directory"
    },
    "resources": [{ "path": "/absolute/repo", "access": "write" }],
    "required": { "skills": [], "tools": ["read"] },
    "preferred": { "skills": [], "tools": [] }
  }
}
```

## Register the MCP server

```sh
pappra host mcp plan   --host claude --json      # inspect, no writes
pappra host mcp install --host claude --apply    # merge .mcp.json (pappra entry only)
pappra host mcp install --host pi --apply        # merge .pi/mcp.json (trusted projects)
pappra host mcp verify --host claude --json

# Codex MCP servers are user-scoped; pappra prints the host command:
codex mcp add pappra -- pappra mcp
```

Existing `mcpServers` entries are preserved. A different existing `pappra` entry is a
conflict; `--force` replaces it.

## Task pin and auto-resume

```sh
pappra task pin FIJI-123456 --auto-resume --json   # pin + enable this checkout's preference
pappra task show --json
pappra task unpin
```

The pin lives in `.pappra/local/current-task`; `--auto-resume` sets
the ignored `.pappra/local/task-preferences.json` (`pappra/task-preferences/1`). It does not modify shared `workspace.json`; cloning the shared workspace does not enable another user's preference. Hooks include a
bounded resume packet only when both the switch and a pin exist; without a pin they keep the
generic advisory text. Neither grants execution.

## Protocol probe

```sh
pappra host probe --host pi --json
pappra host probe --host codex --json
```

The Pi probe starts the RPC child in a throwaway session directory, sends `get_state`, and
checks the contracted session id plus the reported session file; it never sends a prompt or
starts a model. Other hosts probe the version against the pinned matrix.

## Version drift

`pappra doctor` and `pappra onboard` compare the installed version with the pinned matrix:
exact match → verified, same minor → unverified, different minor → unsupported with the safe
fallback. Release evidence is recorded in `docs/host-plugin-validation.md` and
`docs/pi-rpc.md`.
