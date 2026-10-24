import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  canonicalizeTarget,
  describeResource,
  pathsOverlap,
} from '../../src/collab/canonical.js';

test('case-insensitive native aliases and future targets share resource identities', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pappra-Case-'));
  try {
    const original = path.join(root, 'Claim.TS');
    const alias = path.join(root, 'claim.ts');
    fs.writeFileSync(original, 'first');
    if (!fs.existsSync(alias)) {
      t.skip('filesystem is case sensitive');
      return;
    }
    assert.equal(
      canonicalizeTarget(original).path,
      fs.realpathSync.native(original),
    );
    assert.equal(
      describeResource({ path: original }).key,
      describeResource({ path: alias }).key,
    );
    assert.equal(
      describeResource({ path: path.join(root, 'Next.TS') }).key,
      describeResource({ path: path.join(root, 'next.ts') }).key,
    );
    assert.equal(
      pathsOverlap(
        path.join(root, 'NewTree'),
        path.join(root, 'newtree', 'child'),
      ),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('case-sensitive files remain distinct and NFD names remain usable for I/O', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pappra-case-'));
  try {
    const composed = path.join(root, 'Caf\u00e9.TS');
    const decomposed = path.join(root, 'Cafe\u0301.TS');
    fs.writeFileSync(decomposed, 'decomposed');
    assert.equal(
      fs.readFileSync(canonicalizeTarget(decomposed).path, 'utf8'),
      'decomposed',
    );
    const upper = path.join(root, 'Claim.TS');
    const lower = path.join(root, 'claim.ts');
    fs.writeFileSync(upper, 'upper');
    if (fs.existsSync(lower)) {
      t.skip('filesystem is case insensitive');
      return;
    }
    fs.writeFileSync(lower, 'lower');
    assert.notEqual(
      describeResource({ path: upper }).key,
      describeResource({ path: lower }).key,
    );
    assert.equal(pathsOverlap(upper, lower), false);
    if (!fs.existsSync(composed))
      assert.notEqual(
        describeResource({ path: composed }).key,
        describeResource({ path: decomposed }).key,
      );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
