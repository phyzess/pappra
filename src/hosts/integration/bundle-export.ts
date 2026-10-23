import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { basename, isAbsolute, dirname, join, resolve } from 'node:path';
import { getPackageRoot } from '../../package-info.js';
import type { HostName } from '../../schemas/host.js';
import { isPathInside } from '../../schemas/paths.js';
import { loadHostBundle } from './bundle.js';
import type { PiBootstrapConfig } from './bootstrap-config.js';
import { renderHookConfigPatch } from './templates.js';

import { readBoundedFile } from '../../app/bounded-file.js';
import { readPiRecoveryConfig } from './pi-recovery-extension.js';
export interface HostPluginBundle {
  readonly host: HostName;
  readonly outDir: string;
  readonly files: readonly string[];
  readonly pluginManifest: string;
  readonly hookConfig: string | null;
  readonly registration: readonly string[];
  /** Plugin registration and native callability are not verified here. */
  readonly verification: 'unsupported';
  /** Present only for the opt-in Pi bootstrap export. */
  readonly bootstrap?: {
    readonly schema: string;
    readonly configDigest: string;
    readonly mode: 'deny-until-completed-transfer';
    /** Export writes files only; a host loader must prove registration separately. */
    readonly registeredByExport: false;
  };
  /** Present only for an explicitly configured Pi recovery export. */
  readonly recovery?: {
    readonly schema: string;
    readonly configDigest: string;
    readonly registeredByExport: false;
  };
  /** Present only when the Pi session-transition extension was explicitly requested. */
  readonly transition?: {
    readonly registeredByExport: false;
    readonly nativeQuiescence: 'unavailable';
  };
}

export interface BootstrapBundleInput {
  readonly config: PiBootstrapConfig;
  /** The exact bytes that were validated and pinned; never re-read during generation. */
  readonly configBytes: Buffer;
  readonly configDigest: string;
  /** Built self-contained extension artifact shipped next to the config. */
  readonly artifactPath: string;
}

export interface RecoveryBundleInput {
  /** Explicit user-selected config; validated again before exact bytes are staged. */
  readonly configFile: string;
  /** Self-contained extension artifact produced by the isolated asset build. */
  readonly artifactPath: string;
}

export interface TransitionBundleInput {
  /** Self-contained extension artifact produced by the isolated asset build. */
  readonly artifactPath: string;
}

const BOOTSTRAP_EXTENSION_DIR = 'extensions/pappra-bootstrap';

function pluginHookExpression(host: HostName): string {
  return host === 'claude'
    ? '${CLAUDE_PLUGIN_ROOT}/hooks/pappra-hook.mjs'
    : './hooks/pappra-hook.mjs';
}

function hostManifest(
  host: HostName,
  version: string,
): {
  readonly path: string;
  readonly value: Record<string, unknown>;
} {
  if (host === 'claude' || host === 'codex') {
    // Codex reads the Claude plugin manifest path, so one manifest serves both.
    return {
      path: '.claude-plugin/plugin.json',
      value: {
        name: 'pappra',
        version,
        description:
          'Portable workspace knowledge and continuity for coding agents.',
        author: { name: 'phyzess' },
        hooks: './hooks/hooks.json',
      },
    };
  }
  return {
    path: 'package.json',
    value: {
      name: '@phyzess/pappra-pi',
      version,
      description: 'Pappra Pi package: bounded lifecycle hooks and skill.',
      type: 'module',
      pi: {
        extensions: ['./extensions/pappra/index.ts'],
        skills: ['./skills'],
      },
      peerDependencies: { '@earendil-works/pi-coding-agent': '*' },
    },
  };
}

function bootstrapManifest(version: string): Record<string, unknown> {
  return {
    name: '@phyzess/pappra-pi-bootstrap',
    version,
    description:
      'Pappra Pi bootstrap package: opt-in successor gate with a private local task binding.',
    type: 'module',
    pi: {
      extensions: [`./${BOOTSTRAP_EXTENSION_DIR}/index.ts`],
      skills: ['./skills'],
    },
    peerDependencies: { '@earendil-works/pi-coding-agent': '*' },
  };
}

