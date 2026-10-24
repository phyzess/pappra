import {
  createGitObservationScope,
  type GitObservationScope,
} from '../infra/git.js';
import { sha256Digest } from '../infra/fs.js';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import type { Failure, Outcome } from '../schemas/outcome.js';
import { succeeded } from '../schemas/outcome.js';
import {
  inspectMachineConfig,
  inspectWorkspaceConfig,
} from '../workspace/config.js';
import { discoverRepositories } from '../workspace/repositories.js';
import type { DiscoveredRepository } from '../workspace/types.js';
import {
  codeIndexHealthSchema,
  codePreparePlanSchema,
  codeQueryLimitsSchema,
  codeQueryRequestSchema,
  type CodeIdentity,
  type CodeIndexHealth,
  type CodeIndexRegistration,
  type CodePreparePlan,
  type CodePrepareResult,
  type CodeQueryKind,
  type CodeQueryLimits,
  type CodeQueryRequest,
  type CodeQueryResult,
} from '../schemas/code.js';
import {
  CodeGraphProvider,
  observeCodeGraphConfig,
  codeGraphVersion,
  codeGraphPlanCommand,
} from './providers/codegraph.js';
import { computeCodeIdentity, codeIdentityDigest } from './identity.js';
import {
  codeRegistrationPath,
  readCodeRegistration,
  registrationMatches,
  acquireCodePrepareLock,
  releaseCodePrepareLock,
  ensureCodeMutationBoundary,
  writeCodeRegistration,
} from './registration.js';
import { runTextQuery } from './text.js';

const discoveryOptions = {
  scanDepth: 0,
  maxDirectories: 1,
  maxDocuments: 1,
  maxEntriesPerDirectory: 1,
  gitTimeoutMs: 10_000,
} as const;

