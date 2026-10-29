import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { sha256Digest } from '../../src/infra/fs.js';
import {
  beginRuntimeReference,
  inspectRuntimeReferences,
  runtimeReferencesDirectory,
} from '../../src/install/references.js';
import { runtimePaths } from '../../src/install/runtime.js';
import type { RuntimeManifest } from '../../src/schemas/install.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  workspaceId,
  writeMachineConfig,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';
import { cleanup, makeTempDir } from './fixtures.js';

const version = '9.8.7';
const now = '2026-10-25T00:00:00.000Z';

interface StoredIdentity {
  dev?: number;
  ino: number;
}

interface ReferenceRecord {
  schema: string;
  workspaceRoot: string;
  workspaceId: string;
  rootIdentity: StoredIdentity;
  intendedRuntime: {
    version: string;
    executable: string;
    runtimeRoot: string;
  };
  registeredAt: string;
}

/** The registry name this record would receive under the given key parts. */
function referenceName(parts: readonly unknown[]): string {
  return `${sha256Digest(JSON.stringify(parts)).replace(':', '-')}.json`;
}

function fixture() {
  const temp = makeTempDir('runtime-reference-dedupe');
  const root = realpathSync(temp);
  const dataDir = join(root, 'data');
  const paths = runtimePaths(version, dataDir);
  mkdirSync(paths.runtimeRoot, { recursive: true });
  writeWorkspaceConfig(root, baseWorkspaceConfig());
  const runtime: RuntimeManifest = {
    schema: 'pappra/runtime-manifest/3',
    installId: randomUUID(),
    runtimeVersion: version,
    packageName: '@phyzess/pappra',
    runtimeRoot: paths.runtimeRoot,
    executable: join(paths.runtimeRoot, 'cli.js'),
    source: {
      kind: 'version',
      version,
      packageName: '@phyzess/pappra',
      ref: `@phyzess/pappra@${version}`,
    },
    packageDigest: sha256Digest('fixture'),
    digestScheme: 'sha256-utf8-byte-order-v1',
    sourceFingerprint: sha256Digest('fixture'),
    smoke: { argv: [], exitCode: 0, stdoutDigest: sha256Digest('') },
    verifiedAt: now,
  };
  return { temp, root, dataDir, runtime };
}

function bindMachine(root: string, runtime: RuntimeManifest): void {
  writeMachineConfig(
    root,
    baseMachineConfig(root, {
      runtime: {
        version: runtime.runtimeVersion,
        executable: runtime.executable,
        verifiedAt: runtime.verifiedAt,
      },
    }),
  );
}

function storedRecord(
  root: string,
  runtime: RuntimeManifest,
  identity: StoredIdentity,
  id: string = workspaceId,
): ReferenceRecord {
  return {
    schema: 'pappra/runtime-reference/1',
    workspaceRoot: root,
    workspaceId: id,
    rootIdentity: identity,
    intendedRuntime: {
      version: runtime.runtimeVersion,
      executable: runtime.executable,
      runtimeRoot: runtime.runtimeRoot,
    },
    registeredAt: now,
  };
}

function writeRecord(
  directory: string,
  name: string,
  record: ReferenceRecord,
): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), `${JSON.stringify(record, null, 2)}\n`);
}

async function register(
  root: string,
  runtime: RuntimeManifest,
): Promise<string> {
  const lease = await beginRuntimeReference(root, runtime);
  assert.equal(lease.ok, true, JSON.stringify(lease));
  if (!lease.ok) throw new Error('registration failed');
  const released = await lease.value.release();
  assert.equal(released.ok, true);
  return lease.value.path;
}

