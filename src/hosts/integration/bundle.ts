import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  HostBundle,
  HostBundleFile,
  HostName,
} from '../../schemas/host.js';
import { HOST_BUNDLE_SCHEMA } from '../../schemas/host.js';
import { sha256Digest } from '../../infra/fs.js';
import { renderHostTemplate } from './templates.js';

export const SHARED_SKILL_ID = 'pappra';

export interface HostBundlePayload {
  readonly bundle: HostBundle;
  readonly contents: ReadonlyMap<string, Buffer>;
}

function packageRoot(): string {
  return dirname(fileURLToPath(import.meta.resolve('pappra/package.json')));
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

export function installPathForBundleFile(
  host: HostName,
  sourcePath: string,
): string {
  if (host === 'pi' && sourcePath === 'templates/pi/entry.ts') {
    return 'extensions/pappra/index.ts';
  }
  return sourcePath;
}

/**
 * Loads the complete shared skill plus the generated host template. The
 * digest covers every packaged support file and the exact native template.
 */
export async function loadHostBundle(
  host: HostName,
  packageVersion: string,
  options: {
    readonly assetsRoot?: string;
    readonly runtimeEntry?: string;
    readonly observedAt?: string;
  } = {},
): Promise<HostBundlePayload> {
  const root =
    options.assetsRoot ?? join(packageRoot(), 'assets', 'integrations');
  const skillRoot = join(root, 'skills', SHARED_SKILL_ID);
  const paths = await listFiles(skillRoot);
  if (paths.length === 0) {
    throw new Error(`No packaged skill files found in ${skillRoot}`);
  }
  const contents = new Map<string, Buffer>();
  const files: HostBundleFile[] = [];
  for (const path of paths) {
    const source = portableRelative(root, path);
    if (source.includes('..') || source.startsWith('/')) {
      throw new Error(`Unsafe packaged skill path: ${source}`);
    }
    const bytes = await readFile(path);
    contents.set(source, bytes);
    files.push({
      path: source,
      digest: sha256Digest(bytes),
      kind: source.endsWith('/SKILL.md') ? 'skill' : 'reference',
    });
  }
  const template = renderHostTemplate(
    host,
    options.runtimeEntry ??
      join(packageRoot(), 'dist/hosts/integration/hook-entry.js'),
  );
  contents.set(template.path, template.bytes);
  files.push({
    path: template.path,
    digest: sha256Digest(template.bytes),
    kind: template.kind,
  });
  files.sort((left, right) => left.path.localeCompare(right.path));
  const bundleDigest = sha256Digest(
    files.map((file) => `${file.path}\0${file.digest}`).join('\n'),
  );
  const observedAt = options.observedAt ?? new Date().toISOString();
  return {
    bundle: {
      schema: HOST_BUNDLE_SCHEMA,
      host,
      skillId: SHARED_SKILL_ID,
      packageVersion,
      bundleDigest,
      files,
      observedAt,
    },
    contents,
  };
}
