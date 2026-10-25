import { mkdirSync, symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  HOST_SKILL_DIRS,
  HOST_SKILL_ORDER,
  SKILL_ALIAS_TARGET,
  SKILL_SOURCE,
  type HostSkillDir,
  type SkillAliasPaths,
  type SkillAliasState,
} from './types.ts';
import {
  lstatOutcome,
  parentRefusal,
  readlinkOrNull,
  realpathOrNull,
} from './paths.ts';

export function skillAliasPaths(
  root: string,
  host: HostSkillDir,
): SkillAliasPaths {
  const configDir = HOST_SKILL_DIRS[host];
  const skillsDir = join(root, configDir, 'skills');
  return { host, configDir, skillsDir, linkPath: join(skillsDir, 'pappra') };
}

/**
 * Read-only inspection. An alias counts as `linked` only when it resolves to
 * this repository's canonical source; a matching raw target is not enough,
 * because the source may be missing or redirected.
 */
export function inspectSkillAlias(
  root: string,
  host: HostSkillDir,
): SkillAliasState {
  const paths = skillAliasPaths(root, host);
  for (const parent of [
    { label: paths.configDir, path: join(root, paths.configDir) },
    { label: `${paths.configDir}/skills`, path: paths.skillsDir },
  ]) {
    const refusal = parentRefusal(parent.path, parent.label);
    if (refusal !== null) {
      return { kind: 'refused', paths, detail: refusal.detail };
    }
  }
  const outcome = lstatOutcome(paths.linkPath);
  const label = relative(root, paths.linkPath);
  if (outcome.kind === 'missing') return { kind: 'missing', paths };
  if (outcome.kind === 'error') {
    return {
      kind: 'refused',
      paths,
      detail: `cannot inspect ${label} (${outcome.code})`,
    };
  }
  if (!outcome.stats.isSymbolicLink()) {
    return {
      kind: 'conflict',
      paths,
      detail: `${label} is a real path; preserved`,
    };
  }
  const source = realpathOrNull(join(root, SKILL_SOURCE));
  const target = realpathOrNull(paths.linkPath);
  if (source !== null && target === source) return { kind: 'linked', paths };
  const rawTarget = readlinkOrNull(paths.linkPath);
  return {
    kind: 'conflict',
    paths,
    detail: `${label} points at ${
      rawTarget ?? '(unreadable)'
    } but does not resolve to ${SKILL_SOURCE}; preserved`,
  };
}

/** Creates the alias only when it is absent; never rewrites anything else. */
export function applySkillAlias(
  root: string,
  host: HostSkillDir,
): SkillAliasState {
  const state = inspectSkillAlias(root, host);
  if (state.kind !== 'missing') return state;
  mkdirSync(state.paths.skillsDir, { recursive: true });
  symlinkSync(SKILL_ALIAS_TARGET, state.paths.linkPath, 'dir');
  return inspectSkillAlias(root, host);
}

export function applySkillAliases(root: string): readonly string[] {
  const actions: string[] = [];
  for (const host of HOST_SKILL_ORDER) {
    if (inspectSkillAlias(root, host).kind !== 'missing') continue;
    const state = applySkillAlias(root, host);
    const detail = 'detail' in state ? ` (${state.detail})` : '';
    actions.push(
      `${relative(root, state.paths.linkPath)}: ${state.kind}${detail}`,
    );
  }
  return actions;
}
