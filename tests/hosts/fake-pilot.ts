#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 0 || separator !== args.length - 2)
  throw new Error(
    'The fake native launcher requires one prompt operand after --.',
  );
writeFileSync(join(process.cwd(), 'pilot-argv.json'), JSON.stringify(args));
const harness = basename(process.argv[1] ?? '');
if (harness === 'codex') {
  console.log(
    JSON.stringify({
      type: 'thread.started',
      thread_id: '12345678-1234-4234-8234-123456789012',
    }),
  );
  process.exit(0);
}
if (harness === 'claude') {
  const id = args[args.indexOf('--session-id') + 1];
  console.log(
    JSON.stringify({ type: 'system', subtype: 'init', session_id: id }),
  );
  process.exit(0);
}
const directory = args[args.indexOf('--session-dir') + 1];
const session = args[args.indexOf('--session-id') + 1];
if (!directory || !session) throw new Error('A fixture session is required.');
mkdirSync(directory, { recursive: true });
writeFileSync(
  join(directory, `${session}.jsonl`),
  `${JSON.stringify({ type: 'session', id: session, cwd: process.cwd() })}\n`,
);
console.log('Fixture pilot completed.');
