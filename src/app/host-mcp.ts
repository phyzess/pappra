import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import type { HostName } from '../schemas/host.js';
import { observePath, readTextFileBounded } from '../infra/fs.js';
import {
  ensureStatePathBoundary,
  writeJsonAtomic,
} from '../install/ownership.js';

const MCP_ENTRY = { command: 'pappra', args: ['mcp'] } as const;

export type HostMcpState = 'create' | 'unchanged' | 'conflict' | 'manual';

export interface HostMcpPlan {
  readonly host: HostName;
  readonly target: string | null;
  readonly state: HostMcpState;
  readonly entry: typeof MCP_ENTRY;
  readonly command: readonly string[] | null;
  readonly message: string;
}

export interface HostMcpResult extends HostMcpPlan {
  readonly applied: boolean;
  readonly verified: boolean;
  readonly detail: string | null;
}

function mcpConfigPath(host: HostName, root: string): string | null {
  if (host === 'claude') return `${root}/.mcp.json`;
  if (host === 'pi') return `${root}/.pi/mcp.json`;
  return null;
}

function sameEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const args = record['args'];
  return (
    record['command'] === MCP_ENTRY.command &&
    Array.isArray(args) &&
    args.length === MCP_ENTRY.args.length &&
    args.every((arg, index) => arg === MCP_ENTRY.args[index])
  );
}

async function readConfig(
  path: string,
  root: string,
): Promise<
  | {
      readonly ok: true;
      readonly value: Record<string, unknown>;
      readonly exists: boolean;
    }
  | { readonly ok: false; readonly message: string }
> {
  let text: string;
  try {
    const boundary = await ensureStatePathBoundary(root, path);
    if (!boundary.ok) return { ok: false, message: boundary.message };
    const observation = await observePath(path);
    if (observation.kind === 'missing') {
      return { ok: true, value: {}, exists: false };
    }
    if (observation.kind !== 'file') {
      return {
        ok: false,
        message: `MCP config is not a regular file: ${path}`,
      };
    }
    const read = await readTextFileBounded(path);
    if (!read.ok) return { ok: false, message: read.message };
    text = read.value.text;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return { ok: true, value: {}, exists: false };
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, message: 'MCP config is not a JSON object.' };
    }
    return { ok: true, value: value as Record<string, unknown>, exists: true };
  } catch (error) {
    return {
      ok: false,
      message: `MCP config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function planHostMcp(
  host: HostName,
  root: string,
): Promise<HostMcpPlan> {
  if (host === 'codex') {
    return {
      host,
      target: null,
      state: 'manual',
      entry: MCP_ENTRY,
      command: ['codex', 'mcp', 'add', 'pappra', '--', 'pappra', 'mcp'],
      message:
        'Codex MCP servers are user-scoped; pappra prints the host command instead of merging TOML.',
    };
  }
  const target = mcpConfigPath(host, root);
  if (target === null) {
    return {
      host,
      target: null,
      state: 'manual',
      entry: MCP_ENTRY,
      command: null,
      message: `No MCP registration is defined for ${host}.`,
    };
  }
  const config = await readConfig(target, root);
  if (!config.ok) {
    return {
      host,
      target,
      state: 'conflict',
      entry: MCP_ENTRY,
      command: null,
      message: config.message,
    };
  }
  const servers = config.value['mcpServers'];
  if (
    servers !== undefined &&
    (typeof servers !== 'object' || servers === null || Array.isArray(servers))
  ) {
    return {
      host,
      target,
      state: 'conflict',
      entry: MCP_ENTRY,
      command: null,
      message: 'mcpServers must be a JSON object.',
    };
  }
  const existing =
    typeof servers === 'object' && servers !== null
      ? (servers as Record<string, unknown>)['pappra']
      : undefined;
  const state: HostMcpState =
    existing === undefined
      ? 'create'
      : sameEntry(existing)
        ? 'unchanged'
        : 'conflict';
  return {
    host,
    target,
    state,
    entry: MCP_ENTRY,
    command: null,
    message:
      state === 'create'
        ? `Register pappra in ${target}.`
        : state === 'unchanged'
          ? 'pappra is already registered.'
          : 'A different pappra MCP entry exists; use --force to replace it.',
  };
}

export async function applyHostMcp(
  plan: HostMcpPlan,
  options: { readonly force: boolean },
): Promise<HostMcpResult> {
  if (plan.state === 'manual') {
    if (plan.host === 'codex' && plan.command !== null) {
      const result = spawnSync(plan.command[0]!, plan.command.slice(1), {
        encoding: 'utf8',
        shell: false,
        timeout: 60_000,
      });
      const verified = await verifyHostMcp(plan);
      return {
        ...plan,
        applied: result.status === 0,
        verified: verified.verified,
        detail:
          result.status === 0
            ? null
            : `${result.stdout ?? ''}${result.stderr ?? ''}`
                .trim()
                .slice(0, 1000),
      };
    }
    return {
      ...plan,
      applied: false,
      verified: false,
      detail: plan.message,
    };
  }
  if (plan.state === 'conflict' && !options.force) {
    return { ...plan, applied: false, verified: false, detail: plan.message };
  }
  const target = plan.target;
  if (target === null) {
    return { ...plan, applied: false, verified: false, detail: plan.message };
  }
  const root = plan.host === 'pi' ? dirname(dirname(target)) : dirname(target);
  const config = await readConfig(target, root);
  if (!config.ok) {
    return { ...plan, applied: false, verified: false, detail: config.message };
  }
  const servers = config.value['mcpServers'];
  const nextServers: Record<string, unknown> = {
    ...(typeof servers === 'object' && servers !== null
      ? (servers as Record<string, unknown>)
      : {}),
    pappra: MCP_ENTRY,
  };
  const written = await writeJsonAtomic(
    target,
    { ...config.value, mcpServers: nextServers },
    root,
  );
  if (!written.ok) {
    return {
      ...plan,
      applied: false,
      verified: false,
      detail: written.message,
    };
  }
  const verified = await verifyHostMcp(plan);
  return {
    ...plan,
    state: 'unchanged',
    applied: true,
    verified: verified.verified,
    detail: null,
  };
}

export async function verifyHostMcp(plan: HostMcpPlan): Promise<HostMcpResult> {
  if (plan.host === 'codex') {
    const listed = spawnSync('codex', ['mcp', 'list', '--json'], {
      encoding: 'utf8',
      shell: false,
      timeout: 60_000,
    });
    if (listed.status !== 0) {
      return {
        ...plan,
        applied: false,
        verified: false,
        detail: `${listed.stdout ?? ''}${listed.stderr ?? ''}`
          .trim()
          .slice(0, 1000),
      };
    }
    try {
      const value: unknown = JSON.parse(listed.stdout);
      const found =
        Array.isArray(value) &&
        value.some(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            'name' in item &&
            item.name === 'pappra',
        );
      return { ...plan, applied: false, verified: found, detail: null };
    } catch (error) {
      return {
        ...plan,
        applied: false,
        verified: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (plan.target === null) {
    return { ...plan, applied: false, verified: false, detail: plan.message };
  }
  const root =
    plan.host === 'pi' ? dirname(dirname(plan.target)) : dirname(plan.target);
  const config = await readConfig(plan.target, root);
  if (!config.ok) {
    return { ...plan, applied: false, verified: false, detail: config.message };
  }
  const servers = config.value['mcpServers'];
  const entry =
    typeof servers === 'object' && servers !== null
      ? (servers as Record<string, unknown>)['pappra']
      : undefined;
  return {
    ...plan,
    applied: false,
    verified: sameEntry(entry),
    detail: null,
  };
}
