import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  CANONICAL_SKILL_FILE,
  DIST_ENTRY,
  PACKAGE_NAME,
  isRecord,
  stringOrNull,
  type Admission,
  type AdmissionCheckId,
} from './types.ts';
import { lstatOutcome } from './paths.ts';

function admitFailure(
  check: AdmissionCheckId,
  detail: string,
  command: string | null = null,
): Admission {
  return { ok: false, check, detail, command };
}

function sourceAdmission(root: string): Admission | null {
  let current = root;
  const segments = ['skills', 'pappra', 'SKILL.md'];
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const label = relative(root, current);
    const outcome = lstatOutcome(current);
    const last = index === segments.length - 1;
    const expected = last ? 'regular file' : 'directory';
    if (outcome.kind === 'missing') {
      return admitFailure(
        'repository-admission',
        `canonical source ${CANONICAL_SKILL_FILE} is missing (${label})`,
      );
    }
    if (outcome.kind === 'error') {
      return admitFailure(
        'repository-admission',
        `cannot inspect ${label} (${outcome.code})`,
      );
    }
    if (outcome.stats.isSymbolicLink()) {
      return admitFailure(
        'repository-admission',
        `${label} is a symlink; the canonical source must not be redirected`,
      );
    }
    if (last ? !outcome.stats.isFile() : !outcome.stats.isDirectory()) {
      return admitFailure(
        'repository-admission',
        `${label} is not a ${expected}`,
      );
    }
  }
  return null;
}

function workspaceAdmission(root: string): Admission {
  const workspaceFile = join(root, '.pappra', 'workspace.json');
  const outcome = lstatOutcome(workspaceFile);
  if (outcome.kind === 'missing') {
    return admitFailure(
      'workspace-selection',
      '.pappra/workspace.json is missing; this entry reuses workspace selections and never writes them',
      `node ${DIST_ENTRY} init --no-interactive --apply`,
    );
  }
  if (outcome.kind === 'error') {
    return admitFailure(
      'workspace-selection',
      `cannot inspect .pappra/workspace.json (${outcome.code})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(workspaceFile, 'utf8'));
  } catch {
    return admitFailure(
      'workspace-selection',
      '.pappra/workspace.json is not valid JSON',
      `node ${DIST_ENTRY} init --reconfigure`,
    );
  }
  if (!isRecord(parsed)) {
    return admitFailure(
      'workspace-selection',
      '.pappra/workspace.json is not a JSON object',
      `node ${DIST_ENTRY} init --reconfigure`,
    );
  }
  const code = parsed['code'];
  const repositories = parsed['repositories'];
  if (!isRecord(code) || !Array.isArray(repositories)) {
    return admitFailure(
      'workspace-selection',
      'workspace configuration has no code selection or repository list',
      `node ${DIST_ENTRY} init --reconfigure`,
    );
  }
  const graph = code['graph'];
  if (graph !== 'codegraph') {
    return admitFailure(
      'workspace-selection',
      `workspace graph selection is ${
        typeof graph === 'string' ? graph : '(unset)'
      }; this repository self-hosts on codegraph`,
      `node ${DIST_ENTRY} init --reconfigure`,
    );
  }
  const rootRepository = repositories
    .filter(isRecord)
    .find((entry) => entry['path'] === '.');
  const repositoryId =
    rootRepository === undefined ? null : stringOrNull(rootRepository['id']);
  if (repositoryId === null) {
    return admitFailure(
      'workspace-selection',
      'workspace does not select this root repository with a repository id',
      `node ${DIST_ENTRY} init --reconfigure`,
    );
  }
  return {
    ok: true,
    workspaceId: stringOrNull(parsed['workspaceId']),
    repositoryId,
    graph,
    prepare: stringOrNull(code['prepare']),
  };
}

/**
 * Admission for every write and every mutating child. The workspace file is
 * only read, so workspace id, represented selections, continuity records and
 * runtime binding stay owned by `node dist/cli/main.js init`.
 */
export function admit(root: string): Admission {
  const packageFile = join(root, 'package.json');
  const outcome = lstatOutcome(packageFile);
  if (outcome.kind === 'missing') {
    return admitFailure(
      'repository-admission',
      `${root} has no package.json; run this entry from the repository root`,
      'pnpm dev:check',
    );
  }
  if (outcome.kind === 'error') {
    return admitFailure(
      'repository-admission',
      `cannot inspect package.json (${outcome.code})`,
    );
  }
  if (!outcome.stats.isFile()) {
    return admitFailure(
      'repository-admission',
      'package.json is not a regular file',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageFile, 'utf8'));
  } catch {
    return admitFailure(
      'repository-admission',
      'package.json is not valid JSON',
    );
  }
  if (!isRecord(parsed) || parsed['name'] !== PACKAGE_NAME) {
    return admitFailure(
      'repository-admission',
      `package.json does not identify ${PACKAGE_NAME}; this entry only self-hosts its own repository`,
    );
  }
  const source = sourceAdmission(root);
  return source ?? workspaceAdmission(root);
}
