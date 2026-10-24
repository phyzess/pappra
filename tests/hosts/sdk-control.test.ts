import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serveManagedPiSdkControl } from '../../src/app/managed-pi-sdk-control.js';
import { requestManagedPiControl } from '../../src/hosts/pi/managed-session.js';
import type { ManagedPiSdkSessionController } from '../../src/hosts/pi/managed-sdk-session.js';

test('private SDK endpoint addresses its owned runtime and keeps runtime disposal distinct from process exit', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pappra-sdk-control-')),
  );
  let stopped = 0;
  let fenced = 0;
  const fake = {
    observe: () => ({ native: { sessionId: 'fresh-owned-session' } }),
    snapshot: () => ({
      scopedQuiescent: fenced > 0,
      process: { exit: 'not_owned' },
    }),
    quiesce: async () => {
      fenced++;
      return fake.snapshot();
    },
    stopOwnedRuntime: async () => {
      stopped++;
      return { status: 'runtime_disposed', process: { exit: 'not_owned' } };
    },
  } as unknown as ManagedPiSdkSessionController;
  const journal = path.join(root, 'events.jsonl');
  const server = await serveManagedPiSdkControl(fake, journal);
  try {
    const snapshot = await requestManagedPiControl(
      `${journal}.control.json`,
      'snapshot',
    );
    assert.equal(snapshot.ok, true);
    assert.equal(stopped, 0);
    const fence = await requestManagedPiControl(
      `${journal}.control.json`,
      'fence',
    );
    assert.equal(fence.ok, true);
    assert.equal(fenced, 1);
    const result = await requestManagedPiControl(
      `${journal}.control.json`,
      'stop',
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.exit, {
      status: 'runtime_disposed',
      process: { exit: 'not_owned' },
    });
    await server.stopped;
    assert.equal(stopped, 1);
    assert.equal(fs.statSync(`${journal}.control.json`).mode & 0o077, 0);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SDK control refuses a public or redirected parent before binding', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pappra-sdk-unsafe-')),
  );
  fs.chmodSync(root, 0o755);
  try {
    await assert.rejects(
      serveManagedPiSdkControl(
        {} as ManagedPiSdkSessionController,
        path.join(root, 'events.jsonl'),
      ),
      /sdk_control_directory_not_private/,
    );
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native inventory responses have a separate bounded budget from control commands', async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pappra-sdk-response-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let bytes = 32 * 1024;
  const fake = {
    observe: () => ({ native: { sessionId: 'owned' } }),
    snapshot: () => ({ pending: '中文'.repeat(bytes) }),
  } as unknown as ManagedPiSdkSessionController;
  const journal = path.join(root, 'events.jsonl');
  const server = await serveManagedPiSdkControl(fake, journal);
  try {
    const response = await requestManagedPiControl(
      `${journal}.control.json`,
      'snapshot',
    );
    assert.equal(
      (response.snapshot as { pending: string }).pending,
      '中文'.repeat(bytes),
    );
    bytes = 1024 * 1024;
    await assert.rejects(
      requestManagedPiControl(`${journal}.control.json`, 'snapshot'),
      /control_response_too_large/,
    );
  } finally {
    server.close();
  }
});

test('SDK delivery uses an explicit authenticated admission callback', async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pappra-sdk-deliver-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = path.join(root, 'events.jsonl');
  const fake = {
    observe: () => ({ native: { sessionId: 'owned' } }),
  } as ManagedPiSdkSessionController;
  const received: string[] = [];
  const server = await serveManagedPiSdkControl(
    fake,
    journal,
    undefined,
    () => null,
    async (request) => {
      received.push(String(request.message_id));
      return { ok: true, admission: { status: 'submitted' } };
    },
  );
  try {
    const response = await requestManagedPiControl(
      `${journal}.control.json`,
      'deliver',
      { message_id: 'registered-message' },
    );
    assert.equal(response.ok, true);
    assert.deepEqual(received, ['registered-message']);
  } finally {
    server.close();
  }
});
