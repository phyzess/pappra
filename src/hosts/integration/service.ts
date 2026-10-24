import { randomUUID } from 'node:crypto';
import { link, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from '../../schemas/diagnostics.js';
import { createDiagnostic } from '../../schemas/diagnostics.js';
import { diagnosticCodes } from '../../schemas/errors.js';
import type {
  HostBundle,
  HostCapabilities,
  HostCapability,
  HostInstallManifest,
  HostIntegrationPlan,
  HostIntegrationResult,
  HostLifecycleEvent,
  HostName,
  HostPlanFile,
  HostVerification,
  HostVerificationCheck,
  HostUninstallResult,
} from '../../schemas/host.js';
import {
  hostCapabilitiesSchema,
  hostInstallManifestSchema,
  hostIntegrationPlanSchema,
  hostIntegrationResultSchema,
  hostNameSchema,
  hostVerificationSchema,
  hostUninstallResultSchema,
} from '../../schemas/host.js';
import type { EvidenceRef } from '../../schemas/evidence.js';
import { observePath, readFileBounded, sha256Digest } from '../../infra/fs.js';
import { ensurePrivateState } from '../../infra/private-state.js';
import { updateJsonProperty } from '../../infra/json-property.js';
import { captureProcessIdentity } from '../../infra/process-identity.js';
import {
  inspectPrivateLock,
  publishPrivateLock,
  reclaimDeadPrivateLock,
} from '../../infra/private-lock.js';
import { isPathInside } from '../../schemas/paths.js';
import {
  ensureStatePathBoundary,
  removeOwnedFile,
} from '../../install/ownership.js';
import { getPackageInfo } from '../../package-info.js';
import { detectPassiveHosts } from '../detect.js';
import { observeHostVersion } from '../version.js';
import { installPathForBundleFile, loadHostBundle } from './bundle.js';
import {
  hostConfigRelativePath,
  isManagedHookCommand,
  MIN_HOOK_TIMEOUT_SECONDS,
  renderHookConfigPatch,
} from './templates.js';

import {
  HOST_PLUGIN_HOOKS,
  HOST_SUPPORT,
  isSupportedVersion,
  nativeEventFor,
  surfaceFor,
} from './support.js';

const LIFECYCLE_EVENTS: readonly HostLifecycleEvent[] = [
  'startup',
  'resume',
  'compact',
  'checkpoint-request',
];

const BUNDLE_FILE = 'pappra-host.json';
const DEFAULT_MAX_CONFIG_BYTES = 1024 * 1024;

export interface HostIntegrationOptions {
  readonly versionProbe?: (host: HostName) => string | null;
  readonly root: string;
  readonly homeDir: string;
  readonly pathEnv: string;
  readonly runtimeEntry?: string;
  readonly hostVersion?: string | null;
  readonly selectedHosts?: readonly HostName[];
  readonly observedAt?: string;
}

export interface HostTargetOptions {
  readonly hostRoot?: string;
  readonly runtimeEntry?: string;
  readonly hostVersion?: string | null;
  /** Rewrites a manifest previously pinned to a package checkout path. */
  readonly migrate?: boolean;
  /**
   * Plugin wiring is exported with `host bundle` but not installed here: host
   * registration, trust and callability are unverified, so this mode fails
   * closed instead of writing a bundle a host may never load.
   */
  readonly mode?: 'project-settings' | 'plugin';
}

export interface HostPlanBundle {
  readonly plan: HostIntegrationPlan;
  readonly contents: ReadonlyMap<string, Buffer>;
}

function now(): string {
  return new Date().toISOString();
}

function packageRuntimeEntry(): string {
  const packageJson = fileURLToPath(
    import.meta.resolve('@phyzess/pappra/package.json'),
  );
  return join(
    dirname(packageJson),
    'dist',
    'hosts',
    'integration',
    'pappra-hook.mjs',
  );
}

interface HookTarget {
  /** Absolute path of the hook file copied into the host root. */
  readonly installedPath: string;
  /** Path expression written into the host hook configuration. */
  readonly expression: string;
  /** Packaged hook file this target is copied from. */
  readonly source: string;
}

/**
 * Uses the host's project placeholder when the hook copy lives inside the
 * workspace, so a moved checkout or an evicted npx cache cannot break the hook.
 */
function hookTarget(
  host: HostName,
  workspaceRoot: string,
  hostRoot: string,
  hookSource: string,
): HookTarget {
  const installedPath = join(hostRoot, 'hooks', 'pappra-hook.mjs');
  const relativePath = relative(workspaceRoot, installedPath);
  const insideWorkspace =
    !relativePath.startsWith('..') && !isAbsolute(relativePath);
  const expression =
    host === 'claude' && insideWorkspace
      ? `\${CLAUDE_PROJECT_DIR}/${relativePath.split(sep).join('/')}`
      : installedPath;
  return { installedPath, expression, source: hookSource };
}

function diagnostic(
  code: (typeof diagnosticCodes)[keyof typeof diagnosticCodes],
  message: string,
  source: string,
  hint: string,
): Diagnostic {
  return createDiagnostic({
    code,
    severity: 'error',
    message,
    source,
    hint,
  });
}

function evidence(path: string, observedAt: string): EvidenceRef {
  return {
    kind: 'file',
    ref: path,
    digest: null,
    observedAt,
    scope: 'live-owned',
  };
}

async function runtimeEntryReady(path: string): Promise<boolean> {
  const observed = await observePath(path);
  return observed.kind === 'file' && observed.stats !== null;
}

function eventCapability(
  host: HostName,
  event: HostLifecycleEvent,
  options: {
    readonly version: string | null;
    readonly executablePath: string | null;
    readonly configPath: string | null;
    readonly installed: boolean;
    readonly wiringVerified: boolean;
    readonly observedAt: string;
  },
): HostCapability {
  const nativeEvent = nativeEventFor(host, event);
  const baseEvidence: EvidenceRef[] = [];
  if (options.executablePath !== null)
    baseEvidence.push(evidence(options.executablePath, options.observedAt));
  if (options.configPath !== null)
    baseEvidence.push(evidence(options.configPath, options.observedAt));
  if (nativeEvent === null) {
    return {
      event,
      nativeEvent: null,
      state: 'unsupported',
      reason:
        event === 'compact'
          ? 'The Pappra adapter does not implement a compact mapping for this surface.'
          : 'Automatic checkpoint requests are not an implemented native event; use the manual P07 command.',
      evidence: baseEvidence,
    };
  }
  if (options.version === null) {
    return {
      event,
      nativeEvent,
      state: 'unknown',
      reason:
        'Host version was not observed; native event mapping is not treated as verified.',
      evidence: baseEvidence,
    };
  }
  if (!isSupportedVersion(host, options.version)) {
    return {
      event,
      nativeEvent,
      state: 'unsupported',
      reason: `Observed host version ${options.version} is outside the pinned ${HOST_SUPPORT[host].version} support matrix.`,
      evidence: baseEvidence,
    };
  }
  if (!options.installed && options.configPath === null) {
    return {
      event,
      nativeEvent,
      state: 'unknown',
      reason:
        'No host executable or configuration was observed; a supplied version string is not wiring evidence.',
      evidence: baseEvidence,
    };
  }
  if (options.wiringVerified) {
    return {
      event,
      nativeEvent,
      state: 'configured',
      reason:
        'Exact Pappra-managed wiring is present; native trust, reload and callability remain unverified.',
      evidence: baseEvidence,
    };
  }
  return {
    event,
    nativeEvent,
    state: 'installed',
    reason:
      'Host presence/version is observed, but exact Pappra wiring is not verified for this target.',
    evidence: baseEvidence,
  };
}

function hostCapabilities(
  host: HostName,
  options: {
    readonly version: string | null;
    readonly executablePath: string | null;
    readonly configPath: string | null;
    readonly installed: boolean;
    readonly wiringVerified: boolean;
    readonly observedAt: string;
  },
): HostCapabilities {
  return hostCapabilitiesSchema.parse({
    schema: 'pappra/host-capabilities/1',
    host,
    surface: surfaceFor(host),
    version: options.version,
    observedAt: options.observedAt,
    executablePath: options.executablePath,
    configPath: options.configPath,
    capabilities: LIFECYCLE_EVENTS.map((event) =>
      eventCapability(host, event, options),
    ),
    reloadRequired: true,
    trustRequired: true,
    automaticHandoff: 'unsupported',
    limits: [
      'Installing files and observing a version does not establish host trust, reload, callability or event delivery.',
      'Hooks do not read transcripts, call models, fetch, index, run arbitrary commands or start a writer.',
      'Manual checkpoint/resume remains available without hooks; automatic continuation is unsupported.',
    ],
  });
}

function configPathFor(host: HostName, hostRoot: string): string | null {
  const relative = hostConfigRelativePath(host);
  return relative === null ? null : join(hostRoot, relative);
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').includes('..')
  );
}

async function fileDigest(path: string): Promise<string | null> {
  const read = await readFileBounded(path, DEFAULT_MAX_CONFIG_BYTES);
  return read.ok ? read.value.digest : null;
}

function parseJsonObject(
  bytes: Buffer,
  path: string,
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly diagnostic: Diagnostic;
    } {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return {
      ok: false,
      diagnostic: diagnostic(
        diagnosticCodes.host_config_invalid,
        `Host configuration is not valid JSON: ${path}`,
        path,
        'Fix or remove the host configuration explicitly; no managed entry was written.',
      ),
    };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        diagnosticCodes.host_config_invalid,
        `Host configuration must be a JSON object: ${path}`,
        path,
        'Fix the host configuration explicitly; no managed entry was written.',
      ),
    };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

