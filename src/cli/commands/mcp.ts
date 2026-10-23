import { runMcpServer } from '../../mcp/server.js';
import type { CliOutput } from '../output.js';

export const mcpUsage =
  'pappra mcp [--root <dir>] [--json]\n\n' +
  'Starts the Pappra MCP server on stdio for the selected workspace. stdout carries\n' +
  'MCP JSON-RPC; use --help outside a host.\n\n' +
  'Read-only tools: workspace_status, resume, docs_list, docs_check, code_status,\n' +
  'code_query, runtime_status.\n' +
  'Gated write tools: checkpoint and docs_scan and code_prepare and runtime_install\n' +
  'require apply: true; collab_prepare writes the prepared goal and claims from an\n' +
  'explicit pappra/collaboration-goal/1 and generates no card; collab_start requires\n' +
  'confirm: true and an admitted runtime capability card, and refuses a declared or\n' +
  'stale card. No tool starts a model or answers a host approval prompt on its own.';

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
