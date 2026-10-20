import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { getPackageRoot } from '../../package-info.js';
import type { HostName } from '../../schemas/host.js';
import { isPathInside } from '../../schemas/paths.js';
import { loadHostBundle } from './bundle.js';
import { renderHookConfigPatch } from './templates.js';

export interface HostPluginBundle {
  readonly host: HostName;
  readonly outDir: string;
  readonly files: readonly string[];
  readonly pluginManifest: string;
  readonly hookConfig: string | null;
  readonly registration: readonly string[];
  /** Plugin registration and native callability are not verified here. */
  readonly verification: 'unsupported';
}

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
  if (host === 'claude') {
    return {
      path: '.claude-plugin/plugin.json',
      value: {
        name: 'pappra',
        version,
        description:
          'Portable workspace knowledge and continuity for coding agents.',
        hooks: './hooks/hooks.json',
      },
    };
  }
  if (host === 'codex') {
    return {
      path: 'plugin.json',
      value: {
        name: 'pappra',
        version,
        description:
          'Portable workspace knowledge and continuity for coding agents.',
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
}): Promise<HostPluginBundle> {
  const outDir = resolve(options.outDir);
  const payload = await loadHostBundle(options.host, options.packageVersion, {
    hookSource: join(
      getPackageRoot(),
      'dist/hosts/integration/pappra-hook.mjs',
    ),
    hookExpression: pluginHookExpression(options.host),
  });
  const written: string[] = [];
  const writeEntry = async (path: string, bytes: Buffer): Promise<void> => {
    const target = join(outDir, ...path.split('/'));
    if (!isPathInside(outDir, target)) {
      throw new Error(`Unsafe plugin bundle path: ${path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    written.push(path);
  };
  for (const [path, bytes] of payload.contents) {
    // Plugin manifests point at hooks/hooks.json directly; the rendered
    // templates are only an intermediate artifact.
    if (options.host !== 'pi' && path.startsWith('templates/')) continue;
    await writeEntry(path, bytes);
  }
  const expression = pluginHookExpression(options.host);
  if (options.host === 'pi') {
    const entry = payload.contents.get('templates/pi/entry.ts');
    if (entry === undefined) {
      throw new Error('Pi plugin bundle is missing its extension entry.');
    }
    await writeEntry('extensions/pappra/index.ts', entry);
  } else {
    const patch = renderHookConfigPatch(options.host, expression);
    await writeEntry(
      'hooks/hooks.json',
      Buffer.from(`${JSON.stringify(patch, null, 2)}\n`),
    );
  }
  const manifest = hostManifest(options.host, options.packageVersion);
  await writeEntry(
    manifest.path,
    Buffer.from(`${JSON.stringify(manifest.value, null, 2)}\n`),
  );
  return {
    host: options.host,
    outDir,
    files: written.sort((left, right) => left.localeCompare(right)),
    pluginManifest: manifest.path,
    hookConfig: options.host === 'pi' ? null : 'hooks/hooks.json',
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
