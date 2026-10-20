import { chmodSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { projectRoot } from './project.js';

mkdirSync(join(projectRoot, 'assets'), { recursive: true });
cpSync(join(projectRoot, 'src/assets'), join(projectRoot, 'assets'), {
  recursive: true,
});
chmodSync(join(projectRoot, 'dist/cli/main.js'), 0o755);

const hostRuntime = join(projectRoot, 'dist/hosts/integration');
await build({
  entryPoints: [join(hostRuntime, 'hook-entry.js')],
  outfile: join(hostRuntime, 'pappra-hook.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'silent',
});
await build({
  entryPoints: [join(hostRuntime, 'pi-extension-runtime.js')],
  outfile: join(hostRuntime, 'pappra-extension-runtime.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'silent',
  // Pi provides these packages to extensions; they must not be bundled.
  external: [
    '@earendil-works/pi-ai',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-tui',
    'typebox',
  ],
});
