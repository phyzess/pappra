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
| `runtime_install` | `apply: true` |
| `collab_prepare` | writes the prepared goal/claims; the generated card is `declared` |
| `collab_start` | `confirm: true` **and** a runtime capability card; a declared card is refused |

`collab_prepare` turns an objective, acceptance list and explicit resource paths into a
`pappra/collaboration-goal/1`, runs `collab prepare`, and writes
`card.declared.json` next to `prepared.json`. A declared card cannot authorize a work
launch: provide a runtime card observed from an admitted session before calling
`collab_start`.

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
pappra task pin FIJI-123456 --auto-resume --json   # pin + enable the workspace switch
pappra task show --json
pappra task unpin
```

The pin lives in `.pappra/local/current-task`; `--auto-resume` sets
`continuity.autoResume` in `workspace.json` (backing up the previous file). Hooks include a
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