export interface CodeStatusResult {
  readonly ok: boolean;
  readonly identity: CodeIdentity | null;
  readonly health: CodeIndexHealth;
  readonly registrationPath: string | null;
  readonly registrationPresent: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export interface CodeStatusInput {
  readonly root: string;
  readonly repositoryId: string;
  readonly signal?: AbortSignal;
  /**
   * One operation's Git probe scope. Callers that run several service methods
   * for a single command may pass one scope so workspace discovery and every
   * identity probe share immutable repository observations. Omitted callers get
   * a scope that lives only for this call: no result is ever cached across
   * operations.
   */
  readonly observations?: GitObservationScope;
}

export interface CodePrepareInput extends CodeStatusInput {
  readonly apply: boolean;
  readonly rebuild: boolean;
}

export interface CodeQueryInput extends CodeStatusInput {
  readonly kind: CodeQueryKind;
  readonly query: string;
  readonly limits?: Partial<CodeQueryLimits>;
}

export interface CodeQueryOutput {
  readonly ok: boolean;
  readonly result: CodeQueryResult | null;
  readonly health: CodeIndexHealth;
  readonly diagnostics: readonly Diagnostic[];
}

function outcomeDiagnostic(failure: Failure, source: string): Diagnostic {
  return createDiagnostic({
    code: failure.code,
    severity: 'error',
    message: failure.message,
    source,
    pointer: null,
    hint: failure.nextAction,
  });
}

function fallbackHealth(
  state: CodeIndexHealth['state'],
  reason: string,
  engineVersion = 'unknown',
): CodeIndexHealth {
  return codeIndexHealthSchema.parse({
    schema: 'pappra/code-index-health/1',
    state,
    reasons: [reason],
    evidence: [],
    coverage: {
      scope: 'selected-repository',
      languages: [],
      semantic: false,
      callGraph: false,
      note: 'No ready code index was established.',
    },
    engineVersion,
    observedAt: new Date().toISOString(),
  });
}

interface WorkspaceView {
  readonly root: string;
  readonly repositories: readonly DiscoveredRepository[];
  readonly diagnostics: readonly Diagnostic[];
}

async function loadWorkspace(
  root: string,
  observations: GitObservationScope,
): Promise<WorkspaceView> {
  const config = await inspectWorkspaceConfig(root);
  const diagnostics: Diagnostic[] = [...config.diagnostics];
  if (config.value === null) {
    return { root: config.root, repositories: [], diagnostics };
  }
  const machine = await inspectMachineConfig(config.root);
  diagnostics.push(...machine.diagnostics);
  const repositories = await discoverRepositories({
    root: config.root,
    config: config.value,
    machine: machine.value,
    configPath: config.path,
    options: discoveryOptions,
    observations,
  });
  diagnostics.push(...repositories.diagnostics);
  return {
    root: config.root,
    repositories: repositories.repositories,
    diagnostics,
  };
}

function selectRepository(
  view: WorkspaceView,
  repositoryId: string,
): DiscoveredRepository | null {
  return (
    view.repositories.find(
      (repository) => repository.id === repositoryId && !repository.external,
    ) ??
    view.repositories.find((repository) => repository.id === repositoryId) ??
    null
  );
}

interface ObservedCode {
  readonly identity: CodeIdentity | null;
  readonly rawHealth: CodeIndexHealth;
  readonly health: CodeIndexHealth;
  readonly registration: CodeIndexRegistration | null;
  readonly registrationPath: string | null;
  readonly excludedRoots: readonly string[];
  readonly access: 'read' | 'write';
  readonly diagnostics: readonly Diagnostic[];
}

function overlayRegistration(
  raw: CodeIndexHealth,
  registration: CodeIndexRegistration | null,
  registrationFailure: Failure | null,
  identity: CodeIdentity,
): CodeIndexHealth {
  const reasons = [...raw.reasons];
  if (registrationFailure !== null) {
    reasons.push(registrationFailure.code);
    return {
      ...raw,
      state: raw.state === 'ready' ? 'partial' : raw.state,
      reasons: [...new Set(reasons)].slice(0, 32),
    };
  }
  if (raw.state !== 'ready') return raw;
  if (registration === null) {
    return {
      ...raw,
      state: 'partial',
      reasons: [...reasons, 'registration_missing'].slice(0, 32),
    };
  }
  if (!registrationMatches(registration, identity)) {
    return {
      ...raw,
      state: 'stale',
      reasons: [...reasons, 'registration_identity_changed'].slice(0, 32),
    };
  }
  return raw;
}

async function observeCode(input: CodeStatusInput): Promise<ObservedCode> {
  const observations =
    input.observations ??
    createGitObservationScope({ workingTreeState: false });
  const view = await loadWorkspace(input.root, observations);
  const diagnostics = [...view.diagnostics];
  const repository = selectRepository(view, input.repositoryId);
  if (repository === null) {
    return {
      identity: null,
      rawHealth: fallbackHealth('unsupported', 'repository_not_found'),
      health: fallbackHealth('unsupported', 'repository_not_found'),
      registration: null,
      registrationPath: null,
      excludedRoots: [],
      access: 'read',
      diagnostics: [
        ...diagnostics,
        createDiagnostic({
          code: diagnosticCodes.code_repository_unknown,
          severity: 'error',
          message: `Selected repository is not declared: ${input.repositoryId}`,
          source: view.root,
          pointer: null,
          hint: 'Select an explicit repository id from workspace.json.',
        }),
      ],
    };
  }
  const version = await codeGraphVersion(input.signal);
  const versionValue = version.ok ? version.value : 'unknown';
  if (!version.ok)
    diagnostics.push(outcomeDiagnostic(version, repository.root));
  const configObserved = await observeCodeGraphConfig(repository.root);
  const configDigest = configObserved.ok
    ? configObserved.value.digest
    : sha256Digest('codegraph:unknown');
  const configStatus = configObserved.ok
    ? configObserved.value.status
    : 'unknown';
  if (configStatus === 'unknown') {
    diagnostics.push(
      createDiagnostic({
        code: diagnosticCodes.code_index_partial,
        severity: 'warning',
        message:
          'CodeGraph configuration could not be observed as a regular bounded file; ready is not permitted.',
        source: repository.root,
        pointer: '.codegraph/config.json',
        hint: 'Inspect the engine configuration; the default configuration is not assumed.',
      }),
    );
  }
  const excludedRoots = view.repositories
    .filter((entry) => entry.root !== repository.root)
    .map((entry) => entry.root);
  const identity = await computeCodeIdentity({
    repositoryId: input.repositoryId,
    root: repository.root,
    engineVersion: versionValue,
    configDigest,
    configStatus,
    excludedRoots,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    observations,
  });
  if (!identity.ok) {
    diagnostics.push(outcomeDiagnostic(identity, repository.root));
    return {
      identity: null,
      rawHealth: fallbackHealth('partial', identity.code, versionValue),
      health: fallbackHealth('partial', identity.code, versionValue),
      registration: null,
      registrationPath: null,
      excludedRoots,
      access: repository.access,
      diagnostics,
    };
  }
  const provider = new CodeGraphProvider();
  const raw = await provider.status(identity.value, input.signal);
  const rawHealth = raw.ok
    ? raw.value
    : fallbackHealth('unsupported', raw.code, versionValue);
  if (!raw.ok) diagnostics.push(outcomeDiagnostic(raw, repository.root));
  // Registrations belong to the workspace, not to a repository checkout: writing
  // <repo>/.pappra/local/code would make that checkout look like a nested workspace
  // and hide it from the outer workspace discovery.
  const registrationRead = await readCodeRegistration(
    input.root,
    input.repositoryId,
  );
  let registration: CodeIndexRegistration | null = null;
  let registrationFailure: Failure | null = null;
  if (registrationRead.ok) {
    registration = registrationRead.value;
  } else {
    registrationFailure = registrationRead;
    diagnostics.push(outcomeDiagnostic(registrationRead, repository.root));
  }
  const health = overlayRegistration(
    rawHealth,
    registration,
    registrationFailure,
    identity.value,
  );
  return {
    identity: identity.value,
    rawHealth,
    health,
    registration,
    registrationPath: codeRegistrationPath(input.root, input.repositoryId),
    excludedRoots,
    access: repository.access,
    diagnostics,
  };
}

export class CodeIntelligenceService {
  constructor(private readonly root: string) {}

