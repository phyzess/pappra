import { runMcpServer } from '../../mcp/server.js';
import type { CliOutput } from '../output.js';

export const mcpUsage =
  'pappra mcp [--root <dir>] [--json]\n\n' +
  'Starts the Pappra MCP server on stdio for the selected workspace. The server exposes\n' +
  'read-only tools (workspace_status, resume, docs_list, docs_check, code_status,\n' +
  'code_query, runtime_status). stdout carries MCP JSON-RPC; use --help outside a host.';

export interface McpCommandOptions {
  readonly cwd: string;
  readonly root: string | null;
  readonly json: boolean;
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
  await runMcpServer(root);
  return 0;
}
