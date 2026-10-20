import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(
  fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json')),
);
const source = join(root, 'src/assets/integrations/skills/pappra');
const mirror = join(root, 'skills/pappra');

function listFiles(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory()
      ? listFiles(join(directory, entry.name), relative)
      : [relative];
  });
}

test('the published skill mirror matches the packaged skill source', () => {
  const expected = listFiles(source).sort();
  assert.deepEqual(listFiles(mirror).sort(), expected);
  for (const file of expected) {
    assert.deepEqual(
      readFileSync(join(mirror, file)),
      readFileSync(join(source, file)),
      `skills/pappra/${file} drifted from src/assets/integrations/skills/pappra/${file}`,
    );
  }
});
