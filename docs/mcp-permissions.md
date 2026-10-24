# MCP permissions

The default `pappra mcp` server is read-only. A tool argument such as `apply: true`
selects a requested operation; it cannot grant permission or prove a user approved it.
Mutation requests on the default server return `cli_required` without writing.

A trusted host configuration can launch `pappra mcp --allow-workspace-writes` to
enable checkpoint persistence, knowledge registration and workspace-private
collaboration preparation. This policy is chosen when starting the server and is
not an MCP tool argument. The host must still authorize tool use for the actual task.

MCP collaboration domains must resolve under `.pappra/local/collaboration`;
assignee working directories and claimed resources must resolve inside the selected
workspace. Use an authorized CLI invocation for external repositories or other domains.
Preparation does not launch an agent or produce runtime capability evidence.

Runtime installation, external index preparation and agent launch always require
the CLI, even on a workspace-write-enabled server. Their MCP tools provide guidance
and previews rather than executing package code or starting processes.

## Visible collaboration

Pappra can coordinate existing native agent sessions through its prepare, capability
derivation, preflight and registered-message commands. A stale inherited Herdr pane
does not prove that the whole channel is unavailable. Inspect the actual current task,
resolve its explicit named caller and pane, then bind that observed route with
`--caller-pane`; never substitute the user's focused pane as an identity fallback.

A notification receipt establishes submission only. Verify the receiver's native
session, ACK, registered REPORT digest, input revision and actual artifacts before
accepting work. A pane or self-reported envelope identity is not process authentication.
The owned Pi RPC controller and visible native-session messaging are distinct paths.