  async status(
    input?: Partial<Omit<CodeStatusInput, 'root'>>,
  ): Promise<CodeStatusResult> {
    const repositoryId = input?.repositoryId;
    if (repositoryId === undefined) {
      const health = fallbackHealth('unsupported', 'repository_required');
      return {
        ok: false,
        identity: null,
        health,
        registrationPath: null,
        registrationPresent: false,
        diagnostics: [
          createDiagnostic({
            code: diagnosticCodes.code_repository_required,
            severity: 'error',
            message: 'code status requires an explicit repository id.',
            source: this.root,
            pointer: null,
            hint: 'Pass --repo <id> from workspace.json.',
          }),
        ],
      };
    }
    const observed = await observeCode({
      root: this.root,
      repositoryId,
      ...(input?.signal === undefined ? {} : { signal: input.signal }),
    });
    return {
      ok: observed.identity !== null && observed.health.state === 'ready',
      identity: observed.identity,
      health: observed.health,
      registrationPath: observed.registrationPath,
      registrationPresent: observed.registration !== null,
      diagnostics: observed.diagnostics,
    };
  }

  async planPrepare(input: CodePrepareInput): Promise<{
    readonly observed: ObservedCode;
    readonly plan: CodePreparePlan;
  }> {
    const observed = await observeCode(input);
    if (observed.identity === null) {
      return {
        observed,
        plan: codePreparePlanSchema.parse({
          schema: 'pappra/code-prepare-plan/1',
          repositoryId: input.repositoryId,
          identityDigest: `sha256:${'0'.repeat(64)}`,
          action: 'none',
          indexPath: this.root,
          command: ['codegraph', 'status', '--json', this.root],
          mutates: false,
          reasons: ['identity_unavailable'],
        }),
      };
    }
    const provider = new CodeGraphProvider();
    let plan = provider.plan(
      observed.identity,
      observed.rawHealth,
      input.rebuild,
    );
    if (
      observed.registration !== null &&
      !registrationMatches(observed.registration, observed.identity) &&
      plan.action === 'none' &&
      !input.rebuild
    ) {
      const sameEngineAndCheckout =
        observed.registration.checkoutId === observed.identity.checkoutId &&
        observed.registration.engineVersion ===
          observed.identity.engine.version &&
        observed.registration.configDigest ===
          observed.identity.engine.configDigest;
      plan = sameEngineAndCheckout
        ? {
            ...plan,
            action: 'sync',
            command: codeGraphPlanCommand(
              'codegraph',
              'sync',
              observed.identity.root,
            ),
            mutates: true,
            reasons: [
              ...plan.reasons,
              'registration_working_tree_changed',
            ].slice(0, 16),
          }
        : {
            ...plan,
            action: 'none',
            command: codeGraphPlanCommand(
              'codegraph',
              'none',
              observed.identity.root,
            ),
            mutates: false,
            reasons: [
              ...plan.reasons,
              'registration_identity_changed',
              'explicit_rebuild_required',
            ].slice(0, 16),
          };
    }
    return { observed, plan };
  }

