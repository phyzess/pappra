import { basename } from 'node:path';
import type { HostName, HostLifecycleEvent } from '../../schemas/host.js';

export const PAPPRA_MANAGED_MARKER = 'pappra-managed';

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
  return `${shellQuote(process.execPath)} ${pathExpression(hookExpression)} ${shellQuote(host)} ${shellQuote(event)} # ${PAPPRA_MANAGED_MARKER}`;
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
        timeout: 1,
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
