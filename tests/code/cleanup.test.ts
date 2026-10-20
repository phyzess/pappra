import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { CodeIntelligenceService } from '../../src/code/index.js';
import { writeCodeRegistration } from '../../src/code/registration.js';
import type { Diagnostic } from '../../src/schemas/diagnostics.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  createRepository,
  makeTempDir,
  writeMachineConfig,
  writeText,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

function makeRepo(): string {
  const root = makeTempDir('code-cleanup');
  writeWorkspaceConfig(
    root,
    baseWorkspaceConfig({
      repositories: [{ id: 'app', path: '.', access: 'write' }],
    }),
  );
  writeMachineConfig(root, baseMachineConfig(root));
  createRepository(root);
  writeText(join(root, 'a.ts'), 'export const alpha = 1;\n');
  return root;
}

test('partial registration write preserves a same-inode user edit', async () => {
  const root = makeRepo();
  const originalOpen = fs.open;
  let temporaryPath: string | null = null;
  try {
    const registration = {
      schema: 'pappra/code-index-registration/1' as const,
      repositoryId: 'app',
      identityDigest: `sha256:${'a'.repeat(64)}`,
      checkoutId: 'checkout',
      root,
      engineVersion: '1.4.1',
      configDigest: `sha256:${'b'.repeat(64)}`,
      preparedAt: new Date().toISOString(),
      coverage: {
        scope: 'selected-repository' as const,
        languages: [],
        semantic: false,
        callGraph: false,
        note: 'test',
      },
    };
    fs.open = (async (
      path: Parameters<typeof fs.open>[0],
      flags: Parameters<typeof fs.open>[1],
      mode?: Parameters<typeof fs.open>[2],
    ): Promise<FileHandle> => {
      const handle = await originalOpen(path, flags, mode);
      if (typeof path !== 'string' || !path.includes('app.json.tmp-')) {
        return handle;
      }
      temporaryPath = path;
      return new Proxy(handle, {
        get(target, key, receiver) {
          if (key === 'writeFile') {
            return async () => {
              await target.writeFile('partial write');
              writeFileSync(path, 'USER_EDIT_AFTER_PARTIAL_WRITE\n');
              throw Object.assign(new Error('injected write failure'), {
                code: 'EIO',
              });
            };
          }
          const value = Reflect.get(target, key, receiver) as unknown;
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    }) as typeof fs.open;
    syncBuiltinESMExports();
    const result = await writeCodeRegistration(root, registration);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('expected registration write failure');
    assert.notEqual(temporaryPath, null);
    assert(result.message.includes(temporaryPath!));
    assert(result.nextAction?.includes(temporaryPath!) ?? false);
    assert(result.message.includes('content_changed'));
    assert(!result.message.includes('USER_EDIT_AFTER_PARTIAL_WRITE'));
    assert.equal(
      readFileSync(temporaryPath!, 'utf8'),
      'USER_EDIT_AFTER_PARTIAL_WRITE\n',
    );
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
    cleanup(root);
  }
});

test('owned prefix cleanup and successful publication do not claim residuals', async () => {
  const root = makeRepo();
  const registration = {
    schema: 'pappra/code-index-registration/1' as const,
    repositoryId: 'app',
    identityDigest: `sha256:${'a'.repeat(64)}`,
    checkoutId: 'checkout',
    root,
    engineVersion: '1.4.1',
    configDigest: `sha256:${'b'.repeat(64)}`,
    preparedAt: new Date().toISOString(),
    coverage: {
      scope: 'selected-repository' as const,
      languages: [],
      semantic: false,
      callGraph: false,
      note: 'test',
    },
  };
  const directory = join(root, '.pappra', 'local', 'code');
  const originalOpen = fs.open;
  let temporaryPath: string | null = null;
  try {
    fs.open = (async (
      path: Parameters<typeof fs.open>[0],
      flags: Parameters<typeof fs.open>[1],
      mode?: Parameters<typeof fs.open>[2],
    ): Promise<FileHandle> => {
      const handle = await originalOpen(path, flags, mode);
      if (typeof path !== 'string' || !path.includes('app.json.tmp-')) {
        return handle;
      }
      temporaryPath = path;
      return new Proxy(handle, {
        get(target, key, receiver) {
          if (key === 'writeFile') {
            return async () => {
              await target.writeFile('{\n  "schema"');
              throw Object.assign(new Error('injected prefix failure'), {
                code: 'EIO',
              });
            };
          }
          const value = Reflect.get(target, key, receiver) as unknown;
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    }) as typeof fs.open;
    syncBuiltinESMExports();
    const failed = await writeCodeRegistration(root, registration);
    assert.equal(failed.ok, false);
    if (failed.ok) throw new Error('expected prefix write failure');
    assert.notEqual(temporaryPath, null);
    assert(!failed.message.includes(temporaryPath!));
    assert(!(failed.nextAction?.includes(temporaryPath!) ?? false));
    assert(!existsSync(temporaryPath!));

    fs.open = originalOpen;
    syncBuiltinESMExports();
    const published = await writeCodeRegistration(root, registration);
    assert.equal(published.ok, true);
    assert(!readdirSync(directory).some((name) => name.includes('.tmp-')));
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
    cleanup(root);
  }
});

test('service prepare surfaces a preserved lock conflict in its public result', async () => {
  const root = makeRepo();
  const originalPath = process.env.PATH;
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, 'codegraph');
  writeFileSync(
    fake,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const [command, ...args] = process.argv.slice(2);
if (command === '--version') { console.log('1.4.1'); process.exit(0); }
const root = args.at(-1), index = path.join(root, '.codegraph'), marker = path.join(index, 'marker');
if (command !== 'status') {
  fs.mkdirSync(index, { recursive: true });
  fs.writeFileSync(marker, 'ready');
  fs.writeFileSync(path.join(root, '.pappra', 'local', 'code', 'prepare.lock'), 'USER_EDIT_DURING_PREPARE\\n');
}
console.log(JSON.stringify({
  initialized: fs.existsSync(marker), version: '1.4.1', projectPath: root, indexPath: index,
  lastIndexed: '2026-10-19T00:00:00Z', languages: ['typescript'], edgeCount: 1,
  pendingChanges: { added: 0, modified: 0, removed: 0 },
  index: { state: 'complete', pendingRefs: 0, builtWithVersion: '1.4.1' }
}));
`,
  );
  chmodSync(fake, 0o755);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  try {
    const result = await new CodeIntelligenceService(root).prepare({
      root,
      repositoryId: 'app',
      apply: true,
      rebuild: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'partial');
    assert(
      result.diagnostics.some(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          'code' in entry &&
          entry.code === 'code_prepare_conflict',
      ),
    );
    assert.equal(
      readFileSync(
        join(root, '.pappra', 'local', 'code', 'prepare.lock'),
        'utf8',
      ),
      'USER_EDIT_DURING_PREPARE\n',
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(bin, { recursive: true, force: true });
    cleanup(root);
  }
});

test('service prepare reports the preserved registration temporary path', async () => {
  const root = makeRepo();
  const originalPath = process.env.PATH;
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, 'codegraph');
  writeFileSync(
    fake,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const [command, ...args] = process.argv.slice(2);
if (command === '--version') { console.log('1.4.1'); process.exit(0); }
const root = args.at(-1), index = path.join(root, '.codegraph'), marker = path.join(index, 'marker');
if (command !== 'status') {
  fs.mkdirSync(index, { recursive: true });
  fs.writeFileSync(marker, 'ready');
}
console.log(JSON.stringify({
  initialized: fs.existsSync(marker), version: '1.4.1', projectPath: root, indexPath: index,
  lastIndexed: '2026-10-19T00:00:00Z', languages: ['typescript'], edgeCount: 1,
  pendingChanges: { added: 0, modified: 0, removed: 0 },
  index: { state: 'complete', pendingRefs: 0, builtWithVersion: '1.4.1' }
}));
`,
  );
  chmodSync(fake, 0o755);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  const originalOpen = fs.open;
  let temporaryPath: string | null = null;
  try {
    fs.open = (async (
      path: Parameters<typeof fs.open>[0],
      flags: Parameters<typeof fs.open>[1],
      mode?: Parameters<typeof fs.open>[2],
    ): Promise<FileHandle> => {
      const handle = await originalOpen(path, flags, mode);
      if (typeof path !== 'string' || !path.includes('app.json.tmp-')) {
        return handle;
      }
      temporaryPath = path;
      return new Proxy(handle, {
        get(target, key, receiver) {
          if (key === 'writeFile') {
            return async () => {
              await target.writeFile('partial write');
              writeFileSync(path, 'USER_EDIT_DURING_PREPARE\n');
              throw Object.assign(new Error('injected write failure'), {
                code: 'EIO',
              });
            };
          }
          const value = Reflect.get(target, key, receiver) as unknown;
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    }) as typeof fs.open;
    syncBuiltinESMExports();
    const result = await new CodeIntelligenceService(root).prepare({
      root,
      repositoryId: 'app',
      apply: true,
      rebuild: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'partial');
    assert.notEqual(temporaryPath, null);
    const diagnostic = result.diagnostics.find(
      (entry): entry is Diagnostic =>
        typeof entry === 'object' &&
        entry !== null &&
        'code' in entry &&
        entry.code === 'code_prepare_partial',
    );
    assert.notEqual(diagnostic, undefined);
    assert(diagnostic!.message.includes(temporaryPath!));
    assert(diagnostic!.message.includes('injected write failure'));
    assert(diagnostic!.message.includes('content_changed'));
    assert(diagnostic!.hint?.includes(temporaryPath!) ?? false);
    assert.equal(
      readFileSync(temporaryPath!, 'utf8'),
      'USER_EDIT_DURING_PREPARE\n',
    );
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
    process.env.PATH = originalPath;
    rmSync(bin, { recursive: true, force: true });
    cleanup(root);
  }
});
