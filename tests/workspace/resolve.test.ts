import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { resolveWorkspaceRoot } from '../../src/workspace/index.js';
import {
  baseWorkspaceConfig,
  cleanup,
  makeTempDir,
  realpath,
  snapshotTree,
  writeText,
  writeWorkspaceConfig,
} from './fixtures.js';

test('reports a missing registration without scanning or writing', async () => {
  const root = makeTempDir('resolve-missing');
  try {
    const before = snapshotTree(root);
    const result = await resolveWorkspaceRoot({ startPath: root });
    assert.equal(result.state, 'missing');
    assert.equal(result.root, null);
    assert.equal(
      result.diagnostics.find((entry) => entry.code === 'workspace_not_found')
        ?.severity,
      'info',
    );
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('resolves the nearest registered workspace instead of an outer one', async () => {
  const outer = makeTempDir('resolve-outer');
  try {
    const inner = join(outer, 'nested 项目', 'inner workspace');
    const deep = join(inner, 'src', 'module');
    mkdirSync(deep, { recursive: true });
    writeWorkspaceConfig(outer, baseWorkspaceConfig({ name: 'outer' }));
    writeWorkspaceConfig(inner, baseWorkspaceConfig({ name: 'inner' }));

    const fromInner = await resolveWorkspaceRoot({ startPath: deep });
    assert.equal(fromInner.state, 'registered');
    assert.equal(fromInner.root, realpath(inner));

    const fromOuter = await resolveWorkspaceRoot({ startPath: outer });
    assert.equal(fromOuter.root, realpath(outer));

    const fromFile = await resolveWorkspaceRoot({
      startPath: join(deep, 'file.txt'),
    });
    assert.equal(fromFile.state, 'unavailable');

    writeFileSync(join(deep, 'file.txt'), 'content\n');
    const fromExistingFile = await resolveWorkspaceRoot({
      startPath: join(deep, 'file.txt'),
    });
    assert.equal(fromExistingFile.root, realpath(inner));
  } finally {
    cleanup(outer);
  }
});

test('stops at an incomplete nested registration instead of falling back outward', async () => {
  const outer = makeTempDir('resolve-incomplete');
  try {
    const inner = join(outer, 'inner');
    mkdirSync(join(inner, '.pappra'), { recursive: true });
    writeWorkspaceConfig(outer, baseWorkspaceConfig({ name: 'outer' }));

    const result = await resolveWorkspaceRoot({ startPath: inner });
    assert.equal(result.state, 'incomplete');
    assert.equal(result.root, realpath(inner));
    assert.equal(
      result.diagnostics.find(
        (entry) => entry.code === 'workspace_registration_incomplete',
      )?.severity,
      'error',
    );
  } finally {
    cleanup(outer);
  }
});

test('resolves through a symlinked start path while returning the real root', async () => {
  const root = makeTempDir('resolve-symlink');
  const linkParent = makeTempDir('resolve-symlink-link');
  try {
    const workspace = join(root, 'workspace with spaces', '项目');
    mkdirSync(workspace, { recursive: true });
    writeWorkspaceConfig(workspace, baseWorkspaceConfig());
    const link = join(linkParent, 'link to workspace');
    symlinkSync(workspace, link, 'dir');

    const result = await resolveWorkspaceRoot({ startPath: link });
    assert.equal(result.state, 'registered');
    assert.equal(result.root, realpath(workspace));
  } finally {
    cleanup(root);
    cleanup(linkParent);
  }
});

test('still reports a registered root when its config content is corrupt', async () => {
  const root = makeTempDir('resolve-corrupt');
  try {
    writeText(join(root, '.pappra', 'workspace.json'), '{not json');
    const result = await resolveWorkspaceRoot({ startPath: root });
    assert.equal(result.state, 'registered');
    assert.equal(result.root, realpath(root));
  } finally {
    cleanup(root);
  }
});

test('does not follow a workspace.json symlink that escapes the root', async () => {
  const root = makeTempDir('resolve-escape');
  const outside = makeTempDir('resolve-escape-target');
  try {
    writeText(
      join(outside, 'workspace.json'),
      JSON.stringify(baseWorkspaceConfig()),
    );
    mkdirSync(join(root, '.pappra'), { recursive: true });
    symlinkSync(
      join(outside, 'workspace.json'),
      join(root, '.pappra', 'workspace.json'),
    );

    const result = await resolveWorkspaceRoot({ startPath: root });
    assert.equal(result.state, 'incomplete');
    assert.equal(result.root, realpath(root));
    assert(
      result.diagnostics.some(
        (entry) => entry.code === 'config_symlink_escape',
      ),
    );
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('reports a nonexistent start path as unavailable', async () => {
  const root = makeTempDir('resolve-nonexistent');
  try {
    const result = await resolveWorkspaceRoot({
      startPath: join(root, 'does', 'not', 'exist'),
    });
    assert.equal(result.state, 'unavailable');
    assert.equal(result.startDirectory, null);
  } finally {
    cleanup(root);
  }
});