test('a legacy device-named record is superseded by one dev-independent record', async () => {
  const { temp, root, dataDir, runtime } = fixture();
  try {
    bindMachine(root, runtime);
    const stats = statSync(root);
    const directory = runtimeReferencesDirectory(dataDir);
    // Written before a reboot: the name and the stored device both predate the
    // current observation, while the inode is unchanged.
    const previousDev = stats.dev + 7;
    const legacyName = referenceName([
      root,
      workspaceId,
      previousDev,
      stats.ino,
    ]);
    writeRecord(
      directory,
      legacyName,
      storedRecord(root, runtime, {
        dev: previousDev,
        ino: stats.ino,
      }),
    );
    const before = await inspectRuntimeReferences(dataDir, version);
    assert.equal(before.active.length, 1);
    const currentName = referenceName([root, workspaceId, stats.ino]);
    assert.equal(await register(root, runtime), join(directory, currentName));
    assert.deepEqual(readdirSync(directory).sort(), [currentName]);
    const after = await inspectRuntimeReferences(dataDir, version);
    assert.equal(after.active.length, 1);
    assert.equal(
      after.unknown.some((reason) =>
        reason.startsWith('workspace_missing_or_replaced'),
      ),
      false,
    );
  } finally {
    cleanup(temp);
  }
});

test('a repeat registration removes a legacy duplicate beside the current record', async () => {
  const { temp, root, dataDir, runtime } = fixture();
  try {
    bindMachine(root, runtime);
    await register(root, runtime);
    const directory = runtimeReferencesDirectory(dataDir);
    const stats = statSync(root);
    const previousDev = stats.dev + 7;
    writeRecord(
      directory,
      referenceName([root, workspaceId, previousDev, stats.ino]),
      storedRecord(root, runtime, { dev: previousDev, ino: stats.ino }),
    );
    assert.equal(readdirSync(directory).length, 2);
    await register(root, runtime);
    assert.deepEqual(readdirSync(directory).sort(), [
      referenceName([root, workspaceId, stats.ino]),
    ]);
    const report = await inspectRuntimeReferences(dataDir, version);
    assert.equal(report.active.length, 1);
  } finally {
    cleanup(temp);
  }
});

test('a different inode, another workspace and an unparsable entry are preserved', async () => {
  const { temp, root, dataDir, runtime } = fixture();
  try {
    bindMachine(root, runtime);
    const directory = runtimeReferencesDirectory(dataDir);
    const stats = statSync(root);
    const otherInode = referenceName(['other-inode']);
    const otherWorkspace = referenceName(['other-workspace']);
    const unreadableName = `sha256-${'a'.repeat(64)}.json`;
    writeRecord(
      directory,
      otherInode,
      storedRecord(root, runtime, { dev: stats.dev, ino: stats.ino + 1 }),
    );
    writeRecord(
      directory,
      otherWorkspace,
      storedRecord(
        root,
        runtime,
        { dev: stats.dev, ino: stats.ino },
        randomUUID(),
      ),
    );
    writeFileSync(join(directory, unreadableName), '{incomplete');
    const preserved = new Map(
      [otherInode, otherWorkspace, unreadableName].map((name) => [
        name,
        readFileSync(join(directory, name)),
      ]),
    );
    await register(root, runtime);
    for (const [name, bytes] of preserved) {
      assert.equal(
        readFileSync(join(directory, name)).equals(bytes),
        true,
        name,
      );
    }
    assert.equal(readdirSync(directory).length, 4);
    const report = await inspectRuntimeReferences(dataDir, version);
    assert.equal(report.active.length, 1);
    assert.equal(
      report.unknown.includes(`reference_unreadable:${unreadableName}`),
      true,
    );
    assert.equal(
      report.unknown.includes(`workspace_missing_or_replaced:${otherInode}`),
      true,
    );
    assert.equal(
      report.unknown.includes(`workspace_identity_unknown:${otherWorkspace}`),
      true,
    );
  } finally {
    cleanup(temp);
  }
});

test('a fresh registration writes the dev-independent content-addressed name', async () => {
  const { temp, root, dataDir, runtime } = fixture();
  try {
    const stats = statSync(root);
    const directory = runtimeReferencesDirectory(dataDir);
    const expected = referenceName([root, workspaceId, stats.ino]);
    assert.equal(await register(root, runtime), join(directory, expected));
    assert.notEqual(
      expected,
      referenceName([root, workspaceId, stats.dev, stats.ino]),
    );
    assert.deepEqual(readdirSync(directory), [expected]);
    const stored = JSON.parse(
      readFileSync(join(directory, expected), 'utf8'),
    ) as ReferenceRecord;
    assert.equal(stored.rootIdentity.ino, stats.ino);
  } finally {
    cleanup(temp);
  }
});
