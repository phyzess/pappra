import { runMcpServer } from '../../mcp/server.js';
import type { CliOutput } from '../output.js';

export const mcpUsage =
  'pappra mcp [--root <dir>] [--allow-workspace-writes] [--json]\n\n' +
  'Starts the Pappra MCP server on stdio for the selected workspace. stdout carries\n' +
  'MCP JSON-RPC; use --help outside a host.\n\n' +
  'Read-only tools: workspace_status, resume, docs_list, docs_check, code_status,\n' +
  'code_query, runtime_status.\n' +
  'The default server cannot mutate state, install code or launch agent/index work. A trusted host may\n' +
  'enable checkpoint/docs_scan and workspace-private collab_prepare at server startup\n' +
  'with --allow-workspace-writes; apply only selects preview versus execution.\n' +
  'runtime_install and code_prepare execution always require the authorized CLI.\n' +
  'collab_start returns cli_required and never launches, even with confirm: true.';

export interface McpCommandOptions {
  readonly cwd: string;
  readonly root: string | null;
  readonly json: boolean;
  readonly allowWorkspaceWrites?: boolean;
}

export async function runMcpCommand(
  options: McpCommandOptions,
  output: CliOutput,
): Promise<number> {
  const root = options.root ?? options.cwd;
  if (options.json) {
    output.stderr(
      'pappra mcp: --json is not used; the server speaks MCP JSON-RPC on stdout.\n',
    );
  }
  await runMcpServer(root, options.allowWorkspaceWrites === true);
  return 0;
}