function bootstrapEntry(): Buffer {
  return Buffer.from(
    `/**
 * Generated Pappra Pi bootstrap extension. It registers the accepted default-deny
 * successor gate from a private relative configuration; it installs, trusts, launches
 * and dispatches nothing by itself.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bootstrapExtension from "./runtime.mjs";

export default function (pi: ExtensionAPI): void {
  bootstrapExtension(pi);
}
`,
    'utf8',
  );
}

interface StagedBootstrapOutput {
  /** Canonical final directory; the caller's path is resolved through its real parent. */
  readonly finalPath: string;
  /** Exclusive private sibling that assembles the complete payload. */
  readonly stagePath: string;
  /** Canonical realpath of the staging directory captured right after creation. */
  readonly stageReal: string;
  readonly dev: number;
  readonly ino: number;
}

interface FinalClaim {
  readonly dev: number;
  readonly ino: number;
}

/**
 * Reserves a private sibling staging directory next to the requested destination. Nothing is
 * written through the final pathname: the payload is assembled here and published after an
 * exclusive final claim, so a later substitution of the destination cannot redirect a write.
 */
async function beginBootstrapOutput(
  outDir: string,
): Promise<StagedBootstrapOutput> {
  const resolved = resolve(outDir);
  const finalName = basename(resolved);
  if (finalName === '' || finalName === '.' || finalName === '..')
    throw new Error('bootstrap bundle destination must be a directory path');
  const parent = dirname(resolved);
  let parentStat: Awaited<ReturnType<typeof lstat>>;
  try {
    parentStat = await lstat(parent);
  } catch {
    throw new Error(`bootstrap bundle parent does not exist: ${parent}`);
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    throw new Error('bootstrap bundle parent must be a real directory');
  const realParent = await realpath(parent);
  const finalPath = join(realParent, finalName);
  let existing: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    existing = await lstat(finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing !== null)
    throw new Error(
      'bootstrap bundle destination must not exist; pass a new private directory',
    );
  const stagePath = await mkdtemp(join(realParent, '.pappra-bootstrap-'));
  const staged = await lstat(stagePath);
  const stageReal = await realpath(stagePath);
  return { finalPath, stagePath, stageReal, dev: staged.dev, ino: staged.ino };
}

const STAGE_DRIFT = 'bootstrap staging namespace changed during export';

/**
 * Fails closed on observed staging namespace drift (symlink, type change or device/inode
 * change). This models a check/use boundary, not a general same-user filesystem fence: portable
 * Node exposes no anchored directory writes.
 */
async function stageDrift(
  stage: StagedBootstrapOutput,
): Promise<string | null> {
  try {
    const current = await lstat(stage.stagePath);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== stage.dev ||
      current.ino !== stage.ino
    )
      return STAGE_DRIFT;
    const real = await realpath(stage.stagePath);
    if (real !== stage.stageReal) return STAGE_DRIFT;
    return null;
  } catch {
    return STAGE_DRIFT;
  }
}

async function assertStage(stage: StagedBootstrapOutput): Promise<void> {
  const drift = await stageDrift(stage);
  if (drift !== null) throw new Error(drift);
}

/** Removes only the staging directory this call created; substituted paths are retained. */
async function discardStage(stage: StagedBootstrapOutput): Promise<void> {
  try {
    const current = await lstat(stage.stagePath);
    if (
      current.isSymbolicLink() ||
      current.dev !== stage.dev ||
      current.ino !== stage.ino
    )
      return;
    await rm(stage.stagePath, { recursive: true, force: false });
  } catch {
    // Missing or unreadable after a substitution: keep whatever is there.
  }
}

/**
 * Claims the final path with an exclusive `mkdir`, which is the only portable no-replace
 * directory primitive. Anything already at the path (empty directory, file or symlink) makes
 * this fail and is preserved.
 */
