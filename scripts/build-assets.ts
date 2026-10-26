import { chmodSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { build, type BuildOptions } from 'esbuild';
import { projectRoot } from './project.js';

// Pi provides these packages to extensions; they must not be bundled.
const hostExternals = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
  'typebox',
];

const hostRuntime = join(projectRoot, 'dist/hosts/integration');
const adapters = join(projectRoot, 'dist/adapters/pi');

mkdirSync(join(projectRoot, 'assets'), { recursive: true });
cpSync(join(projectRoot, 'src/assets'), join(projectRoot, 'assets'), {
  recursive: true,
});
chmodSync(join(projectRoot, 'dist/cli/main.js'), 0o755);

// Five standalone host bundles. Each keeps its own entry and outfile, so the
// builds are independent: no splitting and no shared chunk.
const bundles = [
  {
    entry: join(hostRuntime, 'hook-entry.js'),
    outfile: join(hostRuntime, 'pappra-hook.mjs'),
    external: null,
  },
  {
    entry: join(hostRuntime, 'pi-extension-runtime.js'),
    outfile: join(hostRuntime, 'pappra-extension-runtime.mjs'),
    external: hostExternals,
  },
  {
    entry: join(hostRuntime, 'pi-bootstrap-extension.js'),
    outfile: join(hostRuntime, 'pappra-bootstrap-extension.mjs'),
    external: hostExternals,
  },
  {
    entry: join(adapters, 'recovery-extension.js'),
    outfile: join(hostRuntime, 'pappra-recovery-extension.mjs'),
    external: hostExternals,
  },
  {
    entry: join(adapters, 'session-transition-extension.js'),
    outfile: join(hostRuntime, 'pappra-session-transition-extension.mjs'),
    external: hostExternals,
  },
];

const common = {
  absWorkingDir: projectRoot,
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'silent',
} satisfies BuildOptions;

await Promise.all(
  bundles.map(({ entry, outfile, external }) =>
    build({
      ...common,
      entryPoints: [entry],
      outfile,
      ...(external === null ? {} : { external }),
    }),
  ),
);
