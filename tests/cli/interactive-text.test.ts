import assert from 'node:assert/strict';
import test from 'node:test';
import { textPromptValidator } from '../../src/cli/interactive.js';

const MIN_LENGTH = 'Too small: expected string to have >=1 characters';

function minLength(value: string): string | undefined {
  return value.length >= 1 ? undefined : MIN_LENGTH;
}

function required<T>(value: T | undefined): T {
  if (value === undefined)
    assert.fail('expected the prompt to configure a validator');
  return value;
}

test('an empty answer is accepted while a default is declared', () => {
  const seen: string[] = [];
  const validate = required(
    textPromptValidator((value) => {
      seen.push(value);
      return minLength(value);
    }, 'demo'),
  );

  assert.equal(validate(''), undefined);
  assert.equal(validate(undefined), undefined);
  assert.deepEqual(seen, []);
});

test('an empty answer reaches the caller validator when no default is declared', () => {
  const seen: string[] = [];
  const validate = required(
    textPromptValidator((value) => {
      seen.push(value);
      return minLength(value);
    }, undefined),
  );

  assert.equal(validate(''), MIN_LENGTH);
  assert.deepEqual(seen, ['']);
});

test('an empty default cannot rescue an empty answer', () => {
  const seen: string[] = [];
  const validate = required(
    textPromptValidator((value) => {
      seen.push(value);
      return minLength(value);
    }, ''),
  );

  assert.equal(validate(''), MIN_LENGTH);
  assert.deepEqual(seen, ['']);
});

test('a non-empty answer reaches the caller validator with its value', () => {
  const seen: string[] = [];
  const validate = required(
    textPromptValidator((value) => {
      seen.push(value);
      return minLength(value);
    }, 'demo'),
  );

  assert.equal(validate('acme'), undefined);
  assert.deepEqual(seen, ['acme']);
});

test('a prompt without a caller validator configures none', () => {
  assert.equal(textPromptValidator(undefined, 'demo'), undefined);
  assert.equal(textPromptValidator(undefined, undefined), undefined);
});
