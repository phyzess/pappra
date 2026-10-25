import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const REQUIRED_NODE_MAJOR = 24;
const DIST_ENTRY = join('dist', 'cli', 'main.js');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function errorCodeOrUnknown(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return 'unknown';
  }
  const code = error.code;
  return typeof code === 'string' ? code : 'unknown';
}

type LstatOutcome =
  | { readonly kind: 'present'; readonly stats: Stats }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly code: string };

/**
 * `missing` means ENOENT and nothing else. Any other failure stays an explicit
 * error so it can never be read as an absent path that authorizes a write.
 */
function lstatOutcome(path: string): LstatOutcome {
  try {
    return { kind: 'present', stats: lstatSync(path) };
  } catch (error) {
    const code = errorCodeOrUnknown(error);
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'error', code };
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function readlinkOrNull(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

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

export function skillAliasPaths(
  root: string,
  host: HostSkillDir,
): SkillAliasPaths {
  const configDir = HOST_SKILL_DIRS[host];
  const skillsDir = join(root, configDir, 'skills');
  return { host, configDir, skillsDir, linkPath: join(skillsDir, 'pappra') };
}

function parentRefusal(
  path: string,
  label: string,
): { readonly detail: string } | null {
  const outcome = lstatOutcome(path);
  if (outcome.kind === 'missing') return null;
  if (outcome.kind === 'error') {
    return { detail: `cannot inspect ${label} (${outcome.code})` };
  }
  if (outcome.stats.isSymbolicLink()) {
    return { detail: `${label} is a symlink; refusing to write through it` };
  }
  if (!outcome.stats.isDirectory()) {
    return { detail: `${label} is not a directory` };
  }
  return null;
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

export interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliDeps {
  readonly runCli: (args: readonly string[]) => CliResult;
}

/** Runs this repository's built CLI; never a global installation. */
export function runDistCli(root: string, args: readonly string[]): CliResult {
  const result = spawnSync(
    process.execPath,
    [join(root, DIST_ENTRY), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      timeout: 300_000,
      env: { ...process.env, NO_COLOR: '1' },
    },
  );
  if (result.error) {
    return { status: null, stdout: '', stderr: result.error.message };
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function defaultDeps(root: string): CliDeps {
  return { runCli: (args) => runDistCli(root, args) };
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

export type CheckState = 'ok' | 'action' | 'blocked';

export interface SelfHostCheck {
  readonly id: string;
  readonly state: CheckState;
  readonly detail: string;
  readonly command: string | null;
}

function firstLine(text: string): string {
  const trimmed = text.trim();
  const [line] = trimmed.split('\n');
  return line === undefined ? '' : line.trim();
}

function failureDetail(
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

interface DocsCheckSummary {
  readonly total: number;
  readonly current: number;
  readonly needsReview: number;
  readonly unknown: number;
}

interface DocsCheckReport {
  readonly ok: boolean;
  readonly summary: DocsCheckSummary;
  readonly errors: readonly string[];
}

/**
 * `pappra/docs-check/1` sets `ok: false` for a non-current catalog as well as for
 * errors (`ok = no error diagnostic && current === total`). Classification must
 * come from the report contract, never from `ok` alone.
 */
function parseDocsCheckReport(
  payload: Record<string, unknown>,
): DocsCheckReport | null {
  if (payload['schema'] !== 'pappra/docs-check/1') return null;
  const ok = payload['ok'];
  if (typeof ok !== 'boolean') return null;
  const diagnostics = payload['diagnostics'];
  if (!Array.isArray(diagnostics)) return null;
  const errors: string[] = [];
  for (const entry of diagnostics) {
    if (!isRecord(entry)) return null;
    const severity = entry['severity'];
    if (severity !== 'error' && severity !== 'warning' && severity !== 'info') {
      return null;
    }
    if (severity !== 'error') continue;
    errors.push(
      `${stringOrNull(entry['code']) ?? 'error'}${
        stringOrNull(entry['message']) === null
          ? ''
          : `: ${stringOrNull(entry['message'])}`
      }`,
    );
  }
  const summary = payload['summary'];
  if (!isRecord(summary)) return null;
  const count = (name: string): number | null => {
    const value = summary[name];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;
  };
  const total = count('total');
  const current = count('current');
  const needsReview = count('needsReview');
  const unknown = count('unknown');
  if (
    total === null ||
    current === null ||
    needsReview === null ||
    unknown === null ||
    current + needsReview + unknown !== total
  ) {
    return null;
  }
  return { ok, summary: { total, current, needsReview, unknown }, errors };
}

function docsCheckContractDetail(payload: Record<string, unknown>): string {
  const code = stringOrNull(payload['code']);
  const message = stringOrNull(payload['message']);
  if (code !== null || message !== null) {
    return `pappra docs check reported ${code ?? 'an error'}${
      message === null ? '' : `: ${message}`
    }`;
  }
  if (!isRecord(payload['summary'])) {
    return 'pappra docs check summary is incomplete; registration is unknown';
  }
  if (!Array.isArray(payload['diagnostics'])) {
    return 'pappra docs check diagnostics are missing or invalid; review state is unknown';
  }
  return 'pappra docs check reported an unexpected result; registration is unknown';
}

function docsCheck(
  root: string,
  admission: Admission,
  deps: CliDeps,
): SelfHostCheck {
  const id = 'docs-registration';
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
      detail: 'needs the built repository CLI to verify workspace documents',
      command: 'pnpm build',
    };
  }
  const scan = deps.runCli(['docs', 'scan', '--json']);
  const scanPayload = parseJsonObject(scan.stdout);
  if (scanPayload === null || scanPayload['ok'] !== true) {
    return {
      id,
      state: 'blocked',
      detail: failureDetail('pappra docs scan', scanPayload, scan),
      command: `node ${DIST_ENTRY} docs scan`,
    };
  }
  const candidates = scanPayload['candidates'];
  if (!Array.isArray(candidates)) {
    return {
      id,
      state: 'blocked',
      detail:
        'pappra docs scan payload has no candidate list; registration is unknown',
      command: `node ${DIST_ENTRY} docs scan`,
    };
  }
  if (candidates.length > 0) {
    return {
      id,
      state: 'action',
      detail: `${candidates.length} workspace document(s) are unregistered`,
      command: 'pnpm dev:setup',
    };
  }
  // This workspace registers private documents, so the shared-only catalog would
  // report 'current (0 of 0)' and hide the real review state.
  const check = deps.runCli(['docs', 'check', '--include-private', '--json']);
  const checkPayload = parseJsonObject(check.stdout);
  if (checkPayload === null) {
    return {
      id,
      state: 'blocked',
      detail: failureDetail('pappra docs check', null, check),
      command: `node ${DIST_ENTRY} docs check --include-private`,
    };
  }
  const report = parseDocsCheckReport(checkPayload);
  if (report === null) {
    return {
      id,
      state: 'blocked',
      detail: docsCheckContractDetail(checkPayload),
      command: `node ${DIST_ENTRY} docs check --include-private`,
    };
  }
  if (report.errors.length > 0) {
    return {
      id,
      state: 'blocked',
      detail: `pappra docs check reported ${report.errors.join('; ')}`,
      command: `node ${DIST_ENTRY} docs check --include-private`,
    };
  }
  const { total, current, needsReview, unknown } = report.summary;
  if (needsReview > 0 || unknown > 0) {
    return {
      id,
      state: 'action',
      detail: `${needsReview + unknown} of ${total} registered or private document(s) need review (${needsReview} changed, ${unknown} unknown); review them explicitly, this entry never forgets or re-approves them`,
      command: `node ${DIST_ENTRY} docs list --include-private --json`,
    };
  }
  if (!report.ok) {
    return {
      id,
      state: 'blocked',
      detail:
        'pappra docs check reported a non-current result with a fully current summary; registration is inconsistent',
      command: `node ${DIST_ENTRY} docs check --include-private`,
    };
  }
  return {
    id,
    state: 'ok',
    detail: `registered and private documents current (${current} of ${total})`,
    command: null,
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

function applyCodeIndex(
  repositoryId: string,
  deps: CliDeps,
  actions: string[],
): void {
  const plan = deps.runCli([
    'code',
    'prepare',
    '--repo',
    repositoryId,
    '--json',
  ]);
  const payload = parseJsonObject(plan.stdout);
  const body = payload?.['plan'];
  const action =
    payload !== null && payload['ok'] === true && isRecord(body)
      ? stringOrNull(body['action'])
      : null;
  if (action === null) {
    actions.push(
      `code prepare ${repositoryId}: plan not actionable, apply skipped (${failureDetail('code prepare', payload, plan)})`,
    );
    return;
  }
  if (action === 'none') return;
  const applied = deps.runCli([
    'code',
    'prepare',
    '--repo',
    repositoryId,
    '--apply',
    '--json',
  ]);
  const appliedPayload = parseJsonObject(applied.stdout);
  const status =
    appliedPayload !== null && appliedPayload['ok'] === true
      ? stringOrNull(appliedPayload['status'])
      : null;
  actions.push(
    `code prepare ${repositoryId}: ${
      status ?? failureDetail('code prepare --apply', appliedPayload, applied)
    }`,
  );
}

function applyDocs(deps: CliDeps, actions: string[]): void {
  const scan = deps.runCli(['docs', 'scan', '--json']);
  const payload = parseJsonObject(scan.stdout);
  const candidates = payload?.['candidates'];
  if (
    payload === null ||
    payload['ok'] !== true ||
    !Array.isArray(candidates)
  ) {
    actions.push(
      `docs scan: registration skipped (${failureDetail('docs scan', payload, scan)})`,
    );
    return;
  }
  if (candidates.length === 0) return;
  const applied = deps.runCli(['docs', 'scan', '--apply', '--json']);
  const appliedPayload = parseJsonObject(applied.stdout);
  const registered = appliedPayload?.['registered'];
  if (
    appliedPayload === null ||
    appliedPayload['ok'] !== true ||
    !Array.isArray(registered)
  ) {
    actions.push(
      `docs scan --apply: ${failureDetail(
        'docs scan --apply',
        appliedPayload,
        applied,
      )}`,
    );
    return;
  }
  actions.push(
    `docs scan --apply: ${registered.length} of ${candidates.length} candidate(s) registered`,
  );
}

/**
 * Converges only what this entry owns. Admission is required before the first
 * write: an unrelated root, missing or redirected source, or a workspace that
 * does not select this repository with `codegraph` performs no writes and no
 * mutating child at all.
 */
export function applyFixes(
  root: string,
  deps: CliDeps = defaultDeps(root),
): readonly string[] {
  const admission = admit(root);
  if (!admission.ok) return [];
  const actions = [...applySkillAliases(root)];
  if (!existsSync(join(root, DIST_ENTRY))) return actions;
  applyCodeIndex(admission.repositoryId, deps, actions);
  applyDocs(deps, actions);
  return actions;
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

export interface EntryOptions {
  readonly apply: boolean;
  readonly json: boolean;
}

export function parseEntryOptions(
  argv: readonly string[],
): EntryOptions | null {
  const allowed = new Set(['--check', '--apply', '--json']);
  const unknown = argv.find((arg) => !allowed.has(arg));
  if (unknown !== undefined) return null;
  const apply = argv.includes('--apply');
  if (apply && argv.includes('--check')) return null;
  return { apply, json: argv.includes('--json') };
}

export function runSelfHost(
  root: string,
  options: EntryOptions,
  deps: CliDeps = defaultDeps(root),
): number {
  const actions = options.apply ? applyFixes(root, deps) : [];
  const checks = collectChecks(root, deps);
  const converged = checks.every((check) => check.state === 'ok');
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ checks, actions, converged }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(formatChecks(checks, actions));
  }
  return converged ? 0 : 1;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  const options = parseEntryOptions(process.argv.slice(2));
  if (options === null) {
    process.stderr.write(
      'self-host: use --check (default), --apply and optionally --json\n',
    );
    process.exitCode = 2;
  } else {
    process.exitCode = runSelfHost(process.cwd(), options);
  }
}
