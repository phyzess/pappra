import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { npmCli } from '../../scripts/project.js';
import { getPackageInfo } from '../../src/package-info.js';
import { testSubprocessEnvironment } from '../../scripts/test-environment.js';

export function makeTempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pappra-${label}-`));
}

export function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export interface RuntimeTarballOptions {
  readonly version: string;
  readonly packageName?: string;
  readonly markerPath?: string;
  readonly executionMarkerPath?: string;
}

export function createRuntimeTarball(
  root: string,
  options: RuntimeTarballOptions,
): string {
  const packageDir = join(root, 'runtime-package');
  const packageName = options.packageName ?? getPackageInfo().name;
  mkdirSync(join(packageDir, 'dist', 'cli'), { recursive: true });
  const installScript =
    options.markerPath === undefined
      ? undefined
      : `node -e "require('node:fs').writeFileSync(${JSON.stringify(options.markerPath)}, 'ran')"`;
  writeFileSync(
    join(packageDir, 'package.json'),
    `${JSON.stringify(
      {
        name: packageName,
        version: options.version,
        type: 'module',
        bin: { pappra: 'dist/cli/main.js' },
        files: ['dist'],
        ...(installScript === undefined
          ? {}
          : { scripts: { postinstall: installScript } }),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(packageDir, 'dist', 'cli', 'main.js'),
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const version = ${JSON.stringify(options.version)};
${
  options.executionMarkerPath === undefined
    ? ''
    : `writeFileSync(${JSON.stringify(options.executionMarkerPath)}, 'executed');`
}
if (process.argv.includes('--version')) {
  process.stdout.write(JSON.stringify({ name: ${JSON.stringify(packageName)}, version }) + '\\n');
} else {
  process.stdout.write(version + '\\n');
}
`,
  );
  const packed = spawnSync(
    process.execPath,
    [
      npmCli(),
      'pack',
      '--ignore-scripts',
      '--pack-destination',
      root,
      packageDir,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: testSubprocessEnvironment(),
    },
  );
  if (packed.error) throw packed.error;
  if (packed.status !== 0) {
    throw new Error(`npm pack failed: ${packed.stderr}`);
  }
  const filename = packed.stdout.trim().split('\n').at(-1);
  if (filename === undefined)
    throw new Error('npm pack did not report a file.');
  return join(root, filename);
}
