import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  CANONICAL_SKILL_FILE,
  DIST_ENTRY,
  HOST_SKILL_DIRS,
  HOST_SKILL_ORDER,
  PACKAGE_NAME,
  REQUIRED_NODE_MAJOR,
  SKILL_ALIAS_TARGET,
  isRecord,
  stringOrNull,
  failureDetail,
  parseJsonObject,
  type Admission,
  type AdmissionCheckId,
  type CheckState,
  type CliDeps,
  type HostSkillDir,
  type SelfHostCheck,
} from './types.ts';
import { admit } from './admission.ts';
import { inspectSkillAlias } from './aliases.ts';
import { docsCheck } from './documents.ts';
import { defaultDeps } from './cli.ts';

function nodeCheck(): SelfHostCheck {
  const [major] = process.versions.node.split('.');
  const version = major === undefined ? 0 : Number.parseInt(major, 10);
  return {
    id: 'node-version',
    state: version >= REQUIRED_NODE_MAJOR ? 'ok' : 'blocked',
    detail:
      version >= REQUIRED_NODE_MAJOR
        ? `node ${process.versions.node}`
        : `node ${process.versions.node} is below the pinned >=${REQUIRED_NODE_MAJOR}`,
    command: version >= REQUIRED_NODE_MAJOR ? null : 'node --version',
  };
}

function admissionEntry(
  admission: Admission,
  id: AdmissionCheckId,
): SelfHostCheck {
  if (admission.ok) {
    return id === 'repository-admission'
      ? {
          id,
          state: 'ok',
          detail: `canonical ${CANONICAL_SKILL_FILE} and package ${PACKAGE_NAME}`,
          command: null,
        }
      : {
          id,
          state: 'ok',
          detail: `workspace ${
            admission.workspaceId ?? '(unset id)'
          } repository ${admission.repositoryId} engine ${
            admission.graph
          } prepare ${admission.prepare ?? '(unset)'}`,
          command: null,
        };
  }
  return admission.check === id
    ? {
        id,
        state: 'blocked',
        detail: admission.detail,
        command: admission.command,
      }
    : {
        id,
        state: 'blocked',
        detail: 'not evaluated: repository admission must pass first',
        command: null,
      };
}

function distCheck(root: string): SelfHostCheck {
  const present = existsSync(join(root, DIST_ENTRY));
  return {
    id: 'dist-cli',
    state: present ? 'ok' : 'blocked',
    detail: present
      ? `repository CLI ${DIST_ENTRY}`
      : `${DIST_ENTRY} is missing; this entry uses the repository CLI, not a global pappra`,
    command: present ? null : 'pnpm build',
  };
}

function engineCheck(root: string): SelfHostCheck {
  const result = spawnSync('codegraph', ['--version'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    timeout: 60_000,
  });
  const match =
    result.error === undefined && result.status === 0
      ? /([0-9]+\.[0-9]+\.[0-9]+)/.exec(
          `${result.stdout ?? ''}${result.stderr ?? ''}`,
        )
      : null;
  const version = match?.[1] ?? null;
  return {
    id: 'codegraph-engine',
    state: version === null ? 'blocked' : 'ok',
    detail:
      version === null
        ? 'codegraph is not callable on PATH; the workspace selects the codegraph engine'
        : `codegraph ${version} is on PATH`,
    command: version === null ? 'codegraph --version' : null,
  };
}

function skillCheck(root: string, host: HostSkillDir): SelfHostCheck {
  const state = inspectSkillAlias(root, host);
  const id = `skill-alias:${HOST_SKILL_DIRS[host]}`;
  switch (state.kind) {
    case 'linked':
      return {
        id,
        state: 'ok',
        detail: `${relative(root, state.paths.linkPath)} -> ${SKILL_ALIAS_TARGET}`,
        command: null,
      };
    case 'missing':
      return {
        id,
        state: 'action',
        detail: `${relative(root, state.paths.linkPath)} is missing`,
        command: 'pnpm dev:setup',
      };
    case 'conflict':
      return { id, state: 'blocked', detail: state.detail, command: null };
    case 'refused':
      return { id, state: 'blocked', detail: state.detail, command: null };
  }
}

