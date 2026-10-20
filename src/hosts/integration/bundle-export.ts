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
}): Promise<HostPluginBundle> {
  const outRoot = resolve(options.outDir);
  if (options.marketplace === true && options.host === 'pi') {
    throw new Error(
      'Pi installs a directory directly; a marketplace wrapper is not supported.',
    );
  }
  const pluginPrefix = options.marketplace === true ? 'pappra/' : '';
  const pluginRoot =
    options.marketplace === true ? join(outRoot, 'pappra') : outRoot;
  const payload = await loadHostBundle(options.host, options.packageVersion, {
    hookSource: join(
      getPackageRoot(),
      'dist/hosts/integration/pappra-hook.mjs',
    ),
    hookExpression: pluginHookExpression(options.host),
  });
  const written: string[] = [];
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
