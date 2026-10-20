import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
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
import { installRuntime } from '../install/runtime.js';
import { bindAndRecordRuntime, ensureDefaultRuntime } from '../app/init.js';
import { prepareFromObjective } from '../app/collab-from.js';
import {
  FixtureController,
  PiRpcController,
  finishStarted,
  startPrepared,
  submitResultReport,
} from '../app/collaboration.js';

export const MCP_SERVER_NAME = 'pappra';

export interface PappraMcpServerOptions {
  readonly root: string;
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
 * operations are added separately and must stay behind apply/confirm gates.
 */
export function createPappraMcpServer(
  options: PappraMcpServerOptions,
): McpServer {
  const root = options.root;
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
        'Writes an advisory checkpoint for handoff. Requires apply: true; a checkpoint is context, not permission to execute.',
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
      annotations: { readOnlyHint: false },
    },
    async (args) =>
      errorResult(async () => {
        if (args.apply !== true) {
          return {
            ok: false,
            status: 'confirmation_required',
            message:
              'checkpoint writes state; call again with apply: true after the user agrees.',
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
        'Registers documents discovered under the configured knowledge sources. Without apply it only reports candidates.',
      inputSchema: { apply: z.boolean().optional() },
      annotations: { readOnlyHint: false },
    },
    async (args) =>
      errorResult(async () => {
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
        'Registers the selected repository index and optionally runs the external engine. Without apply it only reports the plan.',
      inputSchema: {
        repo: z.string().min(1).max(128),
        apply: z.boolean().optional(),
        rebuild: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) =>
      errorResult(async () => {
        const service = new CodeIntelligenceService(root);
        const result = await service.prepare({
          root,
          repositoryId: args.repo,
          apply: args.apply === true,
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
        'Installs and binds a durable runtime copy. Requires apply: true; the default source is the running package.',
      inputSchema: {
        from: z.enum(['self', 'tarball', 'version']).optional(),
        version: z.string().min(1).max(128).optional(),
        tarball: z.string().min(1).max(4096).optional(),
        apply: z.boolean(),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) =>
      errorResult(async () => {
        const from = args.from ?? 'self';
        const version = args.version ?? getPackageInfo().version;
        if (args.apply !== true) {
          return {
            ok: false,
            status: 'confirmation_required',
            message:
              'runtime_install writes a durable copy and machine.json; call again with apply: true.',
            version,
            from,
          };
        }
        if (from === 'self') {
          const result = await ensureDefaultRuntime(root, version);
          return {
            ok: result.ok && result.completion,
            completion: result.completion,
            runtime: result.runtime,
            diagnostics: result.diagnostics,
          };
        }
        const tarball = args.tarball;
        if (from === 'tarball' && tarball === undefined) {
          return {
            ok: false,
            message: 'from: tarball requires the tarball path.',
          };
        }
        const installed = await installRuntime({
          version,
          source:
            from === 'tarball' && tarball !== undefined
              ? { kind: 'tarball', path: tarball }
              : { kind: 'version' },
          packageName: getPackageInfo().name,
        });
        const bound = await bindAndRecordRuntime(root, installed);
        return {
          ok: bound.ok && bound.completion,
          completion: bound.completion,
          runtime: installed,
          diagnostics: bound.diagnostics,
        };
      }),
  );

  server.registerTool(
    'collab_prepare',
    {
      title: 'Prepare a bounded collaboration',
      description:
        'Builds a collaboration goal and a declared capability card from an objective and explicit resources, then claims them. A declared card cannot authorize a work launch.',
      inputSchema: {
        domainRoot: z.string().min(1).max(4096),
        objective: z.string().min(1).max(4000),
        task: z.string().min(1).max(128),
        acceptance: z.array(z.string().min(1).max(1000)).min(1).max(32),
        resources: z
          .array(
            z.object({
              path: z.string().min(1).max(4096),
              access: z.enum(['read', 'write']),
            }),
          )
          .min(1)
          .max(32),
        coordinatorSession: z.string().min(1).max(256),
        assigneeSession: z.string().min(1).max(256),
        harness: z.enum(['pi', 'codex', 'claude']).optional(),
        subtaskId: z.string().min(1).max(128).optional(),
        attempt: z.number().int().min(1).max(1000).optional(),
        phase: z
          .enum(['discovery', 'implementation', 'review', 'handoff', 'fix'])
          .optional(),
        prompt: z.string().min(1).max(20000).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) =>
      errorResult(async () => {
        const result = await prepareFromObjective({
          domainRoot: args.domainRoot,
          objective: args.objective,
          taskId: args.task,
          acceptance: args.acceptance,
          resources: args.resources,
          coordinatorSession: args.coordinatorSession,
          assigneeSession: args.assigneeSession,
          ...(args.harness === undefined ? {} : { harness: args.harness }),
          ...(args.subtaskId === undefined
            ? {}
            : { subtaskId: args.subtaskId }),
          ...(args.attempt === undefined ? {} : { attempt: args.attempt }),
          ...(args.phase === undefined ? {} : { phase: args.phase }),
          ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
        });
        return result as unknown as ToolPayload;
      }),
  );

  server.registerTool(
    'collab_start',
    {
      title: 'Start one admitted collaboration launch',
      description:
        'Performs one admitted launch with an explicit controller and returns the report. Requires confirm: true and a runtime capability card; a declared card is refused by admission.',
      inputSchema: {
        prepared: z.string().min(1).max(4096),
        capabilities: z.string().min(1).max(4096),
        controller: z.enum(['fixture', 'pi-rpc']),
        confirm: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) =>
      errorResult(async () => {
        if (args.confirm !== true) {
          return {
            ok: false,
            status: 'confirmation_required',
            message:
              'collab_start launches a process; the user must confirm before calling it with confirm: true.',
          };
        }
        const controller =
          args.controller === 'fixture'
            ? new FixtureController()
            : new PiRpcController();
        const started = await startPrepared(args.prepared, {
          capabilitiesFile: args.capabilities,
          controller,
          controllerId: controller.id,
        });
        if (!started.ok) return started as unknown as ToolPayload;
        try {
          const finished = await finishStarted(started.value);
          if (!finished.ok) {
            return finished as unknown as ToolPayload;
          }
          const report = submitResultReport(started.value, finished.value);
          return {
            ok: report.ok,
            status: finished.value.status,
            report,
            finish: finished.value,
          };
        } finally {
          await started.value.session.dispose?.().catch(() => undefined);
        }
      }),
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

export async function runMcpServer(root: string): Promise<void> {
  const server = createPappraMcpServer({ root });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
