import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { discoverWorkspace } from '../workspace/discover.js';
import {
  inspectMachineConfig,
  inspectWorkspaceConfig,
} from '../workspace/config.js';
import { inspectRuntimeStatePassive } from '../install/runtime.js';
import { CheckpointService } from '../continuity/service.js';
import { KnowledgeService } from '../knowledge/index.js';
import { CodeIntelligenceService } from '../code/index.js';
import { HOST_SUPPORT } from '../hosts/integration/support.js';
import { getPackageInfo } from '../package-info.js';
import { scanDiscoveredDocuments } from '../knowledge/scan.js';
import { prepareCollaboration } from '../app/collaboration.js';
import { collaborationGoalSchema } from '../schemas/collaboration.js';
import { canonicalizeTarget } from '../collab/canonical.js';
import { isPathInside } from '../schemas/paths.js';

export const MCP_SERVER_NAME = 'pappra';

export interface PappraMcpServerOptions {
  readonly root: string;
  /** Trusted server-launch policy, never accepted from tool arguments. */
  readonly allowWorkspaceWrites?: boolean;
}

function cliRequired(command: string): ToolPayload {
  return {
    ok: false,
    status: 'cli_required',
    message: `${command} requires an authorized CLI invocation. A tool-supplied apply flag is not user approval.`,
  };
}

interface ToolPayload {
  readonly [key: string]: unknown;
}

function toolResult(value: ToolPayload, isError = false) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `${JSON.stringify(value)}\n`,
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

async function errorResult(
  action: () => Promise<ToolPayload>,
): Promise<ReturnType<typeof toolResult>> {
  try {
    return toolResult(await action());
  } catch (error) {
    return toolResult(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      },
      true,
    );
  }
}

/**
 * Builds the stdio MCP server for one workspace. Tools are read-only here; write
 * operations require a trusted launch policy; tool flags only select preview/apply.
 */
