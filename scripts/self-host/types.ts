/**
 * Shared contracts for the self-host entry. This base module never imports a
 * sibling: it holds the constants, the public types and the narrow JSON/payload
 * helpers every other self-host module needs, so no layer has to import upward.
 */

/** Source-first skill directory tracked in this repository. */
export const SKILL_SOURCE = 'skills/pappra';
/** Alias target as written into `<host-config>/skills/pappra`. */
export const SKILL_ALIAS_TARGET = '../../skills/pappra';
export const PACKAGE_NAME = '@phyzess/pappra';
export const CANONICAL_SKILL_FILE = `${SKILL_SOURCE}/SKILL.md`;

export const HOST_SKILL_DIRS = {
  agents: '.agents',
  pi: '.pi',
  claude: '.claude',
} as const;

export type HostSkillDir = keyof typeof HOST_SKILL_DIRS;

export const HOST_SKILL_ORDER: readonly HostSkillDir[] = [
  'agents',
  'pi',
  'claude',
];

export const REQUIRED_NODE_MAJOR = 24;
export const DIST_ENTRY = 'dist/cli/main.js';

export interface SkillAliasPaths {
  readonly host: HostSkillDir;
  readonly configDir: string;
  readonly skillsDir: string;
  readonly linkPath: string;
}

export type SkillAliasState =
  | { readonly kind: 'missing'; readonly paths: SkillAliasPaths }
  | { readonly kind: 'linked'; readonly paths: SkillAliasPaths }
  | {
      readonly kind: 'conflict';
      readonly paths: SkillAliasPaths;
      readonly detail: string;
    }
  | {
      readonly kind: 'refused';
      readonly paths: SkillAliasPaths;
      readonly detail: string;
    };

export type AdmissionCheckId = 'repository-admission' | 'workspace-selection';

export type Admission =
  | {
      readonly ok: true;
      readonly workspaceId: string | null;
      readonly repositoryId: string;
      readonly graph: string;
      readonly prepare: string | null;
    }
  | {
      readonly ok: false;
      readonly check: AdmissionCheckId;
      readonly detail: string;
      readonly command: string | null;
    };

export interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliDeps {
  readonly runCli: (args: readonly string[]) => CliResult;
}

export type CheckState = 'ok' | 'action' | 'blocked';

export interface SelfHostCheck {
  readonly id: string;
  readonly state: CheckState;
  readonly detail: string;
  readonly command: string | null;
}

export interface EntryOptions {
  readonly apply: boolean;
  readonly json: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Parses a CLI payload as an object, or reports it as unreadable. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function firstLine(text: string): string {
  const trimmed = text.trim();
  const [line] = trimmed.split('\n');
  return line === undefined ? '' : line.trim();
}

export function failureDetail(
  label: string,
  payload: Record<string, unknown> | null,
  result: CliResult,
): string {
  if (payload !== null) {
    const code = stringOrNull(payload['code']);
    const message = stringOrNull(payload['message']);
    if (code !== null || message !== null) {
      return `${label} reported ${code ?? 'an error'}${
        message === null ? '' : `: ${message}`
      }`;
    }
  }
  const diagnostic = firstLine(result.stderr);
  if (diagnostic !== '') return `${label} failed: ${diagnostic}`;
  return payload === null
    ? `${label} returned no readable JSON`
    : `${label} returned an unexpected result`;
}