function managedHookCommands(
  entries: readonly { readonly hooks?: readonly unknown[] }[],
): ReadonlySet<string> {
  const commands = new Set<string>();
  for (const entry of entries) {
    for (const hook of entry.hooks ?? []) {
      if (
        typeof hook === 'object' &&
        hook !== null &&
        'type' in hook &&
        hook.type === 'command' &&
        'command' in hook &&
        typeof hook.command === 'string'
      ) {
        commands.add(hook.command);
      }
    }
  }
  return commands;
}
function managedGroupHasUserEdits(
  group: Record<string, unknown>,
  commands: ReadonlySet<string>,
): boolean {
  const hookValues = group.hooks;
  if (!Array.isArray(hookValues)) return false;
  const hasManaged = hookValues.some((hook) => isManagedHook(hook, commands));
  if (!hasManaged) return false;
  const extraGroupKeys = Object.keys(group).filter((key) => key !== 'hooks');
  if (extraGroupKeys.length > 0) return true;
  return hookValues.some((hook) => {
    if (!isManagedHook(hook, commands)) return false;
    const keys = Object.keys(hook);
    const validTimeout =
      typeof hook.timeout === 'number' &&
      Number.isSafeInteger(hook.timeout) &&
      hook.timeout >= MIN_HOOK_TIMEOUT_SECONDS;
    const legacyDefault =
      hook.timeout === 1 &&
      typeof hook.command === 'string' &&
      !commands.has(hook.command);
    return (
      keys.some(
        (key) => key !== 'type' && key !== 'command' && key !== 'timeout',
      ) ||
      (!validTimeout && !legacyDefault)
    );
  });
}

function isManagedHook(value: unknown, commands: ReadonlySet<string>): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'type' in value &&
    value.type === 'command' &&
    'command' in value &&
    typeof value.command === 'string' &&
    isManagedHookCommand(value.command, commands)
  );
}

function managedConfig(
  host: 'codex' | 'claude',
  existing: Buffer | null,
  hookExpression: string,
  path: string,
):
  | { readonly ok: true; readonly bytes: Buffer }
  | {
      readonly ok: false;
      readonly diagnostic: Diagnostic;
    } {
  let base: Record<string, unknown> = {};
  if (existing !== null) {
    const parsed = parseJsonObject(existing, path);
    if (!parsed.ok) return parsed;
    base = parsed.value;
  }
  const patch = renderHookConfigPatch(host, hookExpression);
  const rawHooks = base['hooks'];
  if (
    rawHooks !== undefined &&
    (typeof rawHooks !== 'object' ||
      rawHooks === null ||
      Array.isArray(rawHooks))
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        diagnosticCodes.host_config_invalid,
        `Host hooks must be an object: ${path}`,
        path,
        'Fix the host hooks shape explicitly; no managed entry was written.',
      ),
    };
  }
  const currentHooks =
    rawHooks === undefined ? {} : (rawHooks as Record<string, unknown>);
  const nextHooks: Record<string, unknown> = { ...currentHooks };
  for (const [event, entries] of Object.entries(patch.hooks)) {
    const current = nextHooks[event];
    if (current !== undefined && !Array.isArray(current)) {
      return {
        ok: false,
        diagnostic: diagnostic(
          diagnosticCodes.host_config_invalid,
          `Host hook event ${event} must be an array: ${path}`,
          path,
          'Fix the host hook event explicitly; no managed entry was written.',
        ),
      };
    }
    const groups = current === undefined ? [] : (current as unknown[]);
    const commands = managedHookCommands(entries);
    const preserved: unknown[] = [];
    let managedTimeout = MIN_HOOK_TIMEOUT_SECONDS;
    for (const group of groups) {
      if (
        typeof group !== 'object' ||
        group === null ||
        Array.isArray(group) ||
        !('hooks' in group) ||
        !Array.isArray(group.hooks)
      ) {
        preserved.push(group);
        continue;
      }
      if (managedGroupHasUserEdits(group, commands)) {
        return {
          ok: false,
          diagnostic: diagnostic(
            diagnosticCodes.host_install_conflict,
            `Managed host hook entry was edited by the user: ${path}`,
            path,
            `Review the matcher and handler fields, and use an integer timeout of at least ${MIN_HOOK_TIMEOUT_SECONDS} seconds. Pappra preserves invalid or unsupported edits.`,
          ),
        };
      }
      if (!group.hooks.some((hook) => isManagedHook(hook, commands))) {
        preserved.push(group);
        continue;
      }
      for (const hook of group.hooks) {
        if (
          isManagedHook(hook, commands) &&
          typeof hook === 'object' &&
          hook !== null &&
          'timeout' in hook &&
          typeof hook.timeout === 'number'
        ) {
          managedTimeout = Math.max(managedTimeout, hook.timeout);
        }
      }
      const remaining = group.hooks.filter(
        (hook) => !isManagedHook(hook, commands),
      );
      if (remaining.length > 0) {
        preserved.push({ ...group, hooks: remaining });
      }
    }
    nextHooks[event] = [
      ...preserved,
      ...entries.map((entry) => ({
        ...entry,
        hooks: entry.hooks.map((hook) => ({
          ...hook,
          timeout: managedTimeout,
        })),
      })),
    ];
  }
  const next = { ...base, hooks: nextHooks };
  return {
    ok: true,
    bytes: updateJsonProperty(existing, 'hooks', next['hooks']),
  };
}

function removeManagedConfig(
  host: 'claude' | 'codex',
  existing: Buffer,
  expression: string,
  file: string,
): { ok: true; bytes: Buffer } | { ok: false; diagnostic: Diagnostic } {
  const parsed = parseJsonObject(existing, file);
  if (!parsed.ok) return parsed;
  const hooks = parsed.value['hooks'];
  if (hooks === undefined) return { ok: true, bytes: existing };
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks))
    return {
      ok: false,
      diagnostic: diagnostic(
        diagnosticCodes.host_config_invalid,
        'Host hooks must be an object.',
        file,
        'Inspect the configuration; no hook was removed.',
      ),
    };
  const next = { ...hooks } as Record<string, unknown>;
  for (const [event, entries] of Object.entries(
    renderHookConfigPatch(host, expression).hooks,
  )) {
    const groups = next[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups))
      return {
        ok: false,
        diagnostic: diagnostic(
          diagnosticCodes.host_config_invalid,
          'Host event hooks must be an array.',
          file,
          'Inspect the configuration; no hook was removed.',
        ),
      };
    const commands = managedHookCommands(entries);
    const kept: unknown[] = [];
    for (const value of groups) {
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        !('hooks' in value) ||
        !Array.isArray(value.hooks)
      ) {
        kept.push(value);
        continue;
      }
      if (managedGroupHasUserEdits(value, commands))
        return {
          ok: false,
          diagnostic: diagnostic(
            diagnosticCodes.host_install_conflict,
            'An edited managed hook was preserved.',
            file,
            'Review the edited hook explicitly before uninstalling its assets.',
          ),
        };
      const remaining = value.hooks.filter(
        (hook: unknown) => !isManagedHook(hook, commands),
      );
      if (remaining.length === value.hooks.length) kept.push(value);
      else if (remaining.length > 0) kept.push({ ...value, hooks: remaining });
    }
    if (kept.length > 0) next[event] = kept;
    else delete next[event];
  }
  return {
    ok: true,
    bytes:
      JSON.stringify(next) === JSON.stringify(hooks)
        ? existing
        : updateJsonProperty(existing, 'hooks', next),
  };
}

function validateManifestIdentity(
  manifest: HostInstallManifest,
  host: HostName,
  hostRoot: string,
  configPath: string | null,
  hookExpression: string,
  migrate: boolean,
): Diagnostic | null {
  const portable =
    host === 'pi' ||
    (manifest.runtimeEntry === hookExpression &&
      hookExpression.startsWith('${CLAUDE_PROJECT_DIR}/'));
  if (
    manifest.host !== host ||
    (!portable && resolve(manifest.hostRoot) !== hostRoot) ||
    manifest.configPath !== configPath ||
    (!migrate && host !== 'pi' && manifest.runtimeEntry !== hookExpression)
  ) {
    return diagnostic(
      diagnosticCodes.host_install_conflict,
      `Host manifest identity does not match the selected target: ${hostRoot}`,
      join(hostRoot, BUNDLE_FILE),
      'Inspect the manifest and target; Pappra does not adopt a foreign installation.',
    );
  }
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!safeRelativePath(file.path) || seen.has(file.path)) {
      return diagnostic(
        diagnosticCodes.host_install_conflict,
        `Host manifest contains an invalid or duplicate file path: ${file.path}`,
        join(hostRoot, BUNDLE_FILE),
        'Inspect the manifest; no path is read or overwritten.',
      );
    }
    seen.add(file.path);
  }
  if (manifest.files.some((file) => file.path === BUNDLE_FILE)) {
    return diagnostic(
      diagnosticCodes.host_install_conflict,
      'Host manifest must not claim itself as an installed file.',
      join(hostRoot, BUNDLE_FILE),
      'Inspect the manifest; no path is read or overwritten.',
    );
  }
  return null;
}

