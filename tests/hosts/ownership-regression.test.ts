import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { HostIntegrationService } from '../../src/hosts/integration/service.js';
import {
  renderHostHookOutput,
  runHostHook,
} from '../../src/hosts/integration/hook.js';
import type { HostHookInput } from '../../src/schemas/host.js';
import {
  baseWorkspaceConfig,
  cleanup,
  makeTempDir,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

function runtimeEntry(): string {
  return join(
    dirname(fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json'))),
    'dist',
    'hosts',
    'integration',
    'hook-entry.js',
  );
}

function workspace(): string {
  const root = makeTempDir('host-r2-regression');
  writeWorkspaceConfig(
    root,
    baseWorkspaceConfig({
      repositories: [{ id: 'app', path: '.', access: 'write' }],
    }),
  );
  return root;
}

function hook(root: string, eventId: string): HostHookInput {
  return {
    schema: 'pappra/host-hook-input/1',
    host: 'claude',
    event: 'startup',
    nativeEvent: 'SessionStart',
    eventId,
    sessionId: 'r2-session',
    cwd: root,
    root: null,
    taskId: null,
    source: 'startup',
    observedAt: '2026-10-19T00:00:00.000Z',
  };
}

test('preserves user edits to managed matcher and timeout', async () => {
  const root = workspace();
  const hostRoot = makeTempDir('host-r2-edited');
  try {
    const service = new HostIntegrationService({
      root,
      homeDir: hostRoot,
      pathEnv: '',
      runtimeEntry: runtimeEntry(),
      hostVersion: '2.1.292',
      observedAt: '2026-10-19T00:00:00.000Z',
    });
    const first = await service.install('claude', { hostRoot, apply: true });
    assert.equal(first.status, 'applied');
    const path = join(hostRoot, 'settings.json');
    const config = JSON.parse(readFileSync(path, 'utf8')) as {
      hooks: Record<
        string,
        { matcher?: string; hooks: { timeout?: number }[] }[]
      >;
    };
    const group = config.hooks['SessionStart']?.find((entry) =>
      JSON.stringify(entry).includes('pappra-managed'),
    );
    assert(group);
    group.matcher = 'USER_RESTRICTED_MATCHER';
    const managed = group.hooks.find((entry) =>
      JSON.stringify(entry).includes('pappra-managed'),
    );
    assert(managed);
    managed.timeout = 99;
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    const before = readFileSync(path, 'utf8');

    const second = await service.install('claude', { hostRoot, apply: true });
    assert.equal(second.ok, false);
    assert.equal(second.status, 'conflict');
    assert.equal(readFileSync(path, 'utf8'), before);
    assert(
      second.diagnostics.some(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          'message' in entry &&
          typeof entry.message === 'string' &&
          entry.message.includes('edited'),
      ),
    );
  } finally {
    cleanup(root);
    cleanup(hostRoot);
  }
});

test('reports lock release failure and preserves the edited lock', async () => {
  const root = workspace();
  const hostRoot = makeTempDir('host-r2-lock');
  const originalLink = fsPromises.link;
  let lockEdited = false;
  try {
    const service = new HostIntegrationService({
      root,
      homeDir: hostRoot,
      pathEnv: '',
      runtimeEntry: runtimeEntry(),
      hostVersion: '2.1.292',
      observedAt: '2026-10-19T00:00:00.000Z',
    });
    fsPromises.link = async (...args: Parameters<typeof originalLink>) => {
      if (args[1] === join(hostRoot, 'settings.json')) {
        writeFileSync(
          join(hostRoot, '.pappra-host.lock'),
          'USER_EDITED_LOCK\n',
        );
        lockEdited = true;
      }
      return originalLink(...args);
    };
    syncBuiltinESMExports();
    const result = await service.install('claude', { hostRoot, apply: true });
    assert.equal(lockEdited, true);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'partial');
    assert(result.residualPaths.includes(join(hostRoot, '.pappra-host.lock')));
    assert(
      result.diagnostics.some(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          'source' in entry &&
          typeof entry.source === 'string' &&
          entry.source.includes('.pappra-host.lock'),
      ),
    );
    assert.equal(existsSync(join(hostRoot, '.pappra-host.lock')), true);
  } finally {
    fsPromises.link = originalLink;
    syncBuiltinESMExports();
    cleanup(root);
    cleanup(hostRoot);
  }
});

test('rejects redirected private ancestors and forged or linked duplicates', async () => {
  const root = workspace();
  try {
    const shared = join(root, 'shared');
    mkdirSync(join(shared, 'host-events', 'claude'), { recursive: true });
    mkdirSync(join(root, '.pappra'), { recursive: true });
    symlinkSync(shared, join(root, '.pappra', 'local'));
    const redirected = await runHostHook(hook(root, 'redirected'));
    assert.equal(redirected.ok, false);
    assert.equal(redirected.status, 'failed');
    assert.deepEqual(readdirSync(join(shared, 'host-events', 'claude')), []);
  } finally {
    cleanup(root);
  }

  const dedupRoot = workspace();
  try {
    const input = hook(dedupRoot, 'forged-event');
    const first = await runHostHook(input);
    assert.equal(first.status, 'processed');
    const directory = join(
      dedupRoot,
      '.pappra',
      'local',
      'host-events',
      'claude',
    );
    const eventPath = join(
      directory,
      readdirSync(directory).find((name) => name.endsWith('.json')) ?? '',
    );
    const record = JSON.parse(readFileSync(eventPath, 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(
      eventPath,
      JSON.stringify({
        ...record,
        host: 'FOREIGN_HOST',
        event: 'FOREIGN_EVENT',
        root: '/foreign',
        cwd: '/foreign',
        sessionId: 'another-session',
        eventId: 'another-id',
        observedAt: 'not-a-date',
      }),
    );
    const forged = await runHostHook(input);
    assert.equal(forged.ok, false);
    assert.equal(forged.status, 'failed');
    assert.equal(forged.duplicate, false);

    const outsideDir = makeTempDir('host-r2-outside');
    const outside = join(outsideDir, 'record.json');
    writeFileSync(outside, JSON.stringify(record));
    rmSync(eventPath);
    symlinkSync(outside, eventPath);
    const originalOpen = fsPromises.open;
    let outsideOpens = 0;
    try {
      fsPromises.open = async (...args: Parameters<typeof originalOpen>) => {
        if (args[0] === eventPath) outsideOpens += 1;
        return originalOpen(...args);
      };
      syncBuiltinESMExports();
      const linked = await runHostHook(input);
      assert.equal(linked.ok, false);
      assert.equal(linked.status, 'failed');
      assert.equal(outsideOpens, 0);
    } finally {
      fsPromises.open = originalOpen;
      syncBuiltinESMExports();
      cleanup(outsideDir);
    }
  } finally {
    cleanup(dedupRoot);
  }
});

test('renders nested Codex output and stops publication at the deadline', async () => {
  const root = workspace();
  try {
    const result = await runHostHook({
      ...hook(root, 'codex-output'),
      host: 'codex',
    });
    assert.equal(result.status, 'processed');
    const rendered = renderHostHookOutput('codex', result);
    assert(rendered);
    const output = JSON.parse(rendered) as Record<string, unknown>;
    assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
    const specific = output['hookSpecificOutput'] as Record<string, unknown>;
    assert.equal(specific['hookEventName'], 'SessionStart');
    assert.equal(typeof specific['additionalContext'], 'string');
  } finally {
    cleanup(root);
  }

  const slowRoot = workspace();
  try {
    let calls = 0;
    const slow = await runHostHook(hook(slowRoot, 'late-publication'), {
      deadlineMs: 100,
      now: () => {
        calls += 1;
        return calls >= 4 ? 200 : 0;
      },
    });
    assert.equal(slow.ok, false);
    assert.equal(slow.status, 'timeout');
    const eventDirectory = join(
      slowRoot,
      '.pappra',
      'local',
      'host-events',
      'claude',
    );
    assert.deepEqual(
      existsSync(eventDirectory) ? readdirSync(eventDirectory) : [],
      [],
    );
  } finally {
    cleanup(slowRoot);
  }
});

test('rejects a private namespace redirected during hook write without publishing or reading shared bytes', async () => {
  const root = workspace();
  const shared = join(root, 'shared');
  const sharedEvents = join(shared, 'host-events', 'claude');
  mkdirSync(sharedEvents, { recursive: true });
  mkdirSync(join(root, '.pappra', 'local'), { recursive: true });
  const originalOpen = fsPromises.open;
  let switched = false;
  let sharedTemporary: string | null = null;
  try {
    fsPromises.open = async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (
        typeof args[0] !== 'string' ||
        !args[0].includes('host-events') ||
        args[1] !== 'wx'
      ) {
        return handle;
      }
      return new Proxy(handle, {
        get(target, key, receiver) {
          if (key === 'writeFile') {
            return async (
              ...writeArgs: Parameters<typeof target.writeFile>
            ) => {
              await target.writeFile(...writeArgs);
              renameSync(
                join(root, '.pappra', 'local'),
                join(root, '.pappra', 'local-saved'),
              );
              symlinkSync(shared, join(root, '.pappra', 'local'));
              sharedTemporary = join(sharedEvents, basename(args[0] as string));
              writeFileSync(sharedTemporary, 'USER_SHARED_BYTES\n');
              switched = true;
            };
          }
          const value = Reflect.get(target, key, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    syncBuiltinESMExports();
    const result = await runHostHook(hook(root, 'redirect-during-write'));
    assert.equal(switched, true);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.deepEqual(
      readdirSync(sharedEvents).filter((name) => name.endsWith('.json')),
      [],
    );
    assert.equal(sharedTemporary !== null && existsSync(sharedTemporary), true);
    assert.equal(readFileSync(sharedTemporary!, 'utf8'), 'USER_SHARED_BYTES\n');
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
    cleanup(root);
  }
});

test('preserves moved install temporary and reports unknown identity residual', async () => {
  const root = workspace();
  const originalOpen = fsPromises.open;
  const hostRoot = makeTempDir('host-r3-moved');
  const movedRoot = join(root, 'moved-host-root');
  let installTemporary: string | null = null;
  let outsideBodyOpens = 0;
  try {
    fsPromises.open = async (...args: Parameters<typeof originalOpen>) => {
      if (
        installTemporary !== null &&
        args[0] === installTemporary &&
        args[1] !== 'wx'
      ) {
        outsideBodyOpens += 1;
      }
      const handle = await originalOpen(...args);
      if (
        typeof args[0] !== 'string' ||
        !args[0].includes('settings.json.tmp-') ||
        args[1] !== 'wx'
      ) {
        return handle;
      }
      installTemporary = args[0];
      return new Proxy(handle, {
        get(target, key, receiver) {
          if (key === 'writeFile') {
            return async (
              ...writeArgs: Parameters<typeof target.writeFile>
            ) => {
              await target.writeFile(...writeArgs);
              renameSync(hostRoot, movedRoot);
              symlinkSync(movedRoot, hostRoot);
              throw Object.assign(new Error('Injected EIO after redirect'), {
                code: 'EIO',
              });
            };
          }
          const value = Reflect.get(target, key, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    syncBuiltinESMExports();
    const service = new HostIntegrationService({
      root,
      homeDir: makeTempDir('host-r3-home'),
      pathEnv: '',
      runtimeEntry: runtimeEntry(),
      hostVersion: '2.1.292',
      observedAt: '2026-10-19T00:00:00.000Z',
    });
    const result = await service.install('claude', { hostRoot, apply: true });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'partial');
    assert.equal(outsideBodyOpens, 0);
    assert.equal(installTemporary !== null, true);
    assert.equal(
      existsSync(join(movedRoot, basename(installTemporary!))),
      true,
    );
    assert(result.residualPaths.includes(installTemporary!));
    assert(
      result.residualPaths.some((path) => path.endsWith('.pappra-host.lock')),
    );
    assert(
      result.diagnostics.some(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          'message' in entry &&
          typeof entry.message === 'string' &&
          entry.message.includes('preserved/unknown temporary'),
      ),
    );
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
    cleanup(hostRoot);
    cleanup(movedRoot);
    cleanup(root);
  }
});

test('reports an unknown temporary residual after exclusive create and failed fstat', async () => {
  const root = workspace();
  const hostRoot = makeTempDir('host-r3-unknown');
  const originalOpen = fsPromises.open;
  let temporary: string | null = null;
  try {
    fsPromises.open = async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (
        typeof args[0] !== 'string' ||
        !args[0].includes('settings.json.tmp-') ||
        args[1] !== 'wx'
      ) {
        return handle;
      }
      temporary = args[0];
      return new Proxy(handle, {
        get(target, key, receiver) {
          if (key === 'stat') {
            return async () => {
              throw Object.assign(new Error('Injected fstat EIO'), {
                code: 'EIO',
              });
            };
          }
          const value = Reflect.get(target, key, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    syncBuiltinESMExports();
    const service = new HostIntegrationService({
      root,
      homeDir: makeTempDir('host-r3-unknown-home'),
      pathEnv: '',
      runtimeEntry: runtimeEntry(),
      hostVersion: '2.1.292',
      observedAt: '2026-10-19T00:00:00.000Z',
    });
    const result = await service.install('claude', { hostRoot, apply: true });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(temporary !== null, true);
    assert.equal(existsSync(temporary!), true);
    assert(result.residualPaths.includes(temporary!));
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
    cleanup(hostRoot);
    cleanup(root);
  }
});

test('rejects same-inode edited hook bytes before publication', async () => {
  const root = workspace();
  const originalOpen = fsPromises.open;
  let temporary: string | null = null;
  let sameInode = false;
  try {
    fsPromises.open = async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (
        typeof args[0] !== 'string' ||
        !args[0].includes('host-events') ||
        args[1] !== 'wx'
      ) {
        return handle;
      }
      temporary = args[0];
      return new Proxy(handle, {
        get(target, key, receiver) {
          if (key === 'writeFile') {
            return async (
              ...writeArgs: Parameters<typeof target.writeFile>
            ) => {
              await target.writeFile(...writeArgs);
              const before = statSync(temporary!);
              writeFileSync(temporary!, 'USER_SAME_INODE_BYTES\n');
              sameInode = statSync(temporary!).ino === before.ino;
            };
          }
          const value = Reflect.get(target, key, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    syncBuiltinESMExports();
    const result = await runHostHook(hook(root, 'same-inode-hook'));
    assert.equal(sameInode, true);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(temporary !== null && existsSync(temporary), true);
    const directory = join(root, '.pappra', 'local', 'host-events', 'claude');
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.endsWith('.json')),
      [],
    );
    assert.equal(readFileSync(temporary!, 'utf8'), 'USER_SAME_INODE_BYTES\n');
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
    cleanup(root);
  }
});

test('rejects same-inode edited installer bytes and preserves the temporary', async () => {
  const root = workspace();
  const hostRoot = makeTempDir('host-r4-content');
  const originalOpen = fsPromises.open;
  let temporary: string | null = null;
  let sameInode = false;
  try {
    fsPromises.open = async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (
        typeof args[0] !== 'string' ||
        !args[0].includes('settings.json.tmp-') ||
        args[1] !== 'wx'
      ) {
        return handle;
      }
      temporary = args[0];
      return new Proxy(handle, {
        get(target, key, receiver) {
          if (key === 'writeFile') {
            return async (
              ...writeArgs: Parameters<typeof target.writeFile>
            ) => {
              await target.writeFile(...writeArgs);
              const before = statSync(temporary!);
              writeFileSync(temporary!, 'USER_SAME_INODE_BYTES\n');
              sameInode = statSync(temporary!).ino === before.ino;
            };
          }
          const value = Reflect.get(target, key, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    syncBuiltinESMExports();
    const service = new HostIntegrationService({
      root,
      homeDir: makeTempDir('host-r4-content-home'),
      pathEnv: '',
      runtimeEntry: runtimeEntry(),
      hostVersion: '2.1.292',
      observedAt: '2026-10-19T00:00:00.000Z',
    });
    const result = await service.install('claude', { hostRoot, apply: true });
    assert.equal(sameInode, true);
    assert.equal(result.ok, false);
    assert.notEqual(result.status, 'applied');
    assert.equal(existsSync(join(hostRoot, 'settings.json')), false);
    assert.equal(temporary !== null && existsSync(temporary), true);
    assert(result.residualPaths.includes(temporary!));
    assert.equal(readFileSync(temporary!, 'utf8'), 'USER_SAME_INODE_BYTES\n');
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
    cleanup(hostRoot);
    cleanup(root);
  }
});

test('preserves hook temporary truncated after a successful complete write', async () => {
  const root = workspace();
  const originalOpen = fsPromises.open;
  let temporary: string | null = null;
  let truncated = false;
  try {
    fsPromises.open = async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (
        typeof args[0] !== 'string' ||
        !args[0].includes('host-events') ||
        args[1] !== 'wx'
      ) {
        return handle;
      }
      temporary = args[0];
      return new Proxy(handle, {
        get(target, key, receiver) {
          if (key === 'sync') {
            return async () => {
              await target.sync();
              const bytes = readFileSync(temporary!);
              writeFileSync(
                temporary!,
                bytes.subarray(0, Math.floor(bytes.length / 2)),
              );
              truncated = true;
            };
          }
          const value = Reflect.get(target, key, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    syncBuiltinESMExports();
    const result = await runHostHook(hook(root, 'truncate-after-write'));
    assert.equal(truncated, true);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(temporary !== null && existsSync(temporary), true);
    const directory = join(root, '.pappra', 'local', 'host-events', 'claude');
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.endsWith('.json')),
      [],
    );
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
    cleanup(root);
  }
});

test('preserves installer temporary truncated after a successful complete write', async () => {
  const root = workspace();
  const hostRoot = makeTempDir('host-r5-truncate');
  const originalOpen = fsPromises.open;
  let temporary: string | null = null;
  let truncated = false;
  try {
    fsPromises.open = async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (
        typeof args[0] !== 'string' ||
        !args[0].includes('settings.json.tmp-') ||
        args[1] !== 'wx'
      ) {
        return handle;
      }
      temporary = args[0];
      return new Proxy(handle, {
        get(target, key, receiver) {
          if (key === 'sync') {
            return async () => {
              await target.sync();
              const bytes = readFileSync(temporary!);
              writeFileSync(
                temporary!,
                bytes.subarray(0, Math.floor(bytes.length / 2)),
              );
              truncated = true;
            };
          }
          const value = Reflect.get(target, key, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    syncBuiltinESMExports();
    const service = new HostIntegrationService({
      root,
      homeDir: makeTempDir('host-r5-truncate-home'),
      pathEnv: '',
      runtimeEntry: runtimeEntry(),
      hostVersion: '2.1.292',
      observedAt: '2026-10-19T00:00:00.000Z',
    });
    const result = await service.install('claude', { hostRoot, apply: true });
    assert.equal(truncated, true);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(temporary !== null && existsSync(temporary), true);
    assert(result.residualPaths.includes(temporary!));
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
    cleanup(hostRoot);
    cleanup(root);
  }
});
