import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { listFiles, projectRoot } from './project.js';

const sources = ['src', 'tests', 'scripts', 'integrations', 'templates']
  .map((directory) => join(projectRoot, directory))
  .filter((directory) => existsSync(directory))
  .flatMap(listFiles);
const forbidden = sources.filter((file) => /\.(?:js|mjs|cjs|jsx)$/.test(file));
const escapes: string[] = [];
// Existing host/app couplings are migration debt, not permission to add more.
// Remove entries as adapters acquire lower-layer interfaces.
const legacyHostAppEdges = new Set([
  'src/hosts/integration/bootstrap-config.ts -> src/app/bounded-file.ts',
  'src/hosts/integration/bundle-export.ts -> src/app/bounded-file.ts',
  'src/hosts/integration/hook.ts -> src/app/task-pin.ts',
  'src/hosts/integration/pi-bootstrap-runtime.ts -> src/app/bounded-file.ts',
  'src/hosts/integration/pi-recovery-extension.ts -> src/app/bounded-file.ts',
  'src/hosts/integration/pi-recovery-extension.ts -> src/app/collab-recovery-executor.ts',
  'src/hosts/integration/pi-recovery-extension.ts -> src/app/collab-recovery-projection.ts',
  'src/hosts/integration/pi-session-transition-extension.ts -> src/app/collab-session-transition.ts',
  'src/hosts/pi/managed-sdk-session.ts -> src/app/collab-session-transition.ts',
  'src/hosts/pi/managed-sdk-session.ts -> src/app/managed-pi-resume-admission.ts',
  'src/hosts/pi/rpc.ts -> src/app/collab-messages.ts',
]);
for (const file of sources.filter((file) => file.endsWith('.ts'))) {
  const contents = readFileSync(file, 'utf8');
  if (/^\s*\/\/\s*@ts-(?:ignore|nocheck)\b/m.test(contents))
    escapes.push(`${file}: suppressed TypeScript checking`);
  // A lightweight guard for common escapes; strict tsc remains the type authority.
  if (/(?:\bas\s+|[:<|&]\s*)any\b/.test(contents))
    escapes.push(`${file}: explicit any`);
  const source = relative(projectRoot, file).replaceAll('\\', '/');
  if (!source.startsWith('src/')) continue;
  const checkImport = (specifier: string) => {
    if (!specifier.startsWith('.')) return;
    const target = relative(projectRoot, resolve(dirname(file), specifier))
      .replaceAll('\\', '/')
      .replace(/\.js$/, '.ts');
    const edge = `${source} -> ${target}`;
    if (
      source.startsWith('src/hosts/') &&
      target.startsWith('src/app/') &&
      !legacyHostAppEdges.has(edge)
    )
      escapes.push(`${edge}: new hosts-to-app dependency`);
    if (
      source.startsWith('src/infra/') &&
      target.startsWith('src/') &&
      !target.startsWith('src/infra/') &&
      !target.startsWith('src/schemas/')
    )
      escapes.push(`${edge}: infrastructure depends on a higher layer`);
  };
  // Match static imports/re-exports, side-effect imports and literal dynamic imports.
  for (const match of contents.matchAll(
    /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]([^'"]+)['"]/g,
  )) {
    if (match[1] !== undefined) checkImport(match[1]);
  }
}

if (forbidden.length > 0 || escapes.length > 0) {
  console.error(
    `Source policy failed:\n${[...forbidden, ...escapes].join('\n')}`,
  );
  process.exitCode = 1;
} else {
  console.log('Source language policy passed.');
}