function configHasExpectedHooks(
  host: 'codex' | 'claude',
  bytes: Buffer,
  hookExpression: string,
  path: string,
): boolean {
  const parsed = parseJsonObject(bytes, path);
  if (!parsed.ok) return false;
  const patch = renderHookConfigPatch(host, hookExpression);
  const hooks = parsed.value['hooks'];
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    return false;
  }
  for (const [event, entries] of Object.entries(patch.hooks)) {
    const groups = (hooks as Record<string, unknown>)[event];
    if (!Array.isArray(groups)) return false;
    const commands = managedHookCommands(entries);
    const found = new Set<string>();
    for (const group of groups) {
      if (
        typeof group !== 'object' ||
        group === null ||
        Array.isArray(group) ||
        !('hooks' in group) ||
        !Array.isArray(group.hooks)
      ) {
        continue;
      }
      if (managedGroupHasUserEdits(group, commands)) return false;
      for (const hook of group.hooks) {
        if (!isManagedHook(hook, commands)) continue;
        if (
          typeof hook === 'object' &&
          hook !== null &&
          'command' in hook &&
          typeof hook.command === 'string'
        ) {
          // A stale runner or duplicate entry requires reinstalling, while
          // unrelated user configuration has no bearing on managed wiring.
          if (!commands.has(hook.command) || found.has(hook.command)) {
            return false;
          }
          found.add(hook.command);
        }
      }
    }
    if ([...commands].some((command) => !found.has(command))) return false;
  }
  return true;
}

