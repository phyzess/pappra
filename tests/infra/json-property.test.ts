import assert from 'node:assert/strict';
import test from 'node:test';
import { updateJsonProperty } from '../../src/infra/json-property.js';

test('top-level JSON edits preserve unrelated whitespace, escaped strings and CRLF', () => {
  const original =
    '{\r\n    "model"  : "escape\\\"[,]{}",\r\n    "hooks": {"nested":[{"hooks":"unchanged"}]},\r\n    "tail" : [1, 2]\r\n}\r\n';
  const next = updateJsonProperty(Buffer.from(original), 'hooks', {
    SessionStart: [],
  }).toString();
  assert(next.startsWith('{\r\n    "model"  : "escape\\\"[,]{}",\r\n'));
  assert(next.endsWith(',\r\n    "tail" : [1, 2]\r\n}\r\n'));
  assert.deepEqual(JSON.parse(next).hooks, { SessionStart: [] });
});

test('adding a JSON property retains compact objects and empty-object semantics', () => {
  assert.equal(
    updateJsonProperty(Buffer.from('{"model":"x"}'), 'hooks', {}).toString(),
    '{"model":"x","hooks":{}}',
  );
  assert.deepEqual(
    JSON.parse(updateJsonProperty(Buffer.from('{}\n'), 'hooks', {}).toString()),
    { hooks: {} },
  );
  assert.throws(
    () => updateJsonProperty(Buffer.from('[]'), 'hooks', {}),
    /json_object_required/,
  );
});
