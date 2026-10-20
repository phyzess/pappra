import { join } from 'node:path';
import { z } from 'zod';
import { runCommand } from '../exec.js';
import { runTextQuery } from '../text.js';
import { observePath, readFileBounded, sha256Digest } from '../../infra/fs.js';
import { isPathInside, samePath } from '../../schemas/paths.js';
import { ensureCodeMutationBoundary } from '../registration.js';
import { boundCodeItems } from '../budget.js';
import { diagnosticCodes } from '../../schemas/errors.js';
import { failed, succeeded, type Outcome } from '../../schemas/outcome.js';
import type { EvidenceRef } from '../../schemas/evidence.js';
import {
  codeIndexHealthSchema,
  codeQueryResultSchema,
  type CodeIdentity,
  type CodeIndexHealth,
  type CodeQueryRequest,
  type CodeQueryResult,
  type CodePrepareAction,
  type CodePreparePlan,
} from '../../schemas/code.js';

const STATUS_MAX_BYTES = 1024 * 1024;
const PREPARE_MAX_BYTES = 4 * 1024 * 1024;

const engineStatusSchema = z.object({
  initialized: z.boolean(),
  version: z.string().min(1),
  projectPath: z.string().optional(),
  indexPath: z.string().optional(),
  lastIndexed: z.string().nullable().optional(),
  fileCount: z.number().int().nonnegative().optional(),
  nodeCount: z.number().int().nonnegative().optional(),
  edgeCount: z.number().int().nonnegative().optional(),
  dbSizeBytes: z.number().int().nonnegative().optional(),
  languages: z.array(z.string()).optional(),
  pendingChanges: z
    .object({
      added: z.number().int().nonnegative(),
      modified: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
    })
    .optional(),
  worktreeMismatch: z.unknown().nullable().optional(),
  index: z
    .object({
      builtWithVersion: z.string().nullable().optional(),
      builtWithExtractionVersion: z.number().nullable().optional(),
      currentExtractionVersion: z.number().nullable().optional(),
      reindexRecommended: z.boolean().optional(),
      state: z.string().optional(),
      pendingRefs: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

type EngineStatus = z.infer<typeof engineStatusSchema>;

function evidence(ref: string, stdout: string): EvidenceRef {
  return {
    kind: 'runtime-probe',
    ref,
    digest: sha256Digest(stdout),
    observedAt: new Date().toISOString(),
    scope: 'live-owned',
  };
}

const DEFAULT_CONFIG_DIGEST = sha256Digest('codegraph:default');

function indexCoverage(
  engine: EngineStatus | null,
): CodeIndexHealth['coverage'] {
  const languages = engine?.languages ?? [];
  return {
    scope: 'selected-repository',
    languages: [...new Set(languages)].sort().slice(0, 64),
    semantic: engine?.initialized === true,
    callGraph: engine?.initialized === true && (engine.edgeCount ?? 0) > 0,
    note: 'CodeGraph reports its own index coverage; ready does not imply complete semantic or call-graph coverage for every language or dynamic call.',
  };
}

function health(
  state: CodeIndexHealth['state'],
  reasons: readonly string[],
  evidenceRefs: readonly EvidenceRef[],
  engine: EngineStatus | null,
  engineVersion: string,
): CodeIndexHealth {
  return {
    schema: 'pappra/code-index-health/1',
    state,
    reasons: [...new Set(reasons)].slice(0, 32),
    evidence: [...evidenceRefs].slice(0, 32),
    coverage: indexCoverage(engine),
    engineVersion,
    observedAt: new Date().toISOString(),
  };
}

function parseEngineStatus(stdout: string): EngineStatus | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = engineStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function codeGraphVersion(
  signal?: AbortSignal,
): Promise<Outcome<string>> {
  const result = await runCommand({
    command: 'codegraph',
    args: ['--version'],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!result.ok) return result;
  const version = result.value.stdout.trim().split(/\s+/)[0] ?? '';
  if (version.length === 0 || result.value.exitCode !== 0) {
    return failed(
      diagnosticCodes.code_engine_unavailable,
      'CodeGraph did not report a usable version.',
      { nextAction: 'Install or repair the selected CodeGraph CLI.' },
    );
  }
  return succeeded(version);
}

export interface CodeGraphConfigObservation {
  readonly digest: string;
  readonly status: 'default' | 'observed' | 'unknown';
}

const UNKNOWN_CONFIG_DIGEST = sha256Digest('codegraph:unknown');

export async function observeCodeGraphConfig(
  root: string,
): Promise<Outcome<CodeGraphConfigObservation>> {
  const configPath = join(root, '.codegraph', 'config.json');
  const observed = await observePath(configPath);
  if (observed.kind === 'missing') {
    return succeeded({ digest: DEFAULT_CONFIG_DIGEST, status: 'default' });
  }
  if (observed.kind !== 'file') {
    return succeeded({ digest: UNKNOWN_CONFIG_DIGEST, status: 'unknown' });
  }
  const boundary = await ensureCodeMutationBoundary(root, configPath);
  if (!boundary.ok) {
    return succeeded({ digest: UNKNOWN_CONFIG_DIGEST, status: 'unknown' });
  }
  const read = await readFileBounded(configPath, 64 * 1024);
  if (!read.ok) {
    return succeeded({ digest: UNKNOWN_CONFIG_DIGEST, status: 'unknown' });
  }
  return succeeded({
    digest: sha256Digest(
      JSON.stringify({ id: 'codegraph', config: read.value.digest }),
    ),
    status: 'observed',
  });
}

export async function codeGraphConfigDigest(root: string): Promise<string> {
  const observed = await observeCodeGraphConfig(root);
  return observed.ok ? observed.value.digest : UNKNOWN_CONFIG_DIGEST;
}

export interface CodeProvider {
  readonly id: string;
  detect(
    root: string,
    signal?: AbortSignal,
  ): Promise<Outcome<readonly EvidenceRef[]>>;
  status(
    identity: CodeIdentity,
    signal?: AbortSignal,
  ): Promise<Outcome<CodeIndexHealth>>;
  prepare(
    identity: CodeIdentity,
    plan: CodePreparePlan,
    signal?: AbortSignal,
  ): Promise<Outcome<CodeIndexHealth>>;
  query(
    request: CodeQueryRequest,
    signal?: AbortSignal,
  ): Promise<Outcome<CodeQueryResult>>;
}

export function codeGraphPlanCommand(
  command: string,
  action: CodePrepareAction,
  root: string,
): string[] {
  if (action === 'none') {
    return [command, 'status', '--json', root];
  }
  if (action === 'rebuild') {
    return [command, 'index', '--force', root];
  }
  return [command, action, root];
}

export class CodeGraphProvider implements CodeProvider {
  readonly id = 'codegraph' as const;

  constructor(private readonly command: string = 'codegraph') {}

  async detect(
    root: string,
    signal?: AbortSignal,
  ): Promise<Outcome<readonly EvidenceRef[]>> {
    const result = await runCommand({
      command: this.command,
      args: ['--version'],
      cwd: root,
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!result.ok) return result;
    const version = result.value.stdout.trim().split(/\s+/)[0] ?? '';
    if (result.value.exitCode !== 0 || version.length === 0) {
      return failed(
        diagnosticCodes.code_engine_unavailable,
        'CodeGraph did not report a usable version.',
        { nextAction: 'Install or repair the selected CodeGraph CLI.' },
      );
    }
    return succeeded([evidence('codegraph --version', version)]);
  }

  async status(
    identity: CodeIdentity,
    signal?: AbortSignal,
  ): Promise<Outcome<CodeIndexHealth>> {
    const observed = await runCommand({
      command: this.command,
      args: ['status', '--json', identity.root],
      cwd: identity.root,
      timeoutMs: 10_000,
      maxOutputBytes: STATUS_MAX_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!observed.ok) {
      return succeeded(
        health(
          'unsupported',
          [observed.code, observed.message],
          [],
          null,
          identity.engine.version,
        ),
      );
    }
    const evidenceRefs = [
      evidence('codegraph status --json', observed.value.stdout),
    ];
    const engine = parseEngineStatus(observed.value.stdout);
    if (observed.value.exitCode !== 0) {
      return succeeded(
        health(
          'failed',
          [`engine_status_exit_${observed.value.exitCode}`],
          evidenceRefs,
          null,
          identity.engine.version,
        ),
      );
    }
    if (engine === null) {
      return succeeded(
        health(
          'partial',
          ['engine_status_unparseable'],
          evidenceRefs,
          null,
          identity.engine.version,
        ),
      );
    }
    if (!engine.initialized) {
      return succeeded(
        health(
          'missing',
          ['engine_index_missing'],
          evidenceRefs,
          engine,
          identity.engine.version,
        ),
      );
    }

    const reasons: string[] = [];
    if (identity.engine.configStatus === 'unknown') {
      reasons.push('engine_config_unknown');
    }
    if (
      engine.projectPath !== undefined &&
      !samePath(engine.projectPath, identity.root)
    ) {
      reasons.push('engine_project_path_mismatch');
    }
    if (engine.version !== identity.engine.version) {
      reasons.push(`engine_version_changed:${engine.version}`);
    }
    if (
      typeof engine.index?.builtWithVersion === 'string' &&
      engine.index.builtWithVersion !== engine.version
    ) {
      reasons.push('index_engine_version_changed');
    }
    if (
      engine.worktreeMismatch !== null &&
      engine.worktreeMismatch !== undefined
    ) {
      reasons.push('engine_worktree_mismatch');
    }
    const pending = engine.pendingChanges;
    if (
      pending !== undefined &&
      pending.added + pending.modified + pending.removed > 0
    ) {
      reasons.push('source_changes_pending');
    }
    if (engine.index?.reindexRecommended === true) {
      reasons.push('engine_reindex_recommended');
    }
    if (identity.workingTree.completeness !== 'complete') {
      reasons.push('working_tree_incomplete');
    }
    const indexState = engine.index?.state;
    if (indexState === 'building') {
      return succeeded(
        health(
          'building',
          [...reasons, 'engine_building'],
          evidenceRefs,
          engine,
          identity.engine.version,
        ),
      );
    }
    if (indexState === 'failed') {
      return succeeded(
        health(
          'failed',
          [...reasons, 'engine_failed'],
          evidenceRefs,
          engine,
          identity.engine.version,
        ),
      );
    }
    if (indexState === 'partial' || (engine.index?.pendingRefs ?? 0) > 0) {
      return succeeded(
        health(
          'partial',
          [...reasons, 'engine_partial_coverage'],
          evidenceRefs,
          engine,
          identity.engine.version,
        ),
      );
    }
    if (reasons.length > 0) {
      return succeeded(
        health('stale', reasons, evidenceRefs, engine, identity.engine.version),
      );
    }
    if (engine.lastIndexed === null || engine.lastIndexed === undefined) {
      return succeeded(
        health(
          'partial',
          ['engine_last_index_unknown'],
          evidenceRefs,
          engine,
          identity.engine.version,
        ),
      );
    }
    return succeeded(
      health('ready', [], evidenceRefs, engine, identity.engine.version),
    );
  }

  plan(
    identity: CodeIdentity,
    current: CodeIndexHealth,
    rebuild: boolean,
  ): CodePreparePlan {
    const indexPath = join(identity.root, '.codegraph');
    let action: CodePrepareAction = 'none';
    const reasons = [...current.reasons];
    if (rebuild) {
      action = 'rebuild';
    } else if (current.state === 'missing') {
      action = 'init';
    } else if (current.state === 'ready') {
      action = 'none';
    } else if (
      current.state === 'building' ||
      current.state === 'failed' ||
      current.reasons.some(
        (reason) =>
          reason === 'engine_worktree_mismatch' ||
          reason.startsWith('engine_version_changed') ||
          reason === 'engine_reindex_recommended',
      )
    ) {
      action = 'none';
      reasons.push('explicit_rebuild_required');
    } else if (current.state === 'stale' || current.state === 'partial') {
      action = 'sync';
    } else {
      action = 'none';
      reasons.push('prepare_unsupported');
    }
    const command = codeGraphPlanCommand(this.command, action, identity.root);
    return {
      schema: 'pappra/code-prepare-plan/1',
      repositoryId: identity.repositoryId,
      identityDigest: sha256Digest(JSON.stringify(identity)),
      action,
      indexPath,
      command,
      mutates: action !== 'none',
      reasons: [...new Set(reasons)].slice(0, 16),
    };
  }

  async prepare(
    identity: CodeIdentity,
    plan: CodePreparePlan,
    signal?: AbortSignal,
  ): Promise<Outcome<CodeIndexHealth>> {
    if (plan.action === 'none') {
      return this.status(identity, signal);
    }
    const [executable, ...prepareArgs] = plan.command;
    const result = await runCommand({
      command: executable ?? this.command,
      args: prepareArgs,
      cwd: identity.root,
      timeoutMs: plan.action === 'sync' ? 60_000 : 180_000,
      maxOutputBytes: PREPARE_MAX_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!result.ok) {
      return succeeded(
        health(
          'failed',
          [result.code, result.message],
          [],
          null,
          identity.engine.version,
        ),
      );
    }
    if (result.value.exitCode !== 0) {
      return succeeded(
        health(
          'failed',
          [`engine_prepare_exit_${result.value.exitCode}`],
          [evidence('codegraph prepare', result.value.stdout)],
          null,
          identity.engine.version,
        ),
      );
    }
    return this.status(identity, signal);
  }

  async query(
    request: CodeQueryRequest,
    signal?: AbortSignal,
  ): Promise<Outcome<CodeQueryResult>> {
    if (request.kind === 'text') {
      return runTextQuery(request, 'text', signal);
    }
    const current = await this.status(request.identity, signal);
    if (!current.ok) return current;
    if (current.value.state !== 'ready') {
      if (request.kind === 'symbol') {
        return runTextQuery(request, 'structure', signal);
      }
      return succeeded({
        schema: 'pappra/code-query-result/1',
        provider: 'codegraph',
        kind: request.kind,
        query: request.query,
        identityDigest: sha256Digest(JSON.stringify(request.identity)),
        observedIdentity: request.identity,
        coverage: 'unsupported',
        items: [],
        bytes: 0,
        truncated: false,
        reasons: ['index_not_ready'],
        evidence: current.value.evidence,
        unsupportedReason:
          'The selected CodeGraph index is not ready; use text query or prepare explicitly.',
      });
    }

    const limit = request.limits.maxResults;
    const root = request.identity.root;
    if (request.kind === 'explore') {
      const result = await runCommand({
        command: this.command,
        args: [
          'explore',
          '--path',
          root,
          '--max-files',
          String(Math.min(request.limits.maxFiles, 20)),
          request.query,
        ],
        cwd: root,
        timeoutMs: 30_000,
        maxOutputBytes: request.limits.maxBytes,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!result.ok) return result;
      if (result.value.exitCode !== 0) {
        return failed(
          diagnosticCodes.code_engine_failed,
          `CodeGraph explore exited ${result.value.exitCode}: ${result.value.stderr.slice(0, 300)}`,
          { nextAction: 'Use text fallback or inspect the engine error.' },
        );
      }
      const rawExplore = Buffer.from(result.value.stdout, 'utf8');
      const text = rawExplore
        .subarray(0, request.limits.maxBytes)
        .toString('utf8');
      const snippet = text.slice(0, 4096);
      const clipped =
        rawExplore.length > request.limits.maxBytes ||
        text.length > snippet.length;
      const exploreItems = [
        {
          path: '.',
          line: null,
          column: null,
          kind: 'explore',
          name: null,
          snippet,
          source: 'codegraph' as const,
        },
      ];
      const bounded = boundCodeItems(
        exploreItems,
        request.limits.maxBytes,
        request.limits.maxResults,
        request.limits.maxFiles,
      );
      const output = {
        schema: 'pappra/code-query-result/1' as const,
        provider: 'codegraph' as const,
        kind: request.kind,
        query: request.query,
        identityDigest: sha256Digest(JSON.stringify(request.identity)),
        observedIdentity: request.identity,
        coverage: 'partial' as const,
        items: bounded.items,
        bytes: bounded.bytes,
        truncated: clipped || bounded.truncated,
        reasons: [
          ...(clipped ? ['explore_output_clipped'] : []),
          ...bounded.reasons,
        ].slice(0, 16),
        evidence: [evidence('codegraph explore', result.value.stdout)],
        unsupportedReason: null,
      };
      const parsed = codeQueryResultSchema.safeParse(output);
      if (!parsed.success) {
        return failed(
          diagnosticCodes.code_engine_failed,
          `CodeGraph explore result violates the query contract: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
          { nextAction: 'Use text fallback or inspect the engine output.' },
        );
      }
      return succeeded(parsed.data);
    }

    const args =
      request.kind === 'symbol'
        ? [
            'query',
            '--json',
            '--path',
            root,
            '--limit',
            String(limit),
            request.query,
          ]
        : request.kind === 'references'
          ? [
              'callers',
              '--json',
              '--path',
              root,
              '--limit',
              String(limit),
              request.query,
            ]
          : ['impact', '--json', '--path', root, '--depth', '2', request.query];
    const result = await runCommand({
      command: this.command,
      args,
      cwd: root,
      timeoutMs: 30_000,
      maxOutputBytes: request.limits.maxBytes,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!result.ok) {
      if (request.kind === 'symbol') {
        return runTextQuery(request, 'structure', signal);
      }
      return result;
    }
    if (result.value.exitCode !== 0) {
      if (request.kind === 'symbol') {
        return runTextQuery(request, 'structure', signal);
      }
      return failed(
        diagnosticCodes.code_engine_failed,
        `CodeGraph query exited ${result.value.exitCode}: ${result.value.stderr.slice(0, 300)}`,
        { nextAction: 'Inspect the index or prepare it explicitly.' },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.value.stdout);
    } catch {
      if (request.kind === 'symbol') {
        return runTextQuery(request, 'structure', signal);
      }
      return failed(
        diagnosticCodes.code_engine_failed,
        'CodeGraph returned non-JSON query output.',
        { nextAction: 'Use text query or inspect the engine output.' },
      );
    }
    let rows: unknown[];
    if (request.kind === 'symbol') {
      if (!Array.isArray(parsed)) {
        return failed(
          diagnosticCodes.code_engine_failed,
          'CodeGraph symbol query result is not an array.',
          { nextAction: 'Use text query or inspect the engine output.' },
        );
      }
      rows = parsed;
    } else {
      const key = request.kind === 'references' ? 'callers' : 'affected';
      const container =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)
          : null;
      const value = container?.[key];
      if (!Array.isArray(value)) {
        return failed(
          diagnosticCodes.code_engine_failed,
          `CodeGraph ${request.kind} result is missing the ${key} array.`,
          { nextAction: 'Use text query or inspect the engine output.' },
        );
      }
      rows = value;
    }
    const items = [];
    const protectedRoots = [
      join(request.identity.root, '.pappra', 'local'),
      join(request.identity.root, '.pappra', 'generated'),
      ...(request.excludedRoots ?? []),
    ];
    let rowAdjusted = false;
    for (const raw of rows.slice(0, limit)) {
      if (typeof raw !== 'object' || raw === null) {
        rowAdjusted = true;
        continue;
      }
      const row = raw as Record<string, unknown>;
      const node =
        typeof row.node === 'object' && row.node !== null
          ? (row.node as Record<string, unknown>)
          : row;
      const path = typeof node.filePath === 'string' ? node.filePath : null;
      if (path === null || path.length > 2048) {
        rowAdjusted = true;
        continue;
      }
      const absolute = join(request.identity.root, path);
      if (
        !isPathInside(request.identity.root, absolute) ||
        (request.excludedRoots ?? []).some((excluded) =>
          isPathInside(excluded, absolute),
        )
      ) {
        rowAdjusted = true;
        continue;
      }
      const boundary = await ensureCodeMutationBoundary(
        request.identity.root,
        absolute,
        protectedRoots,
      );
      if (!boundary.ok) {
        rowAdjusted = true;
        continue;
      }
      const rawName = typeof node.name === 'string' ? node.name : null;
      const name = rawName === null ? null : rawName.slice(0, 512);
      if (rawName !== null && rawName.length > 512) rowAdjusted = true;
      const rawKind = typeof node.kind === 'string' ? node.kind : '';
      const kind = rawKind.length > 0 ? rawKind.slice(0, 64) : 'unknown';
      if (rawKind.length === 0 || rawKind.length > 64) rowAdjusted = true;
      const rawLine = node.startLine;
      const line =
        typeof rawLine === 'number' && Number.isInteger(rawLine) && rawLine > 0
          ? rawLine
          : null;
      if (rawLine !== null && line === null) rowAdjusted = true;
      const rawColumn = node.startColumn;
      const column =
        typeof rawColumn === 'number' &&
        Number.isInteger(rawColumn) &&
        rawColumn >= 0
          ? rawColumn
          : null;
      if (rawColumn !== null && column === null) rowAdjusted = true;
      const rawSnippet =
        typeof node.signature === 'string' ? node.signature : '';
      const snippet = rawSnippet.slice(0, 4096);
      if (rawSnippet.length > 4096) rowAdjusted = true;
      items.push({
        path,
        line,
        column,
        kind,
        name,
        snippet,
        source: 'codegraph' as const,
      });
    }
    const bounded = boundCodeItems(
      items,
      request.limits.maxBytes,
      request.limits.maxResults,
      request.limits.maxFiles,
    );
    const clipped = rowAdjusted || rows.length > limit || bounded.truncated;
    const output = {
      schema: 'pappra/code-query-result/1' as const,
      provider: 'codegraph' as const,
      kind: request.kind,
      query: request.query,
      identityDigest: sha256Digest(JSON.stringify(request.identity)),
      observedIdentity: request.identity,
      coverage:
        clipped || request.kind === 'references'
          ? ('partial' as const)
          : ('complete' as const),
      items: bounded.items,
      bytes: bounded.bytes,
      truncated: clipped,
      reasons: [
        ...(request.kind === 'references' ? ['callers_not_references'] : []),
        ...(rowAdjusted ? ['native_rows_adjusted'] : []),
        ...(rows.length > limit ? ['result_limit'] : []),
        ...bounded.reasons,
      ].slice(0, 16),
      evidence: [evidence('codegraph query', result.value.stdout)],
      unsupportedReason:
        request.kind === 'references'
          ? 'CodeGraph callers are caller edges, not an exhaustive reference index.'
          : null,
    };
    const parsedResult = codeQueryResultSchema.safeParse(output);
    if (!parsedResult.success) {
      return failed(
        diagnosticCodes.code_engine_failed,
        `CodeGraph query result violates the query contract: ${parsedResult.error.issues[0]?.message ?? 'unknown issue'}`,
        { nextAction: 'Use text fallback or inspect the engine output.' },
      );
    }
    return succeeded(parsedResult.data);
  }
}

export function codeGraphIndexPath(root: string): string {
  return join(root, '.codegraph');
}

export function codeGraphStatusSchemaForTests(): typeof engineStatusSchema {
  return engineStatusSchema;
}

export function codeIndexHealthForTests(
  state: CodeIndexHealth['state'],
  reasons: readonly string[],
): CodeIndexHealth {
  return codeIndexHealthSchema.parse(health(state, reasons, [], null, 'test'));
}