function bundleManifestContent(
  bundle: HostBundle,
  hostRoot: string,
  hookExpression: string,
  configPath: string | null,
  files: readonly HostPlanFile[],
  observedAt: string,
): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        schema: 'pappra/host-install/1',
        host: bundle.host,
        packageVersion: bundle.packageVersion,
        bundleDigest: bundle.bundleDigest,
        installedAt: observedAt,
        hostRoot,
        runtimeEntry: hookExpression,
        configPath,
        files: files.map((file) => ({
          path: file.path,
          digest: file.nextDigest,
          kind:
            file.kind === 'hook-entry'
              ? 'hook'
              : file.kind === 'manifest'
                ? 'config'
                : file.kind,
        })),
        reloadRequired: true,
        trustRequired: true,
      },
      null,
      2,
    )}\n`,
  );
}

async function hostPlanFiles(
  host: HostName,
  workspaceRoot: string,
  hostRoot: string,
  hookSource: string,
  observedAt: string,
  migrate = false,
): Promise<
  | {
      readonly ok: true;
      readonly bundle: HostBundle;
      readonly contents: Map<string, Buffer>;
      readonly files: HostPlanFile[];
      readonly configPath: string | null;
    }
  | {
      readonly ok: false;
      readonly diagnostic: Diagnostic;
      readonly conflict?: boolean;
    }
> {
  const target = hookTarget(host, workspaceRoot, hostRoot, hookSource);
  let payload;
  try {
    payload = await loadHostBundle(host, getPackageInfo().version, {
      hookSource,
      hookExpression: target.expression,
      observedAt,
    });
  } catch (error) {
    return {
      ok: false,
      diagnostic: diagnostic(
        diagnosticCodes.host_bundle_invalid,
        `Cannot load packaged host bundle: ${error instanceof Error ? error.message : String(error)}`,
        hostRoot,
        'Reinstall or rebuild Pappra; no host files were written.',
      ),
    };
  }
  const manifestPath = join(hostRoot, BUNDLE_FILE);
  const manifestBoundary = await assertSafeTarget(hostRoot, manifestPath);
  if (manifestBoundary !== null) {
    return { ok: false, diagnostic: manifestBoundary, conflict: true };
  }
  const existingManifestRead = await readFileBounded(manifestPath, 256 * 1024);
  let installedManifest: HostInstallManifest | null = null;
  if (
    !existingManifestRead.ok &&
    existingManifestRead.code !== diagnosticCodes.fileNotFound
  ) {
    return {
      ok: false,
      conflict: true,
      diagnostic: diagnostic(
        existingManifestRead.code,
        existingManifestRead.message,
        manifestPath,
        existingManifestRead.nextAction ?? 'Inspect the host manifest.',
      ),
    };
  }
  if (existingManifestRead.ok) {
    let value: unknown;
    try {
      value = JSON.parse(existingManifestRead.value.bytes.toString('utf8'));
    } catch {
      return {
        ok: false,
        conflict: true,
        diagnostic: diagnostic(
          diagnosticCodes.host_install_conflict,
          `Host manifest is not valid JSON and was preserved: ${manifestPath}`,
          manifestPath,
          'Fix or remove the manifest explicitly; no managed file was overwritten.',
        ),
      };
    }
    const parsed = hostInstallManifestSchema.safeParse(value);
    if (!parsed.success) {
      return {
        ok: false,
        conflict: true,
        diagnostic: diagnostic(
          diagnosticCodes.host_install_conflict,
          `Host manifest is invalid and was preserved: ${manifestPath}`,
          manifestPath,
          'Fix or remove the manifest explicitly; no managed file was overwritten.',
        ),
      };
    }
    const identityError = validateManifestIdentity(
      parsed.data,
      host,
      hostRoot,
      hostConfigRelativePath(host),
      target.expression,
      migrate,
    );
    if (identityError !== null) {
      return { ok: false, conflict: true, diagnostic: identityError };
    }
    installedManifest = parsed.data;
  }
  const installedDigests = new Map(
    (installedManifest?.files ?? []).map((entry) => [entry.path, entry.digest]),
  );
  const contents = new Map<string, Buffer>();
  const files: HostPlanFile[] = [];
  for (const [sourcePath, bytes] of payload.contents) {
    const path = installPathForBundleFile(host, sourcePath);
    if (!safeRelativePath(path)) {
      return {
        ok: false,
        diagnostic: diagnostic(
          diagnosticCodes.host_install_unsafe,
          `Unsafe bundle path: ${path}`,
          hostRoot,
          'Rebuild the package; no host files were written.',
        ),
      };
    }
    const target = join(hostRoot, ...path.split('/'));
    const targetBoundary = await assertSafeTarget(hostRoot, target);
    if (targetBoundary !== null) {
      return { ok: false, diagnostic: targetBoundary, conflict: true };
    }
    const existingTarget = await readFileBounded(target, 8 * 1024 * 1024);
    if (
      !existingTarget.ok &&
      existingTarget.code !== diagnosticCodes.fileNotFound
    ) {
      return {
        ok: false,
        diagnostic: diagnostic(
          existingTarget.code,
          existingTarget.message,
          target,
          existingTarget.nextAction ?? 'Inspect the host target.',
        ),
      };
    }
    const beforeDigest = existingTarget.ok ? existingTarget.value.digest : null;
    const nextDigest = sha256Digest(bytes);
    const recordedDigest = installedDigests.get(path);
    const userModified =
      beforeDigest !== null &&
      beforeDigest !== nextDigest &&
      (recordedDigest === undefined || beforeDigest !== recordedDigest);
    contents.set(path, bytes);
    files.push({
      path,
      kind: path.startsWith('extensions/')
        ? 'extension'
        : path.startsWith('templates/')
          ? 'hook-entry'
          : 'skill',
      operation: userModified
        ? 'conflict'
        : beforeDigest === null
          ? 'create'
          : beforeDigest === nextDigest
            ? 'unchanged'
            : 'replace-managed',
      beforeDigest,
      nextDigest,
    });
  }
  const configPath = configPathFor(host, hostRoot);
  if (configPath !== null) {
    const relative = hostConfigRelativePath(host);
    if (relative === null) {
      return {
        ok: false,
        diagnostic: diagnostic(
          diagnosticCodes.host_bundle_invalid,
          `Missing host config path for ${host}.`,
          hostRoot,
          'Inspect the host adapter; no host files were written.',
        ),
      };
    }
    const configBoundary = await assertSafeTarget(hostRoot, configPath);
    if (configBoundary !== null) {
      return { ok: false, diagnostic: configBoundary, conflict: true };
    }
    const existing = await readFileBounded(
      configPath,
      DEFAULT_MAX_CONFIG_BYTES,
    );
    if (!existing.ok && existing.code !== diagnosticCodes.fileNotFound) {
      return {
        ok: false,
        diagnostic: diagnostic(
          existing.code,
          existing.message,
          configPath,
          existing.nextAction ?? 'Inspect the host configuration.',
        ),
      };
    }
    const before = existing.ok ? existing.value.bytes : null;
    const merged = managedConfig(
      host === 'codex' ? 'codex' : 'claude',
      before,
      target.expression,
      configPath,
    );
    if (!merged.ok) {
      return {
        ...merged,
        conflict:
          merged.diagnostic.code === diagnosticCodes.host_install_conflict,
      };
    }
    contents.set(relative, merged.bytes);
    files.push({
      path: relative,
      kind: 'config',
      operation: before === null ? 'create' : 'merge-managed',
      beforeDigest: before === null ? null : sha256Digest(before),
      nextDigest: sha256Digest(merged.bytes),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  let installedAt = observedAt;
  const existingManifestDigest = existingManifestRead.ok
    ? existingManifestRead.value.digest
    : null;
  if (
    installedManifest !== null &&
    installedManifest.bundleDigest === payload.bundle.bundleDigest &&
    installedManifest.configPath === hostConfigRelativePath(host) &&
    installedManifest.files.length === files.length &&
    installedManifest.files.every((entry, index) => {
      const expected = files[index];
      return (
        expected !== undefined &&
        entry.path === expected.path &&
        entry.digest === expected.nextDigest
      );
    })
  ) {
    installedAt = installedManifest.installedAt;
  }
  const manifest = bundleManifestContent(
    payload.bundle,
    hostRoot,
    target.expression,
    hostConfigRelativePath(host),
    files,
    installedAt,
  );
  contents.set(BUNDLE_FILE, manifest);
  files.push({
    path: BUNDLE_FILE,
    kind: 'manifest',
    operation: existingManifestDigest === null ? 'create' : 'replace-managed',
    beforeDigest: existingManifestDigest,
    nextDigest: sha256Digest(manifest),
  });
  return {
    ok: true,
    bundle: payload.bundle,
    contents,
    files,
    configPath,
  };
}

function planFromFiles(
  host: HostName,
  workspaceRoot: string,
  hostRoot: string,
  hookExpression: string,
  bundleDigest: string,
  files: readonly HostPlanFile[],
): HostIntegrationPlan {
  return hostIntegrationPlanSchema.parse({
    schema: 'pappra/host-integration/1',
    planId: randomUUID(),
    host,
    workspaceRoot,
    hostRoot,
    runtimeEntry: hookExpression,
    bundleDigest,
    files,
    reloadRequired: true,
    trustRequired: true,
    diagnostics: [],
  });
}

async function assertSafeTarget(
  hostRoot: string,
  path: string,
): Promise<Diagnostic | null> {
  if (!isPathInside(hostRoot, path)) {
    return diagnostic(
      diagnosticCodes.host_install_unsafe,
      `Host integration path escapes the selected host root: ${path}`,
      hostRoot,
      'Choose a private host root inside the selected target.',
    );
  }
  const boundary = await ensureStatePathBoundary(hostRoot, path);
  if (!boundary.ok) {
    return diagnostic(
      boundary.code,
      boundary.message,
      path,
      boundary.nextAction ?? 'Inspect the host target; no files were written.',
    );
  }
  const rootObservation = await observePath(hostRoot);
  if (rootObservation.kind === 'symlink' || rootObservation.kind === 'other') {
    return diagnostic(
      diagnosticCodes.host_install_unsafe,
      `Host root is a symlink or unsupported path kind: ${hostRoot}`,
      hostRoot,
      'Choose a real directory; no files were read or written.',
    );
  }
  if (
    rootObservation.kind !== 'missing' &&
    rootObservation.kind !== 'directory'
  ) {
    return diagnostic(
      diagnosticCodes.host_install_unsafe,
      `Host root is not a directory: ${hostRoot}`,
      hostRoot,
      'Choose a directory; no files were read or written.',
    );
  }
  const finalObservation = await observePath(path);
  if (
    finalObservation.kind === 'symlink' ||
    finalObservation.kind === 'other' ||
    finalObservation.kind === 'directory'
  ) {
    return diagnostic(
      diagnosticCodes.host_install_unsafe,
      `Host integration target is a symlink, directory or unsupported path: ${path}`,
      path,
      'Inspect the target; no files were read or written.',
    );
  }
  return null;
}

interface OwnedTemporary {
  readonly dev: number;
  readonly ino: number;
  readonly expected: Buffer;
  writeCompleted: boolean;
}

async function removeOwnedTemporary(
  path: string,
  identity: OwnedTemporary | null,
  rootReal: string,
): Promise<string | null> {
  let parentReal: string;
  try {
    parentReal = await realpath(dirname(path));
  } catch {
    return path;
  }
  if (!isPathInside(rootReal, parentReal)) return path;
  const observed = await observePath(path);
  if (observed.kind === 'missing') return null;
  if (identity === null) {
    return observed.kind === 'file' ? path : null;
  }
  if (
    observed.kind !== 'file' ||
    observed.stats === null ||
    observed.stats.dev !== identity.dev ||
    observed.stats.ino !== identity.ino
  ) {
    return path;
  }
  const read = await readFileBounded(path, identity.expected.length + 1);
  if (!read.ok) return path;
  const bytes = read.value.bytes;
  const complete = identity.expected.equals(bytes);
  const prefix =
    bytes.length < identity.expected.length &&
    identity.expected.subarray(0, bytes.length).equals(bytes);
  const prefixEligible = !identity.writeCompleted && prefix;
  if (!complete && !prefixEligible) return path;
  try {
    await rm(path);
    return null;
  } catch {
    return path;
  }
}
async function temporaryStillOwned(
  path: string,
  identity: OwnedTemporary | null,
  rootReal: string,
): Promise<boolean> {
  if (identity === null) return false;
  let parentReal: string;
  try {
    parentReal = await realpath(dirname(path));
  } catch {
    return false;
  }
  if (!isPathInside(rootReal, parentReal)) return false;
  const observed = await observePath(path);
  if (
    observed.kind !== 'file' ||
    observed.stats === null ||
    observed.stats.dev !== identity.dev ||
    observed.stats.ino !== identity.ino
  ) {
    return false;
  }
  const read = await readFileBounded(path, identity.expected.length + 1);
  return read.ok && identity.expected.equals(read.value.bytes);
}

type WriteResult =
  | { readonly ok: true; readonly residual: string | null }
  | {
      readonly ok: false;
      readonly status: 'conflict' | 'failed';
      readonly diagnostic: Diagnostic;
      readonly residual: string | null;
    };

async function writeAtomic(
  path: string,
  bytes: Buffer,
  options: {
    readonly replace: boolean;
    readonly beforeDigest: string | null;
    readonly root: string;
  },
): Promise<WriteResult> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  let owned: OwnedTemporary | null = null;
  const rootReal = await realpath(options.root);
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(temporary, 'wx', 0o600);
    try {
      if (options.replace) {
        const before = await observePath(path);
        if (before.kind === 'file' && before.stats)
          await handle.chmod(before.stats.mode & 0o777);
      }
      const stats = await handle.stat();
      if (!stats.isFile()) throw new Error('temporary is not a regular file');
      owned = {
        dev: stats.dev,
        ino: stats.ino,
        expected: bytes,
        writeCompleted: false,
      };
      await handle.writeFile(bytes);
      owned.writeCompleted = true;
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (!(await temporaryStillOwned(temporary, owned, rootReal))) {
      const residual = await removeOwnedTemporary(temporary, owned, rootReal);
      return {
        ok: false,
        status: 'failed',
        residual,
        diagnostic: diagnostic(
          diagnosticCodes.host_install_partial,
          `Host temporary namespace, identity, or complete content changed before publication: ${path}`,
          temporary,
          residual === null
            ? 'Inspect the host root; no target was published.'
            : `Inspect the preserved/unknown temporary at ${residual}; no target was published.`,
        ),
      };
    }
    if (options.replace) {
      const current = await readFileBounded(path, 8 * 1024 * 1024);
      const currentDigest = current.ok ? current.value.digest : null;
      if (currentDigest !== options.beforeDigest) {
        const residual = await removeOwnedTemporary(temporary, owned, rootReal);
        return {
          ok: false,
          status: 'conflict',
          residual,
          diagnostic: diagnostic(
            diagnosticCodes.host_install_conflict,
            `Host file changed at publication time; it was preserved: ${path}`,
            path,
            'Inspect the file or replan; Pappra does not overwrite unknown user changes.',
          ),
        };
      }
      await rename(temporary, path);
      return { ok: true, residual: null };
    }
    try {
      await link(temporary, path);
    } catch (error) {
      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : null;
      const residual = await removeOwnedTemporary(temporary, owned, rootReal);
      if (code === 'EEXIST') {
        return {
          ok: false,
          status: 'conflict',
          residual,
          diagnostic: diagnostic(
            diagnosticCodes.host_install_conflict,
            `Host target appeared during publication; it was preserved: ${path}`,
            path,
            'Inspect the new target; no user file was overwritten.',
          ),
        };
      }
      return {
        ok: false,
        status: 'failed',
        residual,
        diagnostic: diagnostic(
          diagnosticCodes.host_install_partial,
          `Cannot publish host integration file ${path}: ${error instanceof Error ? error.message : String(error)}`,
          path,
          'Inspect the host root and retry; no complete manifest was claimed.',
        ),
      };
    }
    const residual = await removeOwnedTemporary(temporary, owned, rootReal);
    return { ok: true, residual };
  } catch (error) {
    const residual = await removeOwnedTemporary(temporary, owned, rootReal);
    return {
      ok: false,
      status: 'failed',
      residual,
      diagnostic: diagnostic(
        diagnosticCodes.host_install_partial,
        `Cannot write host integration file ${path}: ${error instanceof Error ? error.message : String(error)}${residual === null ? '' : `; preserved/unknown temporary: ${residual}`}`,
        residual ?? path,
        residual === null
          ? 'Inspect the host root and retry; no complete manifest was claimed.'
          : `Inspect the preserved/unknown temporary at ${residual}; it was not deleted.`,
      ),
    };
  }
}

interface HostInstallLock {
  readonly path: string;
  readonly token: string;
  readonly dev: number;
  readonly ino: number;
  readonly rootReal: string;
}

/** CLI force is an explicit stop-all-host-writers assertion, not asset ownership. */
async function quarantineUnknownHostLock(
  workspaceRoot: string,
  hostRoot: string,
): Promise<string | null> {
  const file = join(hostRoot, '.pappra-host.lock');
  if (await assertSafeTarget(hostRoot, file)) return null;
  const owner = await inspectPrivateLock(file);
  if (owner.state !== 'unknown') return null;
  const observed = await observePath(file);
  const bytes = await readFileBounded(file, 64 * 1024);
  if (observed.kind !== 'file' || !observed.stats || !bytes.ok) return null;
  const privateState = await ensurePrivateState(workspaceRoot);
  if (!privateState.ok) return null;
  const directory = join(
    workspaceRoot,
    '.pappra',
    'local',
    'host-lock-archive',
  );
  const id = randomUUID();
  const archive = join(directory, `${id}.lock`);
  if (!(await ensureStatePathBoundary(workspaceRoot, archive)).ok) return null;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const saved = await writeAtomic(archive, bytes.value.bytes, {
    replace: false,
    beforeDigest: null,
    root: directory,
  });
  if (!saved.ok) return null;
  const receiptFile = `${archive}.receipt.json`;
  const receipt = Buffer.from(
    `${JSON.stringify(
      {
        schema: 'pappra/host-lock-quarantine/1',
        source: file,
        archive,
        digest: bytes.value.digest,
        identity: { dev: observed.stats.dev, ino: observed.stats.ino },
        owner: 'unknown',
        operator_assertion: { all_host_writers_stopped: true },
        copy_fsynced_before_removal: true,
        created_at: now(),
      },
      null,
      2,
    )}\n`,
  );
  if (
    !(
      await writeAtomic(receiptFile, receipt, {
        replace: false,
        beforeDigest: null,
        root: directory,
      })
    ).ok
  )
    return null;
  const archiveDirectory = await open(directory, 'r');
  try {
    await archiveDirectory.sync();
  } finally {
    await archiveDirectory.close();
  }
  const freshOwner = await inspectPrivateLock(file);
  if (freshOwner.state !== 'unknown') return null;
  const removed = await removeOwnedFile(hostRoot, {
    path: '.pappra-host.lock',
    installId: id,
    operation: 'create',
    beforeDigest: null,
    afterDigest: bytes.value.digest,
    backupRef: null,
    backupDigest: null,
    identity: { dev: observed.stats.dev, ino: observed.stats.ino },
    owner: 'pappra',
    verifiedAt: now(),
  });
  return removed.ok ? archive : null;
}

async function acquireHostInstallLock(
  hostRoot: string,
  host: HostName,
): Promise<
  | { readonly ok: true; readonly lock: HostInstallLock }
  | { readonly ok: false; readonly diagnostic: Diagnostic }
> {
  const path = join(hostRoot, '.pappra-host.lock');
  const safe = await assertSafeTarget(hostRoot, path);
  if (safe !== null) return { ok: false, diagnostic: safe };
  try {
    await mkdir(hostRoot, { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      ok: false,
      diagnostic: diagnostic(
        diagnosticCodes.host_install_partial,
        `Cannot create host root ${hostRoot}: ${error instanceof Error ? error.message : String(error)}`,
        hostRoot,
        'Inspect the target; no host files were written.',
      ),
    };
  }
  try {
    const rootReal = await realpath(hostRoot);
    const token = `${JSON.stringify({ schema: 'pappra/host-install-lock/1', token: randomUUID(), pid: process.pid, process_identity: captureProcessIdentity() ?? undefined })}\n`;
    const revalidate = async () => {
      if (
        (await realpath(hostRoot)) !== rootReal ||
        (await assertSafeTarget(hostRoot, path)) !== null
      )
        throw new Error('Host lock namespace changed.');
    };
    try {
      await publishPrivateLock(path, Buffer.from(token), revalidate);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await inspectPrivateLock(path)).state !== 'dead'
      )
        throw error;
      await reclaimDeadPrivateLock(path, revalidate);
      await publishPrivateLock(path, Buffer.from(token), revalidate);
    }
    const observed = await observePath(path);
    if (observed.kind !== 'file' || !observed.stats)
      throw new Error('Host lock identity unavailable.');
    return {
      ok: true,
      lock: {
        path,
        token,
        dev: observed.stats.dev,
        ino: observed.stats.ino,
        rootReal,
      },
    };
  } catch (error) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : null;
    return {
      ok: false,
      diagnostic: diagnostic(
        code === 'EEXIST'
          ? diagnosticCodes.host_install_conflict
          : diagnosticCodes.host_install_partial,
        `Cannot acquire host install lock ${path}: ${error instanceof Error ? error.message : String(error)}`,
        path,
        `A live or unverified owner is preserved. Stop all writers for this host root, then use pappra host uninstall --host ${host} --host-root ${JSON.stringify(hostRoot)} --force --apply to quarantine an unknown legacy lock. Verified live owners are never overridden.`,
      ),
    };
  }
}

async function releaseHostInstallLock(lock: HostInstallLock): Promise<boolean> {
  let parentReal: string;
  try {
    parentReal = await realpath(dirname(lock.path));
  } catch {
    return false;
  }
  if (parentReal !== lock.rootReal) return false;
  const observed = await observePath(lock.path);
  if (observed.kind === 'missing') return true;
  if (
    observed.kind !== 'file' ||
    observed.stats === null ||
    observed.stats.dev !== lock.dev ||
    observed.stats.ino !== lock.ino
  ) {
    return false;
  }
  const read = await readFileBounded(lock.path, 4096);
  if (!read.ok || read.value.bytes.toString('utf8') !== lock.token) {
    return false;
  }
  try {
    await rm(lock.path);
    return true;
  } catch {
    return false;
  }
}

export class HostIntegrationService {
  readonly #root: string;
  readonly #homeDir: string;
  readonly #pathEnv: string;
  readonly #runtimeEntry: string;
  readonly #hostVersion: string | null;
  readonly #selectedHosts: readonly HostName[];
  readonly #observedAt: string;
  readonly #versionProbe: (host: HostName) => string | null;

  constructor(options: HostIntegrationOptions) {
    this.#root = resolve(options.root);
    this.#homeDir = resolve(options.homeDir);
    this.#pathEnv = options.pathEnv;
    this.#runtimeEntry = resolve(options.runtimeEntry ?? packageRuntimeEntry());
    this.#hostVersion = options.hostVersion ?? null;
    this.#selectedHosts = options.selectedHosts ?? ['pi', 'codex', 'claude'];
    this.#observedAt = options.observedAt ?? now();
    this.#versionProbe =
      options.versionProbe ??
      ((host) => observeHostVersion(host, this.#pathEnv));
  }

  detect(): readonly HostCapabilities[] {
    const observations = detectPassiveHosts({
      homeDir: this.#homeDir,
      pathEnv: this.#pathEnv,
      selectedHosts: this.#selectedHosts,
      observedAt: this.#observedAt,
    });
    return observations.map((observation) => {
      const host = hostNameSchema.parse(observation.host);
      return hostCapabilities(host, {
        version: this.#hostVersion,
        executablePath: observation.executablePath,
        configPath: observation.configPaths[0] ?? null,
        installed: observation.executablePath !== null,
        wiringVerified: false,
        observedAt: this.#observedAt,
      });
    });
  }

  describe(host: HostName): HostCapabilities {
    const observation = detectPassiveHosts({
      homeDir: this.#homeDir,
      pathEnv: this.#pathEnv,
      selectedHosts: [host],
      observedAt: this.#observedAt,
    }).find((entry) => entry.host === host);
    return hostCapabilities(host, {
      version: this.#hostVersion,
      executablePath: observation?.executablePath ?? null,
      configPath: observation?.configPaths[0] ?? null,
      installed:
        observation?.executablePath !== undefined &&
        observation?.executablePath !== null,
      wiringVerified: false,
      observedAt: this.#observedAt,
    });
  }

  adapter(host: HostName): HostAdapter {
    return new HostAdapter(this, host);
  }

  async plan(
    host: HostName,
    options: HostTargetOptions = {},
  ): Promise<HostIntegrationPlan> {
    const hostRoot = resolve(
      options.hostRoot ?? join(this.#root, '.pappra', 'local', 'hosts', host),
    );
    const hookSource = resolve(options.runtimeEntry ?? this.#runtimeEntry);
    const version = this.#versionProbe(host);
    if (!isSupportedVersion(host, version)) {
      throw new Error(
        `Host ${host} version ${version ?? '(unknown)'} is outside the pinned support matrix.`,
      );
    }
    if (!(await runtimeEntryReady(hookSource))) {
      throw new Error(`Bundled Pappra hook is missing: ${hookSource}`);
    }
    const target = hookTarget(host, this.#root, hostRoot, hookSource);
    const built = await hostPlanFiles(
      host,
      this.#root,
      hostRoot,
      hookSource,
      this.#observedAt,
      options.migrate === true,
    );
    if (!built.ok) throw new Error(built.diagnostic.message);
    return planFromFiles(
      host,
      this.#root,
      hostRoot,
      target.expression,
      built.bundle.bundleDigest,
      built.files,
    );
  }

  async install(
    host: HostName,
    options: HostTargetOptions & { readonly apply: boolean },
  ): Promise<HostIntegrationResult> {
    if (options.mode === 'plugin') {
      const support = HOST_PLUGIN_HOOKS[host];
      const guidance =
        host === 'claude' && support.state === 'verified'
          ? 'Export with `pappra host bundle --host claude --out <dir> --marketplace --json`, then run `claude plugin marketplace add <dir>` and `claude plugin install pappra@pappra-local`. Use --mode project-settings for automatic workspace wiring.'
          : host === 'pi' && support.state === 'verified'
            ? 'Export with `pappra host bundle --host pi --out <dir> --json`, then run `pi install <dir> -l -a`. Use --mode project-settings for automatic workspace wiring.'
            : support.state === 'unsupported'
              ? 'This host does not load plugin hooks at its pinned version; keep --mode project-settings. See docs/host-plugin-validation.md.'
              : 'Plugin hooks are not verified for this host yet; an authenticated lifecycle session is required. Use --mode project-settings meanwhile.';
      return hostIntegrationResultSchema.parse({
        schema: 'pappra/host-integration/1',
        ok: false,
        status: 'unsupported',
        plan: null,
        appliedFiles: [],
        residualPaths: [],
        diagnostics: [
          diagnostic(
            diagnosticCodes.host_unavailable,
            `Plugin install mode is not wired for ${host}: ${support.state}. ${support.evidence}`,
            this.#root,
            guidance,
          ),
        ],
      });
    }
    let plan: HostIntegrationPlan;
    let contents: ReadonlyMap<string, Buffer>;
    try {
      const hostRoot = resolve(
        options.hostRoot ?? join(this.#root, '.pappra', 'local', 'hosts', host),
      );
      const hookSource = resolve(options.runtimeEntry ?? this.#runtimeEntry);
      const version = this.#versionProbe(host);
      if (!isSupportedVersion(host, version)) {
        return hostIntegrationResultSchema.parse({
          schema: 'pappra/host-integration/1',
          ok: false,
          status: 'unsupported',
          plan: null,
          appliedFiles: [],
          residualPaths: [],
          diagnostics: [
            diagnostic(
              diagnosticCodes.host_version_unsupported,
              `Host ${host} version ${version ?? '(unknown)'} is outside the pinned ${HOST_SUPPORT[host].version} support matrix.`,
              hostRoot,
              'Select a supported host version or use manual checkpoint/resume.',
            ),
          ],
        });
      }
      if (!(await runtimeEntryReady(hookSource))) {
        return hostIntegrationResultSchema.parse({
          schema: 'pappra/host-integration/1',
          ok: false,
          status: 'invalid',
          plan: null,
          appliedFiles: [],
          residualPaths: [],
          diagnostics: [
            diagnostic(
              diagnosticCodes.host_unavailable,
              `Bundled Pappra hook is missing: ${hookSource}`,
              hookSource,
              'Install or select a complete Pappra runtime before wiring a host.',
            ),
          ],
        });
      }
      const target = hookTarget(host, this.#root, hostRoot, hookSource);
      const built = await hostPlanFiles(
        host,
        this.#root,
        hostRoot,
        hookSource,
        this.#observedAt,
        options.migrate === true,
      );
      if (!built.ok) {
        return hostIntegrationResultSchema.parse({
          schema: 'pappra/host-integration/1',
          ok: false,
          status: built.conflict === true ? 'conflict' : 'invalid',
          plan: null,
          appliedFiles: [],
          residualPaths: [],
          diagnostics: [built.diagnostic],
        });
      }
      plan = planFromFiles(
        host,
        this.#root,
        hostRoot,
        target.expression,
        built.bundle.bundleDigest,
        built.files,
      );
      contents = built.contents;
    } catch (error) {
      return hostIntegrationResultSchema.parse({
        schema: 'pappra/host-integration/1',
        ok: false,
        status: 'failed',
        plan: null,
        appliedFiles: [],
        residualPaths: [],
        diagnostics: [
          diagnostic(
            diagnosticCodes.host_install_partial,
            `Cannot plan host integration: ${error instanceof Error ? error.message : String(error)}`,
            this.#root,
            'Inspect the host target; no complete integration was claimed.',
          ),
        ],
      });
    }

    if (!options.apply) {
      return hostIntegrationResultSchema.parse({
        schema: 'pappra/host-integration/1',
        ok: true,
        status: 'planned',
        plan,
        appliedFiles: [],
        residualPaths: [],
        diagnostics: [],
      });
    }

    const applied: string[] = [];
    const residualPaths: string[] = [];
    const diagnostics: Diagnostic[] = [];
    if (isPathInside(join(this.#root, '.pappra', 'local'), plan.hostRoot)) {
      const privateState = await ensurePrivateState(this.#root);
      if (!privateState.ok) {
        return hostIntegrationResultSchema.parse({
          schema: 'pappra/host-integration/1',
          ok: false,
          status: 'failed',
          plan,
          appliedFiles: [],
          residualPaths: [],
          diagnostics: [
            diagnostic(
              privateState.code,
              privateState.message,
              this.#root,
              privateState.nextAction ??
                'Protect private workspace state before installing the host.',
            ),
          ],
        });
      }
    }
    const lockResult = await acquireHostInstallLock(plan.hostRoot, host);
    if (!lockResult.ok) {
      return hostIntegrationResultSchema.parse({
        schema: 'pappra/host-integration/1',
        ok: false,
        status:
          lockResult.diagnostic.code === diagnosticCodes.host_install_conflict
            ? 'conflict'
            : 'failed',
        plan,
        appliedFiles: [],
        residualPaths: [],
        diagnostics: [lockResult.diagnostic],
      });
    }
    try {
      const conflicted = plan.files.find(
        (file) => file.operation === 'conflict',
      );
      if (conflicted !== undefined) {
        const path = join(plan.hostRoot, ...conflicted.path.split('/'));
        diagnostics.push(
          diagnostic(
            diagnosticCodes.host_install_conflict,
            `Managed host file was edited since installation; it was preserved: ${path}`,
            path,
            'Inspect the user edit and replan only after resolving ownership.',
          ),
        );
        return hostIntegrationResultSchema.parse({
          schema: 'pappra/host-integration/1',
          ok: false,
          status: 'conflict',
          plan,
          appliedFiles: [],
          residualPaths: [],
          diagnostics,
        });
      }
      for (const file of plan.files) {
        const path = join(plan.hostRoot, ...file.path.split('/'));
        const unsafe = await assertSafeTarget(plan.hostRoot, path);
        if (unsafe !== null) {
          diagnostics.push(unsafe);
          return hostIntegrationResultSchema.parse({
            schema: 'pappra/host-integration/1',
            ok: false,
            status: 'invalid',
            plan,
            appliedFiles: applied,
            residualPaths: [],
            diagnostics,
          });
        }
        if (file.operation === 'conflict') {
          diagnostics.push(
            diagnostic(
              diagnosticCodes.host_install_conflict,
              `Managed host file was edited since installation; it was preserved: ${path}`,
              path,
              'Inspect the user edit and replan only after resolving ownership.',
            ),
          );
          return hostIntegrationResultSchema.parse({
            schema: 'pappra/host-integration/1',
            ok: false,
            status: 'conflict',
            plan,
            appliedFiles: applied,
            residualPaths: [],
            diagnostics,
          });
        }
        const current = await readFileBounded(path, 8 * 1024 * 1024);
        if (!current.ok && current.code !== diagnosticCodes.fileNotFound) {
          diagnostics.push(
            diagnostic(
              current.code,
              current.message,
              path,
              current.nextAction ?? 'Inspect the host target.',
            ),
          );
          return hostIntegrationResultSchema.parse({
            schema: 'pappra/host-integration/1',
            ok: false,
            status: 'failed',
            plan,
            appliedFiles: applied,
            residualPaths: [],
            diagnostics,
          });
        }
        const before = current.ok ? current.value.digest : null;
        if (before !== file.beforeDigest) {
          diagnostics.push(
            diagnostic(
              diagnosticCodes.host_install_conflict,
              `Host file changed since planning; it was preserved: ${path}`,
              path,
              'Inspect the file or replan; Pappra does not overwrite unknown user changes.',
            ),
          );
          return hostIntegrationResultSchema.parse({
            schema: 'pappra/host-integration/1',
            ok: false,
            status: 'conflict',
            plan,
            appliedFiles: applied,
            residualPaths: [],
            diagnostics,
          });
        }
        if (before === file.nextDigest) {
          continue;
        }
        const bytes = contents.get(file.path);
        if (bytes === undefined) {
          diagnostics.push(
            diagnostic(
              diagnosticCodes.host_bundle_invalid,
              `Missing planned content for ${file.path}.`,
              path,
              'Replan the integration; no file was written.',
            ),
          );
          return hostIntegrationResultSchema.parse({
            schema: 'pappra/host-integration/1',
            ok: false,
            status: 'failed',
            plan,
            appliedFiles: applied,
            residualPaths: [],
            diagnostics,
          });
        }
        const written = await writeAtomic(path, bytes, {
          replace: file.beforeDigest !== null,
          beforeDigest: file.beforeDigest,
          root: plan.hostRoot,
        });
        if (!written.ok) {
          diagnostics.push(written.diagnostic);
          if (written.residual !== null) residualPaths.push(written.residual);
          return hostIntegrationResultSchema.parse({
            schema: 'pappra/host-integration/1',
            ok: false,
            status: written.status,
            plan,
            appliedFiles: applied,
            residualPaths,
            diagnostics,
          });
        }
        applied.push(file.path);
        if (written.residual !== null) residualPaths.push(written.residual);
      }
      return hostIntegrationResultSchema.parse({
        schema: 'pappra/host-integration/1',
        ok: true,
        status: applied.length === 0 ? 'unchanged' : 'applied',
        plan,
        appliedFiles: applied,
        residualPaths,
        diagnostics,
      });
    } finally {
      const released = await releaseHostInstallLock(lockResult.lock);
      if (!released) {
        return hostIntegrationResultSchema.parse({
          schema: 'pappra/host-integration/1',
          ok: false,
          status: 'partial',
          plan,
          appliedFiles: applied,
          residualPaths: [...residualPaths, lockResult.lock.path],
          diagnostics: [
            ...diagnostics,
            diagnostic(
              diagnosticCodes.host_install_conflict,
              `Host install lock was preserved at ${lockResult.lock.path}`,
              lockResult.lock.path,
              'Inspect the edited or replaced lock manually; the install result is partial because the lock was not released.',
            ),
          ],
        });
      }
    }
  }

  async verify(
    host: HostName,
    options: HostTargetOptions = {},
  ): Promise<HostVerification> {
    const hostRoot = resolve(
      options.hostRoot ?? join(this.#root, '.pappra', 'local', 'hosts', host),
    );
    const version = this.#versionProbe(host);
    const capabilities = this.describe(host);
    const checks: HostVerificationCheck[] = [];
    if (!isSupportedVersion(host, version)) {
      return hostVerificationSchema.parse({
        schema: 'pappra/host-verification/1',
        host,
        version,
        hostRoot,
        status: 'unsupported',
        bundleDigest: null,
        checks: [
          {
            id: 'host.version',
            status: 'unsupported',
            detail: `Version ${version ?? '(unknown)'} is outside the pinned ${HOST_SUPPORT[host].version} matrix.`,
          },
        ],
        capabilities: capabilities.capabilities,
        diagnostics: [],
        residualPaths: [],
      });
    }
    const manifest = await this.readManifest(hostRoot);
    if (manifest === null) {
      return hostVerificationSchema.parse({
        schema: 'pappra/host-verification/1',
        host,
        version,
        hostRoot,
        status: 'partial',
        bundleDigest: null,
        checks: [
          {
            id: 'host.manifest',
            status: 'error',
            detail:
              'No Pappra host install manifest exists in the selected host root.',
          },
        ],
        capabilities: capabilities.capabilities,
        diagnostics: [],
        residualPaths: [],
      });
    }
    const expectedConfigPath = hostConfigRelativePath(host);
    const target = hookTarget(host, this.#root, hostRoot, this.#runtimeEntry);
    const identityError = validateManifestIdentity(
      manifest,
      host,
      hostRoot,
      expectedConfigPath,
      target.expression,
      false,
    );
    if (identityError !== null) {
      return hostVerificationSchema.parse({
        schema: 'pappra/host-verification/1',
        host,
        version,
        hostRoot,
        status: 'conflict',
        bundleDigest: null,
        checks: [
          {
            id: 'host.manifest',
            status: 'error',
            detail: identityError.message,
          },
        ],
        capabilities: capabilities.capabilities,
        diagnostics: [identityError],
        residualPaths: [],
      });
    }
    let currentBundle;
    try {
      currentBundle = await loadHostBundle(host, getPackageInfo().version, {
        hookSource: this.#runtimeEntry,
        hookExpression: target.expression,
        observedAt: this.#observedAt,
      });
    } catch {
      return hostVerificationSchema.parse({
        schema: 'pappra/host-verification/1',
        host,
        version,
        hostRoot,
        status: 'partial',
        bundleDigest: null,
        checks: [
          {
            id: 'host.bundle',
            status: 'warning',
            detail:
              'Current package bundle could not be loaded; manifest coverage was not read.',
          },
        ],
        capabilities: capabilities.capabilities,
        diagnostics: [],
        residualPaths: [],
      });
    }
    if (currentBundle.bundle.bundleDigest !== manifest.bundleDigest) {
      return hostVerificationSchema.parse({
        schema: 'pappra/host-verification/1',
        host,
        version,
        hostRoot,
        status: 'conflict',
        bundleDigest: null,
        checks: [
          {
            id: 'host.bundle',
            status: 'error',
            detail:
              'Manifest bundle digest does not match the current package; forged or stale metadata is not verified.',
          },
        ],
        capabilities: capabilities.capabilities,
        diagnostics: [],
        residualPaths: [],
      });
    }
    const expectedFiles = new Map<string, string>();
    for (const [sourcePath, bytes] of currentBundle.contents) {
      expectedFiles.set(
        installPathForBundleFile(host, sourcePath),
        sha256Digest(bytes),
      );
    }
    const expectedPaths = new Set(expectedFiles.keys());
    if (expectedConfigPath !== null) expectedPaths.add(expectedConfigPath);
    const manifestFiles = new Map(
      manifest.files.map((entry) => [entry.path, entry.digest]),
    );
    if (
      manifestFiles.size !== expectedPaths.size ||
      [...expectedPaths].some((path) => !manifestFiles.has(path))
    ) {
      return hostVerificationSchema.parse({
        schema: 'pappra/host-verification/1',
        host,
        version,
        hostRoot,
        status: 'conflict',
        bundleDigest: null,
        checks: [
          {
            id: 'host.coverage',
            status: 'error',
            detail:
              'Manifest file set does not exactly cover the current bundle and expected config.',
          },
        ],
        capabilities: capabilities.capabilities,
        diagnostics: [],
        residualPaths: [],
      });
    }
    for (const [path, digest] of expectedFiles) {
      if (manifestFiles.get(path) !== digest) {
        return hostVerificationSchema.parse({
          schema: 'pappra/host-verification/1',
          host,
          version,
          hostRoot,
          status: 'conflict',
          bundleDigest: null,
          checks: [
            {
              id: `file:${path}`,
              status: 'error',
              detail:
                'Manifest digest does not match the packaged bundle file.',
            },
          ],
          capabilities: capabilities.capabilities,
          diagnostics: [],
          residualPaths: [],
        });
      }
    }
    for (const path of expectedPaths) {
      const absolute = join(hostRoot, ...path.split('/'));
      const safe = await assertSafeTarget(hostRoot, absolute);
      if (safe !== null) {
        return hostVerificationSchema.parse({
          schema: 'pappra/host-verification/1',
          host,
          version,
          hostRoot,
          status: 'conflict',
          bundleDigest: null,
          checks: [
            {
              id: `file:${path}`,
              status: 'error',
              detail: safe.message,
            },
          ],
          capabilities: capabilities.capabilities,
          diagnostics: [safe],
          residualPaths: [],
        });
      }
    }
    let status: HostVerification['status'] = 'verified';
    for (const file of manifest.files) {
      // Native settings are shared with the user. Their complete digest is a
      // write-plan pin, not an ownership claim over unrelated configuration.
      if (file.path === manifest.configPath) continue;
      const path = join(hostRoot, ...file.path.split('/'));
      const digest = await fileDigest(path);
      if (digest !== file.digest) {
        status = 'conflict';
        checks.push({
          id: `file:${file.path}`,
          status: 'error',
          detail:
            'Installed file is missing or differs from its recorded digest.',
        });
      } else {
        checks.push({
          id: `file:${file.path}`,
          status: 'ok',
          detail: 'Installed file digest matches the manifest.',
        });
      }
    }
    if (manifest.configPath !== null) {
      const configPath = join(hostRoot, ...manifest.configPath.split('/'));
      const config = await readFileBounded(
        configPath,
        DEFAULT_MAX_CONFIG_BYTES,
      );
      if (
        !config.ok ||
        !configHasExpectedHooks(
          host === 'codex' ? 'codex' : 'claude',
          config.value.bytes,
          target.expression,
          configPath,
        )
      ) {
        status = 'conflict';
        checks.push({
          id: 'host.config',
          status: 'error',
          detail:
            'Host config is missing or its managed Pappra hook entries changed, are duplicated, or are incomplete.',
        });
      } else {
        checks.push({
          id: 'host.config',
          status: 'ok',
          detail:
            'Exact Pappra-managed hook entries are present; host trust/reload remains unverified.',
        });
      }
    }
    checks.push({
      id: 'host.native-callability',
      status: 'unknown',
      detail:
        'File wiring verified only. Native loader/handshake, trust and event delivery were not executed.',
    });
    return hostVerificationSchema.parse({
      schema: 'pappra/host-verification/1',
      host,
      version,
      hostRoot,
      status,
      bundleDigest: manifest.bundleDigest,
      checks,
      capabilities: capabilities.capabilities,
      diagnostics: [],
      residualPaths: [],
    });
  }

  async uninstall(
    host: HostName,
    options: HostTargetOptions & {
      readonly apply: boolean;
      readonly force?: boolean;
    },
  ): Promise<HostUninstallResult> {
    const hostRoot = resolve(
      options.hostRoot ?? join(this.#root, '.pappra', 'local', 'hosts', host),
    );
    const plannedFiles: string[] = [];
    const removedFiles: string[] = [];
    const retainedPaths: string[] = [];
    const quarantinedLocks: string[] = [];
    const diagnostics: Diagnostic[] = [];
    const result = (status: HostUninstallResult['status'], ok: boolean) => {
      if (!ok && diagnostics.length === 0)
        diagnostics.push(
          diagnostic(
            diagnosticCodes.host_install_conflict,
            'Host uninstall preserved edited, unsafe or unreadable content.',
            retainedPaths[0] ?? hostRoot,
            'Inspect the reported preserved paths; no unknown user content is removed automatically.',
          ),
        );
      return hostUninstallResultSchema.parse({
        schema: 'pappra/host-uninstall/1',
        host,
        hostRoot,
        ok,
        status,
        plannedFiles,
        removedFiles,
        retainedPaths: [...new Set(retainedPaths)],
        quarantinedLocks,
        diagnostics: diagnostics.slice(0, 32),
      });
    };
    const manifestPath = join(hostRoot, BUNDLE_FILE);
    const boundary = await assertSafeTarget(hostRoot, manifestPath);
    if (boundary) {
      diagnostics.push(boundary);
      return result('conflict', false);
    }
    const lockPath = join(hostRoot, '.pappra-host.lock');
    const lockOwner = await inspectPrivateLock(lockPath);
    const lockFile = await observePath(lockPath);
    if (
      lockOwner.state === 'alive' ||
      (lockFile.kind !== 'missing' &&
        lockOwner.state === 'unknown' &&
        !options.force)
    ) {
      retainedPaths.push(lockPath);
      diagnostics.push(
        diagnostic(
          diagnosticCodes.host_install_conflict,
          lockOwner.state === 'alive'
            ? 'A verified live host writer holds this lock; --force cannot override it.'
            : 'The host lock owner is unknown; it was preserved.',
          lockPath,
          `Stop all host writers, then use pappra host uninstall --host ${host} --host-root ${JSON.stringify(hostRoot)} --force --apply to archive an unknown lock. --force asserts all host writers are stopped and never permits deleting edited assets.`,
        ),
      );
      return result('conflict', false);
    }
    if (
      lockFile.kind !== 'missing' &&
      lockOwner.state === 'unknown' &&
      options.force
    ) {
      plannedFiles.push('.pappra-host.lock');
      if (options.apply) {
        const archived = await quarantineUnknownHostLock(
          this.#root,
          hostRoot,
        ).catch(() => null);
        if (!archived) {
          retainedPaths.push(lockPath);
          return result('conflict', false);
        }
        quarantinedLocks.push(archived);
        removedFiles.push('.pappra-host.lock');
      }
    }
    const manifestRead = await readFileBounded(manifestPath, 256 * 1024);
    if (!manifestRead.ok) {
      if (manifestRead.code === diagnosticCodes.fileNotFound)
        return result(
          removedFiles.length > 0
            ? 'removed'
            : plannedFiles.length > 0
              ? 'planned'
              : 'unchanged',
          true,
        );
      retainedPaths.push(manifestPath);
      return result('conflict', false);
    }
    const manifest = await this.readManifest(hostRoot);
    const expression = hookTarget(
      host,
      this.#root,
      hostRoot,
      this.#runtimeEntry,
    ).expression;
    if (!manifest) {
      retainedPaths.push(manifestPath);
      return result('conflict', false);
    }
    const identity = validateManifestIdentity(
      manifest,
      host,
      hostRoot,
      hostConfigRelativePath(host),
      expression,
      false,
    );
    if (identity) {
      diagnostics.push(identity);
      return result('conflict', false);
    }
    let payload;
    try {
      payload = await loadHostBundle(host, getPackageInfo().version, {
        hookExpression: expression,
      });
    } catch {
      retainedPaths.push(manifestPath);
      return result('failed', false);
    }
    const allowed = new Set(
      [...payload.contents.keys()].map((file) =>
        installPathForBundleFile(host, file),
      ),
    );
    const configRelative = hostConfigRelativePath(host);
    let config: { path: string; before: string; bytes: Buffer } | null = null;
    if (host !== 'pi' && configRelative) {
      const file = join(hostRoot, configRelative);
      const unsafe = await assertSafeTarget(hostRoot, file);
      if (unsafe) {
        diagnostics.push(unsafe);
        retainedPaths.push(file);
        return result('conflict', false);
      }
      const read = await readFileBounded(file, DEFAULT_MAX_CONFIG_BYTES);
      if (read.ok) {
        const patch = removeManagedConfig(
          host,
          read.value.bytes,
          expression,
          file,
        );
        if (!patch.ok) {
          diagnostics.push(patch.diagnostic);
          retainedPaths.push(file);
          return result('conflict', false);
        }
        if (!patch.bytes.equals(read.value.bytes)) {
          plannedFiles.push(configRelative);
          config = {
            path: file,
            before: read.value.digest,
            bytes: patch.bytes,
          };
        }
      } else if (read.code !== diagnosticCodes.fileNotFound) {
        retainedPaths.push(file);
        return result('conflict', false);
      }
    }
    const candidates: { path: string; digest: string }[] = [];
    for (const entry of manifest.files) {
      if (entry.path === configRelative) continue;
      const file = join(hostRoot, ...entry.path.split('/'));
      if (!allowed.has(entry.path)) {
        retainedPaths.push(file);
        continue;
      }
      const unsafe = await assertSafeTarget(hostRoot, file);
      if (unsafe) {
        diagnostics.push(unsafe);
        retainedPaths.push(file);
        continue;
      }
      const read = await readFileBounded(file, 8 * 1024 * 1024);
      if (!read.ok && read.code === diagnosticCodes.fileNotFound) continue;
      if (!read.ok || read.value.digest !== entry.digest) {
        retainedPaths.push(file);
        continue;
      }
      plannedFiles.push(entry.path);
      candidates.push({ path: entry.path, digest: entry.digest });
    }
    if (
      host === 'pi' &&
      retainedPaths.some((file) =>
        isPathInside(join(hostRoot, 'extensions'), file),
      )
    ) {
      // An edited entrypoint may still import its runtime companion.
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const entry = candidates[index]!;
        if (!entry.path.startsWith('extensions/')) continue;
        retainedPaths.push(join(hostRoot, ...entry.path.split('/')));
        plannedFiles.splice(plannedFiles.indexOf(entry.path), 1);
        candidates.splice(index, 1);
      }
    }
    if (retainedPaths.length === 0) plannedFiles.push(BUNDLE_FILE);
    if (!options.apply)
      return result(
        retainedPaths.length ? 'partial' : 'planned',
        retainedPaths.length === 0,
      );
    const lock = await acquireHostInstallLock(hostRoot, host);
    if (!lock.ok) {
      diagnostics.push(lock.diagnostic);
      return result('conflict', false);
    }
    let status: HostUninstallResult['status'] = 'removed';
    try {
      const freshManifest = await readFileBounded(manifestPath, 256 * 1024);
      if (
        !freshManifest.ok ||
        freshManifest.value.digest !== manifestRead.value.digest
      ) {
        retainedPaths.push(manifestPath);
        status = 'conflict';
      } else {
        if (config) {
          const written = await writeAtomic(config.path, config.bytes, {
            replace: true,
            beforeDigest: config.before,
            root: hostRoot,
          });
          if (!written.ok) {
            diagnostics.push(written.diagnostic);
            retainedPaths.push(config.path);
            status = 'conflict';
          }
        }
        const remove = async (entry: { path: string; digest: string }) => {
          const file = join(hostRoot, ...entry.path.split('/'));
          const observed = await observePath(file);
          if (observed.kind === 'missing') return;
          if (observed.kind !== 'file' || !observed.stats) {
            retainedPaths.push(file);
            return;
          }
          const removed = await removeOwnedFile(hostRoot, {
            path: entry.path,
            installId: randomUUID(),
            operation: 'create',
            beforeDigest: null,
            afterDigest: entry.digest,
            backupRef: null,
            backupDigest: null,
            identity: { dev: observed.stats.dev, ino: observed.stats.ino },
            owner: 'pappra',
            verifiedAt: now(),
          });
          if (removed.ok) removedFiles.push(entry.path);
          else retainedPaths.push(file);
        };
        if (status !== 'conflict') {
          for (const entry of candidates) await remove(entry);
          if (retainedPaths.length === 0)
            await remove({
              path: BUNDLE_FILE,
              digest: manifestRead.value.digest,
            });
        }
      }
    } catch {
      status = 'failed';
      retainedPaths.push(manifestPath);
    } finally {
      if (!(await releaseHostInstallLock(lock.lock)))
        retainedPaths.push(lock.lock.path);
    }
    if (status === 'removed' && retainedPaths.length > 0) status = 'partial';
    return result(status, status === 'removed');
  }

  async readManifest(hostRoot: string): Promise<HostInstallManifest | null> {
    const path = join(hostRoot, BUNDLE_FILE);
    const safe = await assertSafeTarget(hostRoot, path);
    if (safe !== null) return null;
    const read = await readFileBounded(path, 256 * 1024);
    if (!read.ok) return null;
    let value: unknown;
    try {
      value = JSON.parse(read.value.bytes.toString('utf8'));
    } catch {
      return null;
    }
    const parsed = hostInstallManifestSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
}

export class HostAdapter {
  readonly host: HostName;
  readonly #service: HostIntegrationService;

  constructor(service: HostIntegrationService, host: HostName) {
    this.#service = service;
    this.host = host;
  }

  detect(): HostCapabilities {
    return this.#service.describe(this.host);
  }

  describeCapabilities(): HostCapabilities {
    return this.detect();
  }

  planIntegration(
    options: HostTargetOptions = {},
  ): Promise<HostIntegrationPlan> {
    return this.#service.plan(this.host, options);
  }

  verifyIntegration(
    options: HostTargetOptions = {},
  ): Promise<HostVerification> {
    return this.#service.verify(this.host, options);
  }
}