  async prepare(input: CodePrepareInput): Promise<CodePrepareResult> {
    // Reuse probes within planning; refresh after external preparation because
    // another writer or the engine may change HEAD while this call is awaiting.
    const observations =
      input.observations ??
      createGitObservationScope({ workingTreeState: false });
    const { observed, plan } = await this.planPrepare({
      ...input,
      observations,
    });
    if (!input.apply) {
      return {
        schema: 'pappra/code-prepare-result/1',
        ok: observed.identity !== null,
        status: 'planned',
        plan,
        health: observed.health,
        registrationPath: null,
        diagnostics: [...observed.diagnostics],
      };
    }
    if (observed.identity === null) {
      return {
        schema: 'pappra/code-prepare-result/1',
        ok: false,
        status: 'failed',
        plan,
        health: observed.health,
        registrationPath: null,
        diagnostics: [...observed.diagnostics],
      };
    }
    if (plan.reasons.includes('explicit_rebuild_required')) {
      return {
        schema: 'pappra/code-prepare-result/1',
        ok: false,
        status: 'conflict',
        plan,
        health: observed.health,
        registrationPath: null,
        diagnostics: [...observed.diagnostics],
      };
    }
    if (observed.access !== 'write') {
      return {
        schema: 'pappra/code-prepare-result/1',
        ok: false,
        status: 'conflict',
        plan: {
          ...plan,
          action: 'none',
          command: codeGraphPlanCommand(
            'codegraph',
            'none',
            observed.identity.root,
          ),
          mutates: false,
          reasons: [...plan.reasons, 'repository_read_only'].slice(0, 16),
        },
        health: observed.health,
        registrationPath: null,
        diagnostics: [...observed.diagnostics],
      };
    }
    const registrationTarget = codeRegistrationPath(
      input.root,
      observed.identity.repositoryId,
    );
    const boundaries = await Promise.all([
      ensureCodeMutationBoundary(
        observed.identity.root,
        plan.indexPath,
        observed.excludedRoots,
      ),
      ensureCodeMutationBoundary(input.root, registrationTarget),
    ]);
    for (const boundary of boundaries) {
      if (!boundary.ok) {
        return {
          schema: 'pappra/code-prepare-result/1',
          ok: false,
          status: 'conflict',
          plan: {
            ...plan,
            action: 'none',
            command: codeGraphPlanCommand(
              'codegraph',
              'none',
              observed.identity.root,
            ),
            mutates: false,
            reasons: [...plan.reasons, boundary.code].slice(0, 16),
          },
          health: observed.health,
          registrationPath: null,
          diagnostics: [
            ...observed.diagnostics,
            outcomeDiagnostic(boundary, registrationTarget),
          ],
        };
      }
    }
    const lock = await acquireCodePrepareLock(input.root);
    if (!lock.ok) {
      return {
        schema: 'pappra/code-prepare-result/1',
        ok: false,
        status: 'conflict',
        plan: {
          ...plan,
          action: 'none',
          mutates: false,
          command: codeGraphPlanCommand(
            'codegraph',
            'none',
            observed.identity.root,
          ),
        },
        health: observed.health,
        registrationPath: null,
        diagnostics: [
          ...observed.diagnostics,
          outcomeDiagnostic(lock, observed.identity.root),
        ],
      };
    }
    const perform = async (): Promise<CodePrepareResult> => {
      const identity = observed.identity;
      if (identity === null) {
        throw new Error('Code identity disappeared before prepare');
      }
      const provider = new CodeGraphProvider();
      const prepared = await provider.prepare(identity, plan, input.signal);
      if (!prepared.ok) {
        return {
          schema: 'pappra/code-prepare-result/1',
          ok: false,
          status: 'failed',
          plan,
          health: fallbackHealth('failed', prepared.code),
          registrationPath: null,
          diagnostics: [
            ...observed.diagnostics,
            outcomeDiagnostic(prepared, identity.root),
          ],
        };
      }
      const afterVersion = await codeGraphVersion(input.signal);
      const afterConfig = await observeCodeGraphConfig(identity.root);
      if (
        !afterVersion.ok ||
        !afterConfig.ok ||
        afterConfig.value.status === 'unknown' ||
        afterVersion.value !== identity.engine.version ||
        afterConfig.value.digest !== identity.engine.configDigest
      ) {
        const reasons = [
          ...prepared.value.reasons,
          ...(afterConfig.ok && afterConfig.value.status === 'unknown'
            ? ['engine_config_unknown']
            : []),
          'engine_identity_changed_after_prepare',
        ].slice(0, 32);
        return {
          schema: 'pappra/code-prepare-result/1',
          ok: false,
          status: 'partial',
          plan,
          health: { ...prepared.value, state: 'partial', reasons },
          registrationPath: null,
          diagnostics: [...observed.diagnostics],
        };
      }
      const afterIdentity = await computeCodeIdentity({
        repositoryId: identity.repositoryId,
        root: identity.root,
        engineVersion: afterVersion.value,
        configDigest: afterConfig.value.digest,
        configStatus: afterConfig.value.status,
        excludedRoots: observed.excludedRoots,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        observations: createGitObservationScope({ workingTreeState: false }),
      });
      if (!afterIdentity.ok) {
        return {
          schema: 'pappra/code-prepare-result/1',
          ok: false,
          status: 'partial',
          plan,
          health: fallbackHealth('partial', afterIdentity.code),
          registrationPath: null,
          diagnostics: [
            ...observed.diagnostics,
            outcomeDiagnostic(afterIdentity, identity.root),
          ],
        };
      }
      if (
        codeIdentityDigest(afterIdentity.value) !== codeIdentityDigest(identity)
      ) {
        return {
          schema: 'pappra/code-prepare-result/1',
          ok: false,
          status: 'partial',
          plan,
          health: {
            ...prepared.value,
            state: 'partial',
            reasons: [
              ...prepared.value.reasons,
              'source_changed_during_prepare',
            ].slice(0, 32),
          },
          registrationPath: null,
          diagnostics: [
            ...observed.diagnostics,
            createDiagnostic({
              code: diagnosticCodes.code_identity_changed,
              severity: 'warning',
              message:
                'Source identity changed while preparing the index; ready registration was not published.',
              source: identity.root,
              pointer: null,
              hint: 'Repeat prepare after the working tree is stable.',
            }),
          ],
        };
      }
      if (prepared.value.state !== 'ready') {
        return {
          schema: 'pappra/code-prepare-result/1',
          ok: false,
          status: prepared.value.state === 'failed' ? 'failed' : 'partial',
          plan,
          health: prepared.value,
          registrationPath: null,
          diagnostics: [...observed.diagnostics],
        };
      }
      const registration: CodeIndexRegistration = {
        schema: 'pappra/code-index-registration/1',
        repositoryId: afterIdentity.value.repositoryId,
        identityDigest: codeIdentityDigest(afterIdentity.value),
        checkoutId: afterIdentity.value.checkoutId,
        root: afterIdentity.value.root,
        engineVersion: afterIdentity.value.engine.version,
        configDigest: afterIdentity.value.engine.configDigest,
        preparedAt: new Date().toISOString(),
        coverage: prepared.value.coverage,
      };
      const written = await writeCodeRegistration(input.root, registration);
      if (!written.ok) {
        return {
          schema: 'pappra/code-prepare-result/1',
          ok: false,
          status: 'partial',
          plan,
          health: {
            ...prepared.value,
            state: 'partial',
            reasons: [
              ...prepared.value.reasons,
              'registration_write_failed',
            ].slice(0, 32),
          },
          registrationPath: null,
          diagnostics: [
            ...observed.diagnostics,
            outcomeDiagnostic(written, identity.root),
          ],
        };
      }
      return {
        schema: 'pappra/code-prepare-result/1',
        ok: true,
        status: 'ready',
        plan,
        health: prepared.value,
        registrationPath: written.value,
        diagnostics: [...observed.diagnostics],
      };
    };
    let result: CodePrepareResult;
    try {
      result = await perform();
    } catch (error) {
      await releaseCodePrepareLock(lock.value);
      throw error;
    }
    const released = await releaseCodePrepareLock(lock.value);
    if (released.ok) return result;
    return {
      ...result,
      ok: false,
      status: result.ok ? 'partial' : result.status,
      diagnostics: [
        ...result.diagnostics,
        outcomeDiagnostic(released, lock.value),
      ],
    };
  }

