import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { replacePrivateFile } from '../../src/infra/private-file.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';

test('private replacement refuses a pre-existing temporary entry', () => {
  const directory = makeTempDir('private-replace-collision');
  try {
    const file = path.join(directory, 'destination');
    const temporary = path.join(directory, 'staged');
    fs.writeFileSync(file, 'old');
    fs.writeFileSync(temporary, 'foreign');
    assert.throws(() => replacePrivateFile(file, temporary, 'new'), {
      code: 'EEXIST',
    });
    assert.equal(fs.readFileSync(file, 'utf8'), 'old');
    assert.equal(fs.readFileSync(temporary, 'utf8'), 'foreign');
  } finally {
    cleanup(directory);
  }
});

test('private replacement respects a failed guard and publishes exact bytes on success', () => {
  const directory = makeTempDir('private-replace-guard');
  try {
    const file = path.join(directory, 'destination');
    const temporary = path.join(directory, 'staged');
    fs.writeFileSync(file, 'old');
    const bytes = Buffer.from([0x00, 0xff]);
    assert.equal(
      replacePrivateFile(file, temporary, bytes, {
        beforePublish: () => {
          assert.deepEqual(fs.readFileSync(temporary), bytes);
          assert.equal(fs.readFileSync(file, 'utf8'), 'old');
          return false;
        },
      }),
      false,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'old');
    assert.equal(fs.existsSync(temporary), false);
    assert.equal(
      replacePrivateFile(file, temporary, bytes, { syncParent: true }),
      true,
    );
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.equal(fs.existsSync(temporary), false);
  } finally {
    cleanup(directory);
  }
});

test('private replacement preserves a substituted temporary entry and the destination', () => {
  const directory = makeTempDir('private-replace-substitution');
  try {
    const file = path.join(directory, 'destination');
    const temporary = path.join(directory, 'staged');
    fs.writeFileSync(file, 'old');
    assert.throws(
      () =>
        replacePrivateFile(file, temporary, 'new', {
          beforePublish: () => {
            fs.renameSync(temporary, path.join(directory, 'moved'));
            fs.writeFileSync(temporary, 'foreign');
            return true;
          },
        }),
      /Private temporary file changed before publish/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'old');
    assert.equal(fs.readFileSync(temporary, 'utf8'), 'foreign');
  } finally {
    cleanup(directory);
  }
});
