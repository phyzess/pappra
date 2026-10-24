import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { listFiles, projectRoot } from './project.js';

const sources = ['src', 'tests', 'scripts', 'integrations', 'templates']
  .map((directory) => join(projectRoot, directory))
  .filter((directory) => existsSync(directory))
  .flatMap(listFiles);
const forbidden = sources.filter((file) => /\.(?:js|mjs|cjs|jsx)$/.test(file));
const escapes: string[] = [];
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
      /^src\/(?:workspace|knowledge|continuity|code|schemas)\//.test(source) &&
      /^src\/(?:app|hosts|collab|adapters)\//.test(target)
    )
      escapes.push(
        `${edge}: core/schema depends on an upper integration layer`,
      );
    if (
      source.startsWith('src/hosts/') &&
      (target.startsWith('src/app/') || target.startsWith('src/adapters/'))
    )
      escapes.push(`${edge}: native hosts depend on upper orchestration`);
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
