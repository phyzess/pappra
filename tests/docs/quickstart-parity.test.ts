import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(
  fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json')),
);

const english = readFileSync(join(root, 'docs/quickstart.md'), 'utf8');
const chinese = readFileSync(join(root, 'docs/quickstart.zh-CN.md'), 'utf8');

/** Fenced code blocks with comments and blank lines dropped: comments are translated, commands are not. */
function codeBlocks(markdown: string): string[][] {
  const blocks: string[][] = [];
  for (const match of markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    blocks.push(
      (match[1] ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        // Trailing comments are translated too.
        .map((line) => line.replace(/\s{2,}#.*$/, '')),
    );
  }
  return blocks;
}

/** Relative link targets, with the language suffix and the language switch removed. */
function relativeTargets(markdown: string): string[] {
  const targets = [
    ...[...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? ''),
    ...[...markdown.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? ''),
  ];
  return targets
    .filter((target) => !/^(?:[a-z]+:|#)/i.test(target))
    .map((target) => target.replace(/\.zh-CN(?=\.[a-z]+$)/, ''))
    .filter((target) => basename(target) !== 'quickstart.md')
    .sort();
}

function headingCount(markdown: string): number {
  return markdown
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .filter((line) => /^#{1,6} /.test(line)).length;
}

test('each quick start links to the other so a reader can switch language', () => {
  assert.match(english, /href="quickstart\.zh-CN\.md"/);
  assert.match(chinese, /href="quickstart\.md"/);
});

test('every local link a quick start references exists', () => {
  for (const [name, text] of [
    ['quickstart.md', english],
    ['quickstart.zh-CN.md', chinese],
  ] as const) {
    for (const target of new Set(
      [...text.matchAll(/(?:src|href)="([^"]+)"|\]\(([^)\s]+)\)/g)]
        .map((m) => m[1] ?? m[2] ?? '')
        .filter((value) => !/^(?:[a-z]+:|#)/i.test(value)),
    )) {
      assert(
        existsSync(join(root, 'docs', target)),
        `${name} references missing ${target}`,
      );
    }
  }
});

test('the two quick starts run the same commands in the same order', () => {
  assert.deepEqual(codeBlocks(chinese), codeBlocks(english));
});

test('the two quick starts link the same documents', () => {
  assert.deepEqual(relativeTargets(chinese), relativeTargets(english));
});

test('the two quick starts keep the same section structure', () => {
  assert.equal(headingCount(chinese), headingCount(english));
});