  async query(input: CodeQueryInput): Promise<CodeQueryOutput> {
    const limits = codeQueryLimitsSchema.parse({
      maxResults: input.limits?.maxResults ?? 20,
      maxBytes: input.limits?.maxBytes ?? 1024 * 1024,
      maxFiles: input.limits?.maxFiles ?? 1000,
    });
    const observed = await observeCode(input);
    if (observed.identity === null) {
      return {
        ok: false,
        result: null,
        health: observed.health,
        diagnostics: [...observed.diagnostics],
      };
    }
    const request: CodeQueryRequest = codeQueryRequestSchema.parse({
      schema: 'pappra/code-query/1',
      kind: input.kind,
      query: input.query,
      identity: observed.identity,
      limits,
      excludedRoots: observed.excludedRoots,
    });
    const provider = new CodeGraphProvider();
    let result: Outcome<CodeQueryResult>;
    if (input.kind === 'text') {
      result = await runTextQuery(request, 'text', input.signal);
    } else if (observed.health.state === 'ready') {
      result = await provider.query(request, input.signal);
    } else if (input.kind === 'symbol') {
      result = await runTextQuery(request, 'structure', input.signal);
    } else {
      result = succeeded({
        schema: 'pappra/code-query-result/1',
        provider: 'text',
        kind: input.kind,
        query: input.query,
        identityDigest: codeIdentityDigest(observed.identity),
        observedIdentity: observed.identity,
        coverage: 'unsupported',
        items: [],
        bytes: 0,
        truncated: false,
        reasons: [...observed.health.reasons, 'index_not_ready'],
        evidence: observed.health.evidence,
        unsupportedReason:
          'The selected code index is not ready; only text or structure fallback is available.',
      });
    }
    if (!result.ok) {
      return {
        ok: false,
        result: null,
        health: observed.health,
        diagnostics: [
          ...observed.diagnostics,
          outcomeDiagnostic(result, observed.identity.root),
        ],
      };
    }
    return {
      ok: result.value.coverage !== 'unsupported',
      result: result.value,
      health: observed.health,
      diagnostics: [...observed.diagnostics],
    };
  }
}

export { codeIdentityDigest };
