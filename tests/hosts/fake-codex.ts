#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { object, parseJson } from '../../src/collab/validation.js';

let status =
  process.env['PAPPRA_FAKE_COMPLETED'] === '1' ? 'completed' : 'inProgress';
const emit = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = parseJson(line);
  if (!object(request) || request['id'] === undefined) return;
  const id = request['id'];
  const thread = {
    id: 'thread-fixture',
    cwd: process.cwd(),
    status: {
      type:
        process.env['PAPPRA_FAKE_COMPLETED'] === '1' ? 'notLoaded' : 'active',
    },
  };
  const turn = { id: 'turn-fixture', status };
  switch (request['method']) {
    case 'initialize':
      emit({ id, result: {} });
      break;
    case 'thread/start':
      emit({ id, result: { thread } });
      break;
    case 'turn/start':
      emit({ id, result: { turn } });
      break;
    case 'thread/read':
      emit({ id, result: { thread } });
      break;
    case 'thread/turns/list':
      emit({ id, result: { data: [turn] } });
      break;
    case 'thread/items/list':
      emit({
        id,
        result: {
          data: [
            {
              item: { type: 'agentMessage', text: 'Original fixture output.' },
            },
          ],
        },
      });
      break;
    case 'turn/interrupt':
      status = 'interrupted';
      emit({
        method: 'turn/completed',
        params: { threadId: thread.id, turn: { ...turn, status } },
      });
      emit({ id, result: {} });
      break;
    default:
      emit({ id, error: { message: 'Unsupported fixture request' } });
  }
});
