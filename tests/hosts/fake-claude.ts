#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const stateFile = process.env['PAPPRA_FAKE_STATE'];
const traceFile = process.env['PAPPRA_FAKE_TRACE'];
if (!stateFile || !traceFile) throw new Error('Fixture paths are required.');
appendFileSync(traceFile, `${JSON.stringify(process.argv.slice(2))}\n`);
const [command, key] = process.argv.slice(2);
if (command === 'agents') console.log(readFileSync(stateFile, 'utf8'));
else if (command === 'logs' && key === 'deadbeef')
  console.log('\u001b[32mFixture output\u001b[0m');
else if (command === 'stop' && key === 'deadbeef') {
  writeFileSync(
    stateFile,
    JSON.stringify([
      {
        id: 'deadbeef',
        sessionId: '12345678-1234-4234-8234-123456789012',
        kind: 'background',
        cwd: process.cwd(),
        state: 'done',
        startedAt: 456,
      },
    ]),
  );
} else process.exitCode = 2;
