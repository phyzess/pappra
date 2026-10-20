import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Diagnostic } from '../schemas/diagnostics.js';
import type { HostName } from '../schemas/host.js';
import type { InitChoices } from '../schemas/init.js';
import { HOST_SUPPORT } from '../hosts/integration/support.js';
import { exportHostPluginBundle } from '../hosts/integration/bundle-export.js';
import { HostIntegrationService } from '../hosts/integration/service.js';
import { getPackageInfo } from '../package-info.js';
import { resolveWorkspaceRoot } from '../workspace/resolve.js';
import {
  applyInitPlan,
  deriveInitChoices,
  detectedHostVersion,
  ensureDefaultRuntime,
  inspectInitContext,
  planWorkspaceInit,
  type InitContext,
  type InitPlanBundle,
} from './init.js';

export type OnboardHostState =
  'verified' | 'unverified' | 'unsupported' | 'missing';

export interface OnboardHostPlan {
  readonly host: HostName;
  readonly command: string;
  readonly detectedVersion: string | null;
  readonly pinnedVersion: string;
  readonly state: OnboardHostState;
}

export interface OnboardHostResult extends OnboardHostPlan {
  readonly action: 'planned' | 'installed' | 'unchanged' | 'skipped' | 'failed';
  readonly appliedFiles: readonly string[];
  readonly nextActions: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface OnboardPlan {
  readonly context: InitContext;
  readonly choices: InitChoices;
  readonly bundle: InitPlanBundle;
  readonly hosts: readonly OnboardHostPlan[];
  readonly requestedHosts: readonly HostName[];
}

export interface OnboardResult {
  readonly schema: 'pappra/onboard/1';
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly workspaceRoot: string;
  readonly files: readonly {
    readonly path: string;
    readonly operation: string;
  }[];
  readonly runtime: {
    readonly version: string;
    readonly status: string;
  } | null;
  readonly initComplete: boolean;
  readonly hosts: readonly OnboardHostResult[];
  readonly manualSteps: readonly string[];
  readonly nextActions: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface OnboardFailure {
  readonly ok: false;
  readonly reason: 'invalid' | 'needs_input' | 'unavailable' | 'failed';
  readonly message: string;
  readonly diagnostics: readonly Diagnostic[];
}

const HOSTS: readonly HostName[] = ['claude', 'codex', 'pi'];
const HOST_COMMAND: Record<HostName, string> = {
  claude: 'claude',
  codex: 'codex',
  pi: 'pi',
};

function sameMinor(left: string, right: string): boolean {
  const [leftMajor, leftMinor] = left.split('.');
  const [rightMajor, rightMinor] = right.split('.');
  return leftMajor === rightMajor && leftMinor === rightMinor;
}

function hostState(detected: string | null, pinned: string): OnboardHostState {
  if (detected === null) return 'missing';
  if (detected === pinned) return 'verified';
  return sameMinor(detected, pinned) ? 'unverified' : 'unsupported';
}

function detectHosts(
  pathEnv: string,
  requested: readonly HostName[] | null,
): OnboardHostPlan[] {
  return HOSTS.filter(
    (host) => requested === null || requested.includes(host),
  ).map((host) => {
    const pinnedVersion = HOST_SUPPORT[host].version;
    const detectedVersion = detectedHostVersion(HOST_COMMAND[host], pathEnv);
    return {
      host,
      command: HOST_COMMAND[host],
      detectedVersion,
      pinnedVersion,
      state: hostState(detectedVersion, pinnedVersion),
    };
  });
}

export function parseHostList(value: string | null): HostName[] | null {
  if (value === null || value.trim() === '') return null;
  const parsed: HostName[] = [];
  for (const entry of value.split(',')) {
    const name = entry.trim();
    if (name === 'claude' || name === 'codex' || name === 'pi') {
      if (!parsed.includes(name)) parsed.push(name);
      continue;
    }
    throw new Error(`Unknown host: ${name}`);
  }
  return parsed;
}

export async function planOnboard(options: {
  readonly root: string;
  readonly choices?: InitChoices | null;
  readonly hosts?: readonly HostName[] | null;
  readonly pathEnv?: string;
}): Promise<OnboardPlan | OnboardFailure> {
  const requestedRoot = resolve(options.root);
  const resolution = await resolveWorkspaceRoot({ startPath: requestedRoot });
  if (resolution.state === 'unavailable' || resolution.state === 'incomplete') {
    return {
      ok: false,
      reason: 'unavailable',
      message: `Cannot initialize from ${requestedRoot}.`,
      diagnostics: resolution.diagnostics,
    };
  }
  const root = resolution.root ?? requestedRoot;
  const contextResult = await inspectInitContext(root);
  if (!contextResult.ok) {
    return {
      ok: false,
      reason: contextResult.status === 'invalid' ? 'invalid' : 'failed',
      message: contextResult.message,
      diagnostics: contextResult.diagnostics,
    };
  }
  const context = contextResult.context;
  const pathEnv = options.pathEnv ?? process.env['PATH'] ?? '';
  const requestedHosts = options.hosts ?? null;
  const derived =
    options.choices ??
    (await deriveInitChoices(context.discovery, { pathEnv })).choices;
  const choices: InitChoices =
    requestedHosts === null
      ? derived
      : { ...derived, hosts: [...requestedHosts] };
  const prepared = await planWorkspaceInit({
    root: context.root,
    choices,
    context,
  });
  if (!prepared.ok) {
    return {
      ok: false,
      reason: prepared.status === 'invalid' ? 'invalid' : 'failed',
      message: prepared.message,
      diagnostics: prepared.diagnostics,
    };
  }
  return {
    context,
    choices,
    bundle: prepared.bundle,
    hosts: detectHosts(pathEnv, requestedHosts),
    requestedHosts: choices.hosts,
  };
}

function hostTarget(host: HostName, root: string): string | null {
  if (host === 'claude') return join(root, '.claude');
  if (host === 'codex') {
    const configured = process.env['CODEX_HOME'];
    return configured === undefined || configured === ''
      ? join(homedir(), '.codex')
      : resolve(configured);
  }
  return null;
}

async function wireHost(
  plan: OnboardHostPlan,
  root: string,
  packageVersion: string,
): Promise<OnboardHostResult> {
  if (plan.state !== 'verified') {
    const detail =
      plan.state === 'missing'
        ? `Host ${plan.command} is not installed.`
        : `Host ${plan.command} ${plan.detectedVersion ?? '(unknown)'} does not match the pinned ${plan.pinnedVersion}.`;
    return {
      ...plan,
      action: 'skipped',
      appliedFiles: [],
      nextActions: [
        `${detail} Install the pinned version, or use pappra host install --mode project-settings explicitly.`,
      ],
      diagnostics: [],
    };
  }
  if (plan.host === 'pi') {
    const outDir = join(root, '.pappra', 'host-bundles', 'pi');
    try {
      const exported = await exportHostPluginBundle({
        host: 'pi',
        hostVersion: plan.pinnedVersion,
        outDir,
        packageVersion,
      });
      return {
        ...plan,
        action: 'installed',
        appliedFiles: exported.files.map((file) => `host-bundles/pi/${file}`),
        nextActions: [
          `Run: pi install ${outDir} -l -a`,
          'Approve the project package trust prompt once in Pi.',
        ],
        diagnostics: [],
      };
    } catch (error) {
      return {
        ...plan,
        action: 'failed',
        appliedFiles: [],
        nextActions: [error instanceof Error ? error.message : String(error)],
        diagnostics: [],
      };
    }
  }
  const target = hostTarget(plan.host, root);
  if (target === null) {
    return {
      ...plan,
      action: 'skipped',
      appliedFiles: [],
      nextActions: [`No install root is defined for ${plan.host}.`],
      diagnostics: [],
    };
  }
  await mkdir(target, { recursive: true });
  const service = new HostIntegrationService({
    root,
    homeDir: homedir(),
    pathEnv: process.env['PATH'] ?? '',
    hostVersion: plan.pinnedVersion,
    observedAt: new Date().toISOString(),
  });
  const installed = await service.install(plan.host, {
    hostRoot: target,
    hostVersion: plan.pinnedVersion,
    apply: true,
  });
  const trust =
    plan.host === 'codex'
      ? 'Approve the Pappra hook once in Codex; project `.codex/hooks.json` is not loaded by 0.163.0.'
      : 'Reload the session and trust the Pappra hook if Claude Code prompts.';
  return {
    ...plan,
    action:
      installed.status === 'applied'
        ? 'installed'
        : installed.status === 'unchanged'
          ? 'unchanged'
          : 'failed',
    appliedFiles: installed.appliedFiles,
    nextActions: [trust],
    diagnostics: installed.diagnostics as readonly Diagnostic[],
  };
}

export async function applyOnboard(
  plan: OnboardPlan,
  options: { readonly applyHosts: boolean },
): Promise<OnboardResult> {
  const applied = await applyInitPlan(plan.bundle);
  const diagnostics: Diagnostic[] = [
    ...plan.bundle.diagnostics,
    ...applied.diagnostics,
  ].filter((entry) => entry.severity !== 'info');
  const runtime = applied.ok
    ? await ensureDefaultRuntime(
        plan.bundle.scope.workspaceRoot,
        plan.bundle.scope.runtimeVersion,
      )
    : null;
  if (runtime !== null) {
    diagnostics.push(
      ...runtime.diagnostics.filter((entry) => entry.severity !== 'info'),
    );
  }
  const initComplete =
    applied.ok &&
    applied.residualPaths.length === 0 &&
    runtime?.completion === true;
  const packageVersion = getPackageInfo().version;
  const hosts: OnboardHostResult[] = [];
  const manualSteps: string[] = [];
  for (const host of plan.hosts) {
    const result = options.applyHosts
      ? await wireHost(host, plan.bundle.scope.workspaceRoot, packageVersion)
      : {
          ...host,
          action: 'planned' as const,
          appliedFiles: [],
          nextActions: [
            'Rerun with --apply-host to write this host integration.',
          ],
          diagnostics: [],
        };
    hosts.push(result);
    manualSteps.push(...result.nextActions);
  }
  const nextActions: string[] = [];
  if (plan.choices.knowledge.sources.length > 0) {
    nextActions.push('pappra docs scan --apply');
  }
  if (
    plan.choices.code.graph !== 'none' &&
    plan.choices.repositories.length > 0
  ) {
    nextActions.push(
      `pappra code prepare --repo ${plan.choices.repositories[0]?.path ?? '<repo>'} --apply`,
    );
  }
  return {
    schema: 'pappra/onboard/1',
    ok: initComplete && hosts.every((host) => host.action !== 'failed'),
    dryRun: false,
    workspaceRoot: plan.bundle.scope.workspaceRoot,
    files: applied.appliedFiles.map((path) => ({ path, operation: 'write' })),
    runtime:
      runtime?.runtime === null || runtime === null
        ? null
        : {
            version: runtime.runtime.version,
            status: runtime.runtime.status,
          },
    initComplete,
    hosts,
    manualSteps: [...new Set(manualSteps)],
    nextActions,
    diagnostics,
  };
}