async function claimFinal(stage: StagedBootstrapOutput): Promise<FinalClaim> {
  await mkdir(stage.finalPath, { recursive: false, mode: 0o700 });
  const claimed = await lstat(stage.finalPath);
  return { dev: claimed.dev, ino: claimed.ino };
}

async function verifyClaim(
  stage: StagedBootstrapOutput,
  claim: FinalClaim,
): Promise<void> {
  const current = await lstat(stage.finalPath);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== claim.dev ||
    current.ino !== claim.ino
  )
    throw new Error('bootstrap bundle destination changed during publication');
}

/** Removes the claim only when it is still the empty directory this call created. */
async function releaseClaim(
  stage: StagedBootstrapOutput,
  claim: FinalClaim,
): Promise<void> {
  try {
    const current = await lstat(stage.finalPath);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== claim.dev ||
      current.ino !== claim.ino
    )
      return;
    // A directory claim must be removed with the directory operation: `rm` with
    // `recursive: false` rejects a directory (EISDIR) even when it is empty.
    await rmdir(stage.finalPath);
  } catch {
    // A substituted or non-empty destination is preserved.
  }
}

/**
 * Publishes the completed staged directory over the empty claim created by this call. The
 * claim identity and the stage identity are re-checked first; the staged inode is verified
 * after publication. A same-user process racing exactly between these checks is outside what
 * portable Node can fence (no renameat2/RENAME_NOREPLACE or openat), and is documented as a
 * check/use limit rather than claimed as prevented.
 */
async function publishStage(
  stage: StagedBootstrapOutput,
  claim: FinalClaim,
): Promise<void> {
  await verifyClaim(stage, claim);
  await assertStage(stage);
  await rename(stage.stagePath, stage.finalPath);
  const final = await lstat(stage.finalPath);
  if (
    final.isSymbolicLink() ||
    !final.isDirectory() ||
    final.dev !== stage.dev ||
    final.ino !== stage.ino
  )
    throw new Error(
      'bootstrap publication did not produce the staged directory',
    );
}
function piExtensionEntry(runtimeFile: string): Buffer {
  return Buffer.from(
    `/** Generated opt-in Pi extension shim; it never installs or trusts itself. */\nimport type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\nimport extension from "./${runtimeFile}";\n\nexport default function (pi: ExtensionAPI): void {\n  extension(pi);\n}\n`,
    'utf8',
  );
}

function piExtensionManifest(
  version: string,
  extensions: readonly string[],
): Record<string, unknown> {
  return {
    name: '@phyzess/pappra-pi-collaboration',
    version,
    description: 'Opt-in Pappra Pi collaboration extensions.',
    type: 'module',
    pi: { extensions: [...extensions], skills: ['./skills'] },
    peerDependencies: { '@earendil-works/pi-coding-agent': '*' },
  };
}

/**
 * Writes a host-native plugin/package directory. This is an artifact export: it
 * does not register the plugin with a host, and it never claims the host will
 * load or trust it.
 */
