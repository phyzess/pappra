#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const directory = args[args.indexOf('--session-dir') + 1];
const session = args[args.indexOf('--session-id') + 1];
if (!directory || !session) throw new Error('A fixture session is required.');
mkdirSync(directory, { recursive: true });
writeFileSync(
  join(directory, `${session}.jsonl`),
  `${JSON.stringify({ type: 'session', id: session, cwd: process.cwd() })}\n`,
);
console.log('Fixture pilot completed.');
