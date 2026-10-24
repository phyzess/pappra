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
  absWorkingDir: projectRoot,
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
  absWorkingDir: projectRoot,
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
await build({
  entryPoints: [join(hostRuntime, 'pi-bootstrap-extension.js')],
  absWorkingDir: projectRoot,
  outfile: join(hostRuntime, 'pappra-bootstrap-extension.mjs'),
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
await build({
  entryPoints: [join(hostRuntime, 'pi-recovery-extension.js')],
  absWorkingDir: projectRoot,
  outfile: join(hostRuntime, 'pappra-recovery-extension.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'silent',
  external: [
    '@earendil-works/pi-ai',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-tui',
    'typebox',
  ],
});
await build({
  entryPoints: [join(hostRuntime, 'pi-session-transition-extension.js')],
  absWorkingDir: projectRoot,
  outfile: join(hostRuntime, 'pappra-session-transition-extension.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'silent',
  external: [
    '@earendil-works/pi-ai',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-tui',
    'typebox',
  ],
});
