#!/usr/bin/env node
import { createInterface } from 'node:readline';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { object, parseJson } from '../../src/collab/validation.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const selector = flag('--session-id') ?? flag('--session');
const sessionDir = flag('--session-dir');
let sessionId = selector;
if (!sessionId || !sessionDir)
  throw new Error('A fixture session is required.');
mkdirSync(sessionDir, { recursive: true });
const sessionFile =
  selector && existsSync(selector)
    ? selector
    : join(sessionDir, `${sessionId}.jsonl`);
if (existsSync(sessionFile)) {
  const header = parseJson(
    readFileSync(sessionFile, 'utf8').split('\n')[0] ?? '',
  );
  if (!object(header) || typeof header['id'] !== 'string')
    throw new Error('Invalid fixture header');
  sessionId = header['id'];
} else
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: 'session', id: sessionId, cwd: process.cwd() })}\n`,
  );
const emit = (record: unknown) =>
  process.stdout.write(`${JSON.stringify(record)}\n`);
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = parseJson(line);
  if (!object(request)) return;
  const trace = process.env['FAKE_PI_TRACE'];
  if (trace) appendFileSync(trace, `${JSON.stringify(request)}\n`);
  if (process.env['FAKE_PI_FAIL_COMMAND'] === request['type']) {
    emit({
      type: 'response',
      id: request['id'],
      command: request['type'],
      success: false,
      error: 'Synthetic fixture command failure',
    });
    return;
  }
  const response = (data: unknown = {}) =>
    emit({
      type: 'response',
      id: request['id'],
      command: request['type'],
      success: true,
      data,
    });
  switch (request['type']) {
    case 'get_state':
      response({
        sessionId,
        sessionFile,
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        messageCount: 0,
      });
      break;
    case 'get_messages':
      response({
        messages: readFileSync(sessionFile, 'utf8')
          .trim()
          .split('\n')
          .slice(1)
          .map(parseJson),
      });
      break;
    case 'get_session_stats':
      response({
        sessionId,
        sessionFile,
        userMessages: 0,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 1,
      });
      break;
    case 'prompt':
      if (process.env['FAKE_PI_ASSISTANT'] === '1') {
        appendFileSync(
          sessionFile,
          `${JSON.stringify({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'fixture task completed' }],
            stopReason: 'stop',
          })}\n`,
        );
      }
      response({ disposition: 'started' });
      emit({ type: 'agent_settled' });
      break;
    case 'clear_queue':
      response({ steering: [], followUp: [] });
      break;
    case 'abort':
      emit({ type: 'agent_settled' });
      response();
      break;
    default:
      emit({
        type: 'response',
        id: request['id'],
        command: request['type'],
        success: false,
        error: 'Unsupported fixture command',
      });
  }
});
