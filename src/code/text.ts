import { join } from 'node:path';
import { runGit } from '../infra/git.js';
import { observePath, readFileBounded, sha256Digest } from '../infra/fs.js';
import { isPathInside } from '../schemas/paths.js';
import { ensureCodeMutationBoundary } from './registration.js';
import { diagnosticCodes } from '../schemas/errors.js';
import { failed, succeeded, type Outcome } from '../schemas/outcome.js';
import type { EvidenceRef } from '../schemas/evidence.js';
import type {
  CodeQueryItem,
  CodeQueryRequest,
  CodeQueryResult,
} from '../schemas/code.js';
import { boundCodeItems } from './budget.js';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILE_COUNT = 5000;
const EXCLUDES = [
  ':(exclude).codegraph',
  ':(exclude).pappra/local',
  ':(exclude).pappra/generated',
];

function lineAt(
  text: string,
  offset: number,
): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.length ?? 0) + 1,
  };
}

function snippetAt(text: string, offset: number, length: number): string {
  const start = Math.max(0, offset - 120);
  const end = Math.min(text.length, offset + length + 160);
  return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 4096);
}

function normalizeRelative(path: string): string | null {
  const normalized = path.replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => part === '..' || part === '')
  ) {
    return null;
  }
  return normalized;
}

function evidenceFor(root: string, path: string, bytes: Buffer): EvidenceRef {
  return {
    kind: 'file',
    ref: join(root, path),
    digest: sha256Digest(bytes),
    observedAt: new Date().toISOString(),
    scope: 'live-owned',
  };
}

function structureMatches(text: string, query: string): CodeQueryItem[] {
  const items: CodeQueryItem[] = [];
  const pattern =
    /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    if (
      name === undefined ||
      !name.toLowerCase().includes(query.toLowerCase())
    ) {
      continue;
    }
    const offset = match.index ?? 0;
    const location = lineAt(text, offset);
    items.push({
      path: '',
      line: location.line,
      column: location.column,
      kind: 'symbol',
      name,
      snippet: snippetAt(text, offset, match[0].length),
      source: 'structure',
    });
  }
  return items;
}

export async function runTextQuery(
  request: CodeQueryRequest,
  mode: 'text' | 'structure',
  signal?: AbortSignal,
): Promise<Outcome<CodeQueryResult>> {
  const root = request.identity.root;
  const protectedRoots = [
    join(root, '.pappra', 'local'),
    join(root, '.pappra', 'generated'),
    ...(request.excludedRoots ?? []),
  ];
  const list = await runGit({
    cwd: root,
    args: [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      '.',
      ...EXCLUDES,
    ],
    timeoutMs: 10_000,
    maxOutputBytes: 2 * 1024 * 1024,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!list.ok) {
    return failed(
      diagnosticCodes.code_query_invalid,
      `Cannot list selected repository files: ${list.message}`,
      { nextAction: 'Inspect Git availability and the selected repository.' },
    );
  }
  const paths = [...new Set(list.value.stdout.split('\0').filter(Boolean))]
    .map(normalizeRelative)
    .filter((path): path is string => path !== null)
    .slice(0, Math.min(request.limits.maxFiles, MAX_FILE_COUNT));
  const items: CodeQueryItem[] = [];
  const evidence: EvidenceRef[] = [];
  const reasons: string[] = [];
  let bytes = 0;
  let truncated =
    list.value.stdout.split('\0').filter(Boolean).length > paths.length;
  for (const path of paths) {
    if (
      items.length >= request.limits.maxResults ||
      bytes >= request.limits.maxBytes
    ) {
      truncated = true;
      break;
    }
    const absolute = join(root, path);
    if (!isPathInside(root, absolute)) {
      reasons.push('path_unsafe');
      continue;
    }
    if (
      (request.excludedRoots ?? []).some((excluded) =>
        isPathInside(excluded, absolute),
      )
    ) {
      continue;
    }
    const boundary = await ensureCodeMutationBoundary(
      root,
      absolute,
      protectedRoots,
    );
    if (!boundary.ok) {
      reasons.push('canonical_path_unsafe');
      continue;
    }
    const observation = await observePath(absolute).catch(() => null);
    if (observation === null || observation.kind !== 'file') {
      reasons.push('non_regular_skipped');
      continue;
    }
    const read = await readFileBounded(absolute, MAX_FILE_BYTES);
    if (!read.ok) {
      reasons.push('file_unreadable_or_large');
      continue;
    }
    if (read.value.bytes.includes(0)) {
      reasons.push('binary_skipped');
      continue;
    }
    bytes += read.value.size;
    if (bytes > request.limits.maxBytes) {
      bytes = request.limits.maxBytes;
      truncated = true;
      break;
    }
    const text = read.value.bytes.toString('utf8');
    if (mode === 'text') {
      const lower = text.toLowerCase();
      const needle = request.query.toLowerCase();
      let offset = lower.indexOf(needle);
      while (offset !== -1 && items.length < request.limits.maxResults) {
        const location = lineAt(text, offset);
        items.push({
          path,
          line: location.line,
          column: location.column,
          kind: 'text',
          name: null,
          snippet: snippetAt(text, offset, request.query.length),
          source: 'text',
        });
        offset = lower.indexOf(needle, offset + Math.max(1, needle.length));
      }
      if (offset !== -1) truncated = true;
    } else {
      const matches = structureMatches(text, request.query);
      for (const match of matches) {
        if (items.length >= request.limits.maxResults) {
          truncated = true;
          break;
        }
        items.push({ ...match, path });
      }
    }
    if (items.some((item) => item.path === path)) {
      evidence.push(evidenceFor(root, path, read.value.bytes));
    }
  }
  const bounded = boundCodeItems(
    items,
    request.limits.maxBytes,
    request.limits.maxResults,
    request.limits.maxFiles,
  );
  const includedEvidence = new Set(
    bounded.items.map((item) => join(root, item.path)),
  );
  return succeeded({
    schema: 'pappra/code-query-result/1',
    provider: mode,
    kind: request.kind,
    query: request.query,
    identityDigest: sha256Digest(JSON.stringify(request.identity)),
    observedIdentity: request.identity,
    coverage:
      truncated || bounded.truncated || reasons.length > 0
        ? 'partial'
        : 'fallback',
    items: bounded.items,
    bytes: bounded.bytes,
    truncated: truncated || bounded.truncated,
    reasons: [...new Set([...reasons, ...bounded.reasons])].slice(0, 16),
    evidence: evidence
      .filter((entry) => includedEvidence.has(entry.ref))
      .slice(0, 32),
    unsupportedReason:
      mode === 'structure'
        ? 'Structural fallback is a bounded declaration scan, not a semantic symbol index.'
        : 'Text fallback scans bounded working-tree files, not the CodeGraph index.',
  });
}
