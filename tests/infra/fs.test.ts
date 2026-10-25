import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readFileBounded, sha256Digest } from '../../src/infra/fs.js';

test('bounded reads allocate for small files rather than the maximum size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pappra-bounded-file-'));
  try {
    const file = join(root, 'small.txt');
    const content = 'small runtime dependency';
    await writeFile(file, content);
    const result = await readFileBounded(file, 64 * 1024 * 1024);
    assert(result.ok);
    assert.equal(result.value.bytes.toString(), content);
    assert.equal(result.value.digest, sha256Digest(content));
    // Small reads allocate one byte more than the file and come from one shared
    // slab, so the backing ArrayBuffer is the runtime's own small-buffer
    // contract: Buffer.poolSize plus any alignment padding (Node 26 backs the
    // slab with poolSize + 63 bytes). Assert against that measured contract
    // instead of assuming it equals 64 KiB; a read that allocated the requested
    // ceiling would still fail well above it.
    const allocation = Buffer.byteLength(content) + 1;
    const slabBytes = Math.max(
      Buffer.poolSize,
      Buffer.allocUnsafe(1).buffer.byteLength,
      allocation,
    );
    const backing = result.value.bytes.buffer.byteLength;
    assert(
      backing <= slabBytes,
      `small read is backed by ${backing} bytes, above the runtime slab of ${slabBytes}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bounded reads accept the exact limit and reject even one extra byte', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pappra-bounded-limit-'));
  try {
    const file = join(root, 'limit.txt');
    await writeFile(file, '1234');
    const exact = await readFileBounded(file, 4);
    assert(exact.ok);
    assert.equal(exact.value.size, 4);
    await writeFile(file, '12345');
    const oversized = await readFileBounded(file, 4);
    assert(!oversized.ok);
    assert.equal(oversized.code, 'file_too_large');
    await writeFile(file, '');
    const empty = await readFileBounded(file, 0);
    assert(empty.ok);
    assert.equal(empty.value.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
