import { basename, isAbsolute } from 'node:path';
import type { HostName, HostLifecycleEvent } from '../../schemas/host.js';

export const PAPPRA_MANAGED_MARKER = 'pappra-managed';
// Covers bounded stdin collection plus lifecycle work and process startup.
export const MIN_HOOK_TIMEOUT_SECONDS = 5;

export interface RenderedHostTemplate {
  readonly path: string;
  readonly bytes: Buffer;
  readonly kind: 'extension' | 'hook';
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Host placeholders such as ${CLAUDE_PROJECT_DIR} only expand inside double
 * quotes; absolute paths are single-quoted to survive spaces and quotes.
 */
function pathExpression(value: string): string {
  return value.includes('${') ? `"${value}"` : shellQuote(value);
}

export function renderHookCommand(
  host: HostName,
  event: HostLifecycleEvent,
  hookExpression: string,
): string {
  return `node ${pathExpression(hookExpression)} ${shellQuote(host)} ${shellQuote(event)} # ${PAPPRA_MANAGED_MARKER}`;
}

/** Recognizes only our exact script/host/event/marker suffix and a Node runner. */
export function isManagedHookCommand(
  command: string,
  expectedCommands: ReadonlySet<string>,
): boolean {
  for (const expected of expectedCommands) {
    if (command === expected) return true;
    const suffix = expected.slice('node'.length);
    if (!command.endsWith(suffix)) continue;
    const runner = command.slice(0, -suffix.length);
    // Previous packages single-quoted process.execPath. Recognize that one
    // shell word without interpreting arbitrary shell syntax or user commands.
    if (!/^'(?:[^']|'\\'')*'$/.test(runner)) continue;
    const executable = runner.slice(1, -1).replaceAll("'\\''", "'");
    if (
      isAbsolute(executable) &&
      ['node', 'node.exe'].includes(basename(executable))
    ) {
      return true;
    }
  }
  return false;
}

interface HookEntry {
  readonly hooks: readonly {
    readonly type: 'command';
    readonly command: string;
    readonly timeout: number;
  }[];
}

export function renderHookConfigPatch(
  host: 'codex' | 'claude',
  hookExpression: string,
): { readonly hooks: Record<string, readonly HookEntry[]> } {
  const entry = (event: HostLifecycleEvent): HookEntry => ({
    hooks: [
      {
        type: 'command',
        command: renderHookCommand(host, event, hookExpression),
        timeout: MIN_HOOK_TIMEOUT_SECONDS,
      },
    ],
  });
  return host === 'claude'
    ? {
        hooks: {
          SessionStart: [entry('startup')],
          PostCompact: [entry('compact')],
        },
      }
    : {
        hooks: {
          SessionStart: [entry('startup')],
        },
      };
}

export function renderHostTemplate(
  host: HostName,
  hookExpression: string,
): RenderedHostTemplate {
  if (host === 'pi') {
    const source = `/**
 * Generated Pappra Pi extension. It registers bounded local lifecycle handlers;
 * it does not start processes, models, network requests or background work.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiExtension } from "./runtime.mjs";

export default function (pi: ExtensionAPI): void {
  createPiExtension(pi);
}
`;
    return {
      path: 'templates/pi/entry.ts',
      bytes: Buffer.from(source),
      kind: 'extension',
    };
  }
  const patch = renderHookConfigPatch(host, hookExpression);
  return {
    path: `templates/${host}/hooks.json`,
    bytes: Buffer.from(`${JSON.stringify(patch, null, 2)}\n`),
    kind: 'hook',
  };
}

export function hostConfigRelativePath(
  host: HostName,
): 'settings.json' | 'hooks.json' | null {
  if (host === 'claude') return 'settings.json';
  if (host === 'codex') return 'hooks.json';
  return null;
}

export function hostConfigName(host: HostName): string {
  const path = hostConfigRelativePath(host);
  return path === null ? 'pi-extension' : basename(path);
}
