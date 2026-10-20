import type { CodeQueryItem } from '../schemas/code.js';

export interface BoundedCodeItems {
  readonly items: CodeQueryItem[];
  readonly bytes: number;
  readonly truncated: boolean;
  readonly reasons: string[];
}

function itemBytes(item: CodeQueryItem): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

/**
 * Bounds emitted item JSON, not source bytes scanned. `bytes` is the sum of
 * item JSON bytes; the fixed result envelope (object keys and array brackets)
 * is not counted. A budget below the first item leaves an empty, truncated
 * result rather than silently exceeding the caller's byte ceiling.
 */
export function boundCodeItems(
  items: readonly CodeQueryItem[],
  maxBytes: number,
  maxResults: number,
  maxFiles: number,
): BoundedCodeItems {
  const selected: CodeQueryItem[] = [];
  const paths = new Set<string>();
  const reasons: string[] = [];
  let bytes = 0;
  for (const item of items) {
    if (selected.length >= maxResults) {
      reasons.push('result_limit');
      break;
    }
    if (!paths.has(item.path) && paths.size >= maxFiles) {
      reasons.push('file_limit');
      break;
    }
    const size = itemBytes(item);
    if (bytes + size > maxBytes) {
      reasons.push('output_budget');
      break;
    }
    selected.push(item);
    paths.add(item.path);
    bytes += size;
  }
  return {
    items: selected,
    bytes,
    truncated: selected.length < items.length || reasons.length > 0,
    reasons: [...new Set(reasons)].slice(0, 16),
  };
}