export function createPappraMcpServer(
  options: PappraMcpServerOptions,
): McpServer {
  const root = options.root;
  const allowWorkspaceWrites = options.allowWorkspaceWrites === true;
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: getPackageInfo().version,
  });

  server.registerTool(
    'workspace_status',
    {
      title: 'Workspace status',
      description:
        'Read-only summary of the workspace configuration, repositories, knowledge sources, hosts and passive runtime state.',
      annotations: { readOnlyHint: true },
    },
    async () =>
      errorResult(async () => {
        const workspace = await inspectWorkspaceConfig(root, {
          missing: 'info',
        });
        const machine = await inspectMachineConfig(root);
        const discovery = await discoverWorkspace(root);
        const config = workspace.value;
        const runtime =
          machine.value?.runtime === null ||
          machine.value?.runtime === undefined
            ? null
            : await inspectRuntimeStatePassive(machine.value.runtime.version);
        return {
          ok: workspace.exists && machine.exists,
          workspaceRoot: root,
          config:
            config === null
              ? null
              : {
                  name: config.name,
                  repositories: config.repositories.map((repository) => ({
                    id: repository.id,
                    path: repository.path,
                    access: repository.access,
                  })),
                  knowledgeSources: config.knowledge.sources,
                  code: config.code,
                  validation: config.validation.map((entry) => entry.id),
                  excludes: config.excludes,
                },
          hosts: {
            selected: machine.value?.selectedHosts ?? [],
            pinned: Object.fromEntries(
              (['pi', 'codex', 'claude'] as const).map((host) => [
                host,
                HOST_SUPPORT[host].version,
              ]),
            ),
          },
          discoveredRepositories: discovery.repositories.length,
          discoveredDocuments: discovery.documents.length,
          runtime:
            runtime === null
              ? null
              : {
                  version: runtime.version,
                  status: runtime.status,
                  executableExists: runtime.executableExists,
                },
          diagnostics: [
            ...workspace.diagnostics,
            ...machine.diagnostics,
            ...discovery.diagnostics,
          ].filter((entry) => entry.severity !== 'info'),
        };
      }),
  );

  server.registerTool(
    'resume',
    {
      title: 'Resume a task checkpoint',
      description:
        'Reads the stored checkpoint for a task and returns the advisory resume packet. A packet never grants execution.',
      inputSchema: {
        task: z.string().min(1).max(256),
        session: z.string().min(1).max(256).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      errorResult(async () => {
        const service = new CheckpointService(root);
        const result = await service.resume({
          taskId: args.task,
          ...(args.session === undefined
            ? {}
            : { currentSession: args.session }),
        });
        return {
          ok: result.ok,
          status: result.status,
          packet: result.packet,
          diagnostics: result.diagnostics,
        };
      }),
  );

  server.registerTool(
    'docs_list',
    {
      title: 'List knowledge documents',
      description:
        'Lists registered knowledge documents. Private documents require includePrivate.',
      inputSchema: {
        includePrivate: z.boolean().optional(),
        includeArchived: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      errorResult(async () => {
        const service = new KnowledgeService(root);
        const result = await service.list({
          includePrivate: args.includePrivate === true,
          includeArchived: args.includeArchived === true,
        });
        return {
          ok: result.ok,
          catalogDigest: result.catalogDigest,
          documents: result.records.map((record) => ({
            documentId: record.documentId,
            kind: record.kind,
            lifecycle: record.lifecycle,
            maturity: record.maturity,
            visibility: record.visibility,
            location: record.location,
          })),
          diagnostics: result.diagnostics,
        };
      }),
  );

  server.registerTool(
    'docs_check',
    {
      title: 'Check knowledge freshness',
      description:
        'Checks registered documents for freshness and source drift.',
      inputSchema: { includePrivate: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      errorResult(async () => {
        const service = new KnowledgeService(root);
        const result = await service.check({
          includePrivate: args.includePrivate === true,
        });
        return {
          ok: result.ok,
          summary: result.summary,
          coverage: result.coverage,
          diagnostics: result.diagnostics,
        };
      }),
  );

  server.registerTool(
    'code_status',
    {
      title: 'Code index status',
      description:
        'Reports the selected repository code-index identity and health without preparing it.',
      inputSchema: { repo: z.string().min(1).max(128) },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      errorResult(async () => {
        const service = new CodeIntelligenceService(root);
        const result = await service.status({ repositoryId: args.repo });
        return {
          ok: result.ok,
          health: result.health,
          registrationPresent: result.registrationPresent,
          registrationPath: result.registrationPath,
          diagnostics: result.diagnostics,
        };
      }),
  );

  server.registerTool(
    'code_query',
    {
      title: 'Query repository code',
      description:
        'Bounded code query for one selected repository. Semantic kinds need a prepared index; text works without one.',
      inputSchema: {
        repo: z.string().min(1).max(128),
        kind: z.enum(['explore', 'symbol', 'references', 'impact', 'text']),
        query: z.string().min(1).max(4096),
        limit: z.number().int().min(1).max(100).optional(),
        maxBytes: z.number().int().min(1).max(1_048_576).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      errorResult(async () => {
        const service = new CodeIntelligenceService(root);
        const result = await service.query({
          root,
          repositoryId: args.repo,
          kind: args.kind,
          query: args.query,
          ...(args.limit === undefined && args.maxBytes === undefined
            ? {}
            : {
                limits: {
                  ...(args.limit === undefined
                    ? {}
                    : { maxResults: args.limit }),
                  ...(args.maxBytes === undefined
                    ? {}
                    : { maxBytes: args.maxBytes }),
                },
              }),
        });
        return {
          ok: result.ok,
          provider: result.result?.provider ?? null,
          coverage: result.result?.coverage ?? null,
          items: result.result?.items ?? [],
          truncated: result.result?.truncated ?? false,
          reasons: result.result?.reasons ?? [],
          health: result.health,
          diagnostics: result.diagnostics,
        };
      }),
  );

  server.registerTool(
    'checkpoint',
    {
      title: 'Write a task checkpoint',
      description:
        'Writes an advisory checkpoint only when trusted server startup enables workspace writes. apply selects persistence and never grants authorization.',
      inputSchema: {
        task: z.string().min(1).max(256),
        objective: z.string().min(1).max(4000),
        acceptance: z.array(z.string().min(1).max(1000)).max(32).optional(),
        constraints: z.array(z.string().min(1).max(1000)).max(32).optional(),
        decisions: z.array(z.string().min(1).max(1000)).max(32).optional(),
        attempted: z.array(z.string().min(1).max(1000)).max(32).optional(),
        nextActions: z.array(z.string().min(1).max(1000)).max(32).optional(),
        limitations: z.array(z.string().min(1).max(1000)).max(32).optional(),
        artifacts: z.array(z.string().min(1).max(2048)).max(32).optional(),
        contextCompleteness: z.enum(['complete', 'partial']).optional(),
        authorSession: z.string().min(1).max(256).optional(),
        nativeHarness: z.enum(['pi', 'codex', 'claude', 'unknown']).optional(),
        nativeSession: z.string().min(1).max(256).optional(),
        apply: z.boolean(),
      },
      annotations: { readOnlyHint: !allowWorkspaceWrites },
    },
    async (args) =>
      errorResult(async () => {
        if (!allowWorkspaceWrites) return cliRequired('pappra checkpoint');
        if (args.apply !== true) {
          return {
            ok: false,
            status: 'preview',
            message:
              'Preview only. The trusted host has enabled workspace writes; apply selects persistence, not authorization.',
          };
        }
        const nativeRefs =
          args.nativeSession === undefined
            ? []
            : [
                {
                  harness: args.nativeHarness ?? 'unknown',
                  sessionId: args.nativeSession,
                  turnId: null,
                  runId: null,
                },
              ];
        const service = new CheckpointService(root);
        const result = await service.save({
          taskId: args.task,
          objective: args.objective,
          ...(args.acceptance === undefined
            ? {}
            : { acceptance: args.acceptance }),
          ...(args.constraints === undefined
            ? {}
            : { constraints: args.constraints }),
          ...(args.decisions === undefined
            ? {}
            : { decisions: args.decisions }),
          ...(args.attempted === undefined
            ? {}
            : { attempted: args.attempted }),
          ...(args.nextActions === undefined
            ? {}
            : { nextActions: args.nextActions }),
          ...(args.limitations === undefined
            ? {}
            : { limitations: args.limitations }),
          ...(args.artifacts === undefined
            ? {}
            : { artifacts: args.artifacts }),
          ...(args.contextCompleteness === undefined
            ? {}
            : { contextCompleteness: args.contextCompleteness }),
          ...(args.authorSession === undefined
            ? {}
            : { authorSession: args.authorSession }),
          ...(nativeRefs.length === 0 ? {} : { nativeRefs }),
        });
        return {
          ok: result.ok,
          status: result.status,
          checkpointId: result.checkpoint?.checkpointId ?? null,
          checkpointPath: result.checkpointPath,
          diagnostics: result.diagnostics,
          residualPaths: result.residualPaths,
        };
      }),
  );

  server.registerTool(
    'docs_scan',
    {
      title: 'Scan knowledge sources',
      description:
        'Previews discovered knowledge documents. Applying requires trusted server startup workspace-write policy; tool flags do not grant it.',
      inputSchema: { apply: z.boolean().optional() },
      annotations: { readOnlyHint: !allowWorkspaceWrites },
    },
    async (args) =>
      errorResult(async () => {
        if (args.apply === true && !allowWorkspaceWrites)
          return cliRequired('pappra docs scan --apply');
        const result = await scanDiscoveredDocuments(root, {
          apply: args.apply === true,
        });
        return result as unknown as ToolPayload;
      }),
  );

  server.registerTool(
    'code_prepare',
    {
      title: 'Prepare a repository code index',
      description:
        'Previews repository index preparation. Engine execution requires an authorized CLI command.',
      inputSchema: {
        repo: z.string().min(1).max(128),
        apply: z.boolean().optional(),
        rebuild: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      errorResult(async () => {
        if (args.apply === true)
          return cliRequired('pappra code prepare --apply');
        const service = new CodeIntelligenceService(root);
        const result = await service.prepare({
          root,
          repositoryId: args.repo,
          apply: false,
          rebuild: args.rebuild === true,
        });
        return {
          ok: result.ok,
          status: result.status,
          plan: result.plan,
          health: result.health,
          registrationPath: result.registrationPath,
          diagnostics: result.diagnostics,
        };
      }),
  );

  server.registerTool(
    'runtime_install',
    {
      title: 'Install the durable runtime',
      description:
        'Reports CLI guidance for runtime installation; MCP never installs or executes package code. Only from:self is accepted.',
      inputSchema: z.strictObject({
        from: z.literal('self').optional(),
        apply: z.boolean(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      errorResult(async () => {
        const from = args.from ?? 'self';
        const version = getPackageInfo().version;
        return {
          ...cliRequired('pappra runtime install --from self --apply'),
          version,
          from,
        };
      }),
  );

  server.registerTool(
    'collab_prepare',
    {
      title: 'Prepare a bounded collaboration',
      description:
        'Prepares a bounded collaboration from an explicit shared pappra/collaboration-goal/1 document plus a shared domain root, then claims its resources. Identities, configuration, cwd, roles and capabilities are never inferred. No capability card is generated: derive and preflight actual runtime evidence separately before a user-authorized CLI launch. The legacy flat objective form is unsupported.',
      inputSchema: z.strictObject({
        domainRoot: z.string().min(1).max(4096),
        goal: collaborationGoalSchema,
      }),
      annotations: { readOnlyHint: !allowWorkspaceWrites },
    },
    async (args) =>
      errorResult(async () => {
        if (!allowWorkspaceWrites) return cliRequired('pappra collab prepare');
        const workspace = canonicalizeTarget(path.resolve(root)).path;
        const privateDomain = path.join(
          workspace,
          '.pappra',
          'local',
          'collaboration',
        );
        const domain = canonicalizeTarget(path.resolve(args.domainRoot)).path;
        if (
          !isPathInside(privateDomain, domain) ||
          !isPathInside(
            workspace,
            canonicalizeTarget(args.goal.assignee.cwd).path,
          ) ||
          args.goal.resources.some(
            (resource) =>
              !isPathInside(workspace, canonicalizeTarget(resource.path).path),
          )
        )
          return {
            ok: false,
            status: 'scope_refused',
            message:
              'MCP preparation is limited to a private workspace collaboration domain and workspace-local resources; use the authorized CLI for other scopes.',
          };
        const result = await prepareCollaboration(args.goal, {
          domainRoot: args.domainRoot,
        });
        if (!result.ok) {
          return {
            ok: false,
            status: result.status,
            code: result.code,
            message: result.message,
            nextAction: result.nextAction,
            diagnostics: result.diagnostics,
          };
        }
        return {
          ok: true,
          prepared: result.value.prepared,
          goal: result.value.goal,
          notes: [
            'No capability card is generated and no observation timestamp is manufactured. Supply actual capability evidence: derive a runtime card with pappra collab capabilities derive from the receiving session, check it with pappra collab preflight, then ask the user to launch with pappra collab run in the CLI.',
            'The removed cardPath/card outputs were declared-only evidence and never authorized a launch.',
          ],
        };
      }),
  );

  server.registerTool(
    'collab_start',
    {
      title: 'Start one admitted collaboration launch',
      description:
        'Returns CLI guidance without launching. The user must launch through the CLI; an agent-supplied confirm flag is not user approval.',
      inputSchema: {
        prepared: z.string().min(1).max(4096),
        capabilities: z.string().min(1).max(4096),
        controller: z.enum(['fixture', 'pi-rpc']),
        confirm: z.boolean(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () =>
      errorResult(async () => ({
        ok: false,
        status: 'cli_required',
        message:
          'MCP cannot authorize process launches. Ask the user to run pappra collab run --prepared <file> --capabilities <file> --controller <controller> --confirm in the CLI.',
      })),
  );

  server.registerTool(
    'runtime_status',
    {
      title: 'Runtime status',
      description:
        'Reports the workspace runtime binding and passive runtime state.',
      annotations: { readOnlyHint: true },
    },
    async () =>
      errorResult(async () => {
        const machine = await inspectMachineConfig(root);
        const binding = machine.value?.runtime ?? null;
        if (binding === null) {
          return { ok: true, binding: null, runtime: null };
        }
        const state = await inspectRuntimeStatePassive(binding.version);
        return {
          ok: true,
          binding,
          runtime: {
            version: state.version,
            status: state.status,
            packageDigestMatch: state.packageDigestMatch,
            executableExists: state.executableExists,
          },
          diagnostics: state.diagnostics,
        };
      }),
  );

  return server;
}

export async function runMcpServer(
  root: string,
  allowWorkspaceWrites = false,
): Promise<void> {
  const server = createPappraMcpServer({ root, allowWorkspaceWrites });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