function codeIndexCheck(
  root: string,
  admission: Admission,
  deps: CliDeps,
): SelfHostCheck {
  const id = 'code-index';
  if (!admission.ok) {
    return {
      id,
      state: 'blocked',
      detail: 'not evaluated: repository admission must pass first',
      command: null,
    };
  }
  if (!existsSync(join(root, DIST_ENTRY))) {
    return {
      id,
      state: 'blocked',
      detail: 'needs the built repository CLI to inspect the index',
      command: 'pnpm build',
    };
  }
  const result = deps.runCli([
    'code',
    'status',
    '--repo',
    admission.repositoryId,
    '--json',
  ]);
  const payload = parseJsonObject(result.stdout);
  if (payload === null) {
    return {
      id,
      state: 'blocked',
      detail: failureDetail('pappra code status', null, result),
      command: `node ${DIST_ENTRY} code status --repo ${admission.repositoryId}`,
    };
  }
  const health = payload['health'];
  const state = isRecord(health) ? stringOrNull(health['state']) : null;
  const rawReasons = isRecord(health) ? health['reasons'] : undefined;
  if (state === null || !Array.isArray(rawReasons)) {
    return {
      id,
      state: 'blocked',
      detail: `pappra code status has no explicit health state: ${failureDetail('code status', payload, result)}`,
      command: `node ${DIST_ENTRY} code status --repo ${admission.repositoryId}`,
    };
  }
  if (state === 'ready') {
    const identity = payload['identity'];
    const engine = isRecord(identity) ? identity['engine'] : undefined;
    const engineId = isRecord(engine) ? stringOrNull(engine['id']) : null;
    const engineVersion = isRecord(engine)
      ? stringOrNull(engine['version'])
      : null;
    return {
      id,
      state: 'ok',
      detail: `${admission.repositoryId} index ready via ${
        engineId ?? 'unknown engine'
      } ${engineVersion ?? ''}`.trim(),
      command: null,
    };
  }
  const reasons = rawReasons.filter(
    (reason): reason is string => typeof reason === 'string',
  );
  return {
    id,
    state: 'action',
    detail: `${admission.repositoryId} index state ${state}${
      reasons.length === 0 ? '' : `: ${reasons.join(', ')}`
    }`,
    command: 'pnpm dev:setup',
  };
}

/** Read-only: every child it runs is a status query or a plan. */
export function collectChecks(
  root: string,
  deps: CliDeps = defaultDeps(root),
): readonly SelfHostCheck[] {
  const admission = admit(root);
  const checks: SelfHostCheck[] = [
    nodeCheck(),
    admissionEntry(admission, 'repository-admission'),
    admissionEntry(admission, 'workspace-selection'),
    distCheck(root),
    engineCheck(root),
  ];
  for (const host of HOST_SKILL_ORDER) checks.push(skillCheck(root, host));
  checks.push(codeIndexCheck(root, admission, deps));
  checks.push(docsCheck(root, admission, deps));
  return checks;
}

export function formatChecks(
  checks: readonly SelfHostCheck[],
  actions: readonly string[],
): string {
  const label = (state: CheckState): string =>
    state === 'ok' ? 'ok' : state === 'action' ? 'action' : 'blocked';
  const lines = checks.map(
    (check) =>
      `${label(check.state)} ${check.id}: ${check.detail}${
        check.command === null ? '' : `\n  next: ${check.command}`
      }`,
  );
  if (actions.length > 0) {
    lines.push('applied:', ...actions.map((action) => `  ${action}`));
  }
  const pending = checks.filter((check) => check.state !== 'ok').length;
  lines.push(
    pending === 0
      ? 'project entry converged: no pending action'
      : `${pending} check(s) need attention; this entry never installs, trusts or edits global host configuration`,
  );
  return `${lines.join('\n')}\n`;
}
