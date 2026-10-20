import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
}

if (forbidden.length > 0 || escapes.length > 0) {
  console.error(
    `Source policy failed:\n${[...forbidden, ...escapes].join('\n')}`,
  );
  process.exitCode = 1;
} else {
  console.log('Source language policy passed.');
}