export async function exportHostPluginBundle(options: {
  readonly host: HostName;
  readonly hostVersion: string;
  readonly outDir: string;
  readonly packageVersion: string;
  /** Writes a marketplace root with the plugin under `pappra/`. */
  readonly marketplace?: boolean;
  /** Opt-in Pi-only successor bootstrap export. */
  readonly bootstrap?: BootstrapBundleInput;
  /** Opt-in Pi recovery package with a bounded, task/session-bound config. */
  readonly recovery?: RecoveryBundleInput;
  /** Opt-in Pi transition command package; native quiescence remains unsupported. */
  readonly transition?: TransitionBundleInput;
}): Promise<HostPluginBundle> {
  const outRoot = resolve(options.outDir);
  if (options.marketplace === true && options.host === 'pi') {
    throw new Error(
      'Pi installs a directory directly; a marketplace wrapper is not supported.',
    );
  }
  if (options.bootstrap !== undefined && options.host !== 'pi')
    throw new Error('bootstrap bundles are supported for the Pi host only');
  if (options.bootstrap !== undefined && options.marketplace === true)
    throw new Error('bootstrap bundles cannot be wrapped in a marketplace');
  if (
    (options.recovery !== undefined || options.transition !== undefined) &&
    options.host !== 'pi'
  )
    throw new Error(
      'recovery and transition bundles are supported for the Pi host only',
    );
  if (
    options.bootstrap !== undefined &&
    (options.recovery !== undefined || options.transition !== undefined)
  )
    throw new Error(
      'bootstrap bundles cannot be combined with recovery or transition extensions',
    );
  if (
    (options.recovery !== undefined || options.transition !== undefined) &&
    options.marketplace === true
  )
    throw new Error(
      'recovery and transition bundles cannot be wrapped in a marketplace',
    );
  const pluginPrefix = options.marketplace === true ? 'pappra/' : '';
  const pluginRoot =
    options.marketplace === true ? join(outRoot, 'pappra') : outRoot;
  const hookSource = join(
    getPackageRoot(),
    'dist/hosts/integration/pappra-hook.mjs',
  );
  const payload = await loadHostBundle(options.host, options.packageVersion, {
    hookSource,
    hookExpression: pluginHookExpression(options.host),
  });
  const written: string[] = [];

  if (options.bootstrap !== undefined) {
    const bootstrap = options.bootstrap;
    let artifact: Buffer;
    try {
      artifact = await readFile(bootstrap.artifactPath);
    } catch {
      throw new Error(
        `bootstrap extension artifact is missing: ${bootstrap.artifactPath}; build the package first`,
      );
    }
    if (options.marketplace === true)
      throw new Error('bootstrap bundles cannot be wrapped in a marketplace');
    const staged = await beginBootstrapOutput(options.outDir);
    let claim: FinalClaim | null = null;
    try {
      const writeEntry = async (
        path: string,
        bytes: Buffer,
        mode?: number,
      ): Promise<void> => {
        const target = join(staged.stagePath, ...path.split('/'));
        if (!isPathInside(staged.stagePath, target))
          throw new Error(`Unsafe plugin bundle path: ${path}`);
        await assertStage(staged);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await assertStage(staged);
        await writeFile(
          target,
          bytes,
          mode === undefined ? undefined : { mode },
        );
        await assertStage(staged);
        written.push(path);
      };
      for (const [path, bytes] of payload.contents) {
        if (!path.startsWith('skills/')) continue;
        await writeEntry(path, bytes);
      }
      await writeEntry(`${BOOTSTRAP_EXTENSION_DIR}/index.ts`, bootstrapEntry());
      await writeEntry(`${BOOTSTRAP_EXTENSION_DIR}/runtime.mjs`, artifact);
      await writeEntry(
        'package.json',
        Buffer.from(
          `${JSON.stringify(bootstrapManifest(options.packageVersion), null, 2)}\n`,
        ),
      );
      // The private binding is written last so a staging substitution is detected before it.
      await writeEntry(
        `${BOOTSTRAP_EXTENSION_DIR}/bootstrap.json`,
        bootstrap.configBytes,
        0o600,
      );
      claim = await claimFinal(staged);
      await publishStage(staged, claim);
    } catch (error) {
      await discardStage(staged);
      if (claim !== null) await releaseClaim(staged, claim);
      throw error;
    }
    return {
      host: options.host,
      outDir: staged.finalPath,
      files: written.sort((left, right) => left.localeCompare(right)),
      pluginManifest: 'package.json',
      hookConfig: null,
      registration: [
        'Install the directory as a Pi package only after reviewing the private binding; Pappra does not install or trust it.',
        'Loading is not enforced gating; check the read-only bootstrap status before any model work.',
      ],
      verification: 'unsupported',
      bootstrap: {
        schema: bootstrap.config.schema,
        configDigest: bootstrap.configDigest,
        mode: 'deny-until-completed-transfer',
        registeredByExport: false,
      },
    };
  }
  if (options.recovery !== undefined || options.transition !== undefined) {
    let recoveryBytes: Buffer | null = null;
    let recoverySchema: string | null = null;
    let recoveryDigest: string | null = null;
    if (options.recovery !== undefined) {
      if (!isAbsolute(options.recovery.configFile))
        throw new Error('recovery config path must be absolute');
      const validated = readPiRecoveryConfig(options.recovery.configFile);
      if (!validated.ok)
        throw new Error(`recovery config is invalid (${validated.code})`);
      const pinned = readBoundedFile(options.recovery.configFile, 64 * 1024);
      if (!pinned.ok || pinned.digest !== validated.digest)
        throw new Error(
          'recovery config changed or became unreadable during validation',
        );
      recoveryBytes = pinned.bytes;
      recoverySchema = validated.config.schema;
      recoveryDigest = validated.digest;
    }

    let recoveryArtifact: Buffer | null = null;
    let transitionArtifact: Buffer | null = null;
    try {
      if (options.recovery !== undefined)
        recoveryArtifact = await readFile(options.recovery.artifactPath);
      if (options.transition !== undefined)
        transitionArtifact = await readFile(options.transition.artifactPath);
    } catch {
      throw new Error(
        'an opt-in Pi extension artifact is missing; build the package before exporting',
      );
    }

    const staged = await beginBootstrapOutput(options.outDir);
    let claim: FinalClaim | null = null;
    const extensionPaths: string[] = [];
    try {
      const writeEntry = async (
        path: string,
        bytes: Buffer,
        mode?: number,
      ): Promise<void> => {
        const target = join(staged.stagePath, ...path.split('/'));
        if (!isPathInside(staged.stagePath, target))
          throw new Error(`Unsafe plugin bundle path: ${path}`);
        await assertStage(staged);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await assertStage(staged);
        await writeFile(
          target,
          bytes,
          mode === undefined ? undefined : { mode },
        );
        await assertStage(staged);
        written.push(path);
      };

      for (const [path, bytes] of payload.contents) {
        if (path.startsWith('skills/')) await writeEntry(path, bytes);
      }
      if (recoveryArtifact !== null) {
        const directory = 'extensions/pappra-recovery';
        await writeEntry(
          `${directory}/index.ts`,
          piExtensionEntry('runtime.mjs'),
        );
        await writeEntry(`${directory}/runtime.mjs`, recoveryArtifact);
        extensionPaths.push(`./${directory}/index.ts`);
      }
      if (transitionArtifact !== null) {
        const directory = 'extensions/pappra-session-transition';
        await writeEntry(
          `${directory}/index.ts`,
          piExtensionEntry('runtime.mjs'),
        );
        await writeEntry(`${directory}/runtime.mjs`, transitionArtifact);
        extensionPaths.push(`./${directory}/index.ts`);
      }
      await writeEntry(
        'package.json',
        Buffer.from(
          `${JSON.stringify(
            piExtensionManifest(options.packageVersion, extensionPaths),
            null,
            2,
          )}\n`,
        ),
      );
      if (recoveryBytes !== null)
        await writeEntry(
          'extensions/pappra-recovery/recovery.json',
          recoveryBytes,
          0o600,
        );
      claim = await claimFinal(staged);
      await publishStage(staged, claim);
    } catch (error) {
      await discardStage(staged);
      if (claim !== null) await releaseClaim(staged, claim);
      throw error;
    }

    const registration = [
      'Review and install this opt-in Pi package explicitly; export does not register, trust, enable or launch it.',
      ...(recoveryArtifact === null
        ? []
        : [
            'Recovery requires the explicitly selected private task config and only runs on supported observed startup/settled/manual triggers; no reconnect event or generic outage recovery is claimed.',
          ]),
      ...(transitionArtifact === null
        ? []
        : [
            'The transition command remains blocked without native quiescence proof; task retirement is not native session archive or automatic takeover.',
          ]),
    ];
    return {
      host: 'pi',
      outDir: staged.finalPath,
      files: written.sort((left, right) => left.localeCompare(right)),
      pluginManifest: 'package.json',
      hookConfig: null,
      registration,
      verification: 'unsupported',
      ...(recoverySchema === null || recoveryDigest === null
        ? {}
        : {
            recovery: {
              schema: recoverySchema,
              configDigest: recoveryDigest,
              registeredByExport: false as const,
            },
          }),
      ...(transitionArtifact === null
        ? {}
        : {
            transition: {
              registeredByExport: false as const,
              nativeQuiescence: 'unavailable' as const,
            },
          }),
    };
  }

  const writeEntry = async (path: string, bytes: Buffer): Promise<void> => {
    const target = join(outRoot, ...path.split('/'));
    if (!isPathInside(outRoot, target)) {
      throw new Error(`Unsafe plugin bundle path: ${path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    written.push(path);
  };
  for (const [path, bytes] of payload.contents) {
    // Plugin manifests point at hooks/hooks.json directly; the rendered
    // templates are only an intermediate artifact.
    if (path.startsWith('templates/')) continue;
    await writeEntry(`${pluginPrefix}${path}`, bytes);
  }
  const expression = pluginHookExpression(options.host);
  if (options.host === 'pi') {
    const entry = payload.contents.get('templates/pi/entry.ts');
    const runtime = payload.contents.get('templates/pi/runtime.mjs');
    if (entry === undefined || runtime === undefined) {
      throw new Error('Pi plugin bundle is missing its extension entry.');
    }
    // The generated entry imports ./runtime.mjs, so both files share one directory.
    await writeEntry(`${pluginPrefix}extensions/pappra/index.ts`, entry);
    await writeEntry(`${pluginPrefix}extensions/pappra/runtime.mjs`, runtime);
  } else {
    const patch = renderHookConfigPatch(options.host, expression);
    await writeEntry(
      `${pluginPrefix}hooks/hooks.json`,
      Buffer.from(`${JSON.stringify(patch, null, 2)}\n`),
    );
  }
  const manifest = hostManifest(options.host, options.packageVersion);
  await writeEntry(
    `${pluginPrefix}${manifest.path}`,
    Buffer.from(`${JSON.stringify(manifest.value, null, 2)}\n`),
  );
  if (options.marketplace === true) {
    await writeEntry(
      '.claude-plugin/marketplace.json',
      Buffer.from(
        `${JSON.stringify(
          {
            name: 'pappra-local',
            owner: { name: 'phyzess' },
            description:
              'Local Pappra plugin marketplace exported by pappra host bundle.',
            plugins: [
              {
                name: 'pappra',
                source: './pappra',
                description:
                  'Portable workspace knowledge and continuity for coding agents.',
                author: { name: 'phyzess' },
              },
            ],
          },
          null,
          2,
        )}\n`,
      ),
    );
  }
  return {
    host: options.host,
    outDir: pluginRoot,
    files: written.sort((left, right) => left.localeCompare(right)),
    pluginManifest: `${pluginPrefix}${manifest.path}`,
    hookConfig:
      options.host === 'pi' ? null : `${pluginPrefix}hooks/hooks.json`,
    registration:
      options.host === 'claude'
        ? [
            'Register the directory as a local plugin or marketplace entry; Pappra does not add it to host settings.',
            'Claude Code substitutes ${CLAUDE_PLUGIN_ROOT} at hook execution time.',
          ]
        : options.host === 'codex'
          ? [
              'Package the directory as a Codex plugin; hook paths are relative to the plugin root.',
              'Review the plugin before trusting it; Pappra does not install or trust it.',
            ]
          : [
              'Install the directory as a Pi package, for example `pi install ./pappra-pi`.',
              'Pi installs package dependencies and requires project trust before loading.',
            ],
    verification: 'unsupported',
  };
}
