import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, canonicalJsonDigest } from '../../src/infra/json.js';
import { buildMessage, contentDigest } from '../../src/collab/envelope.js';

test('canonical JSON matches persisted undefined, holes and toJSON semantics', () => {
  const input = { b: undefined, a: [undefined, , 3], date: new Date(0) };
  assert.equal(
    canonicalJson(input),
    canonicalJson(JSON.parse(JSON.stringify(input))),
  );
  assert.equal(canonicalJson({ a: undefined }), '{}');
  assert.equal(canonicalJson([undefined, , NaN]), '[null,null,null]');
  assert.throws(() => canonicalJson(undefined), TypeError);
  assert.throws(() => canonicalJson(1n), TypeError);
});

test('canonical digest ignores object key order and retains array order', () => {
  assert.equal(
    canonicalJsonDigest({ z: { b: 2, a: 1 }, a: ['x', 'y'] }),
    canonicalJsonDigest({ a: ['x', 'y'], z: { a: 1, b: 2 } }),
  );
  assert.notEqual(
    canonicalJsonDigest(['x', 'y']),
    canonicalJsonDigest(['y', 'x']),
  );
});

test('message content identity survives JSON persistence of optional extension fields', () => {
  const identity = {
    agent_id: 'reader',
    session_id: 'session',
    harness: 'codex',
  };
  const message = buildMessage({
    type: 'ASK',
    task_id: 'task',
    from: identity,
    to: identity,
    body: { question: 'Which input?', optional: undefined },
  });
  assert.equal(
    contentDigest(message),
    contentDigest(JSON.parse(JSON.stringify(message))),
  );
});
