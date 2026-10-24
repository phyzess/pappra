import fs from 'node:fs';
import path from 'node:path';
import {
  executeRecovery,
  type RecoveryExecutionRequest,
} from '../../src/app/collab-recovery-executor.js';

const config = JSON.parse(process.argv[2]!) as {
  mode: 'initial-empty' | 'resume-claim' | 'resumed-empty';
  request: RecoveryExecutionRequest;
};
const fsync = fs.fsyncSync;
fs.fsyncSync = (fd) => {
  fsync(fd);
  const stat = fs.fstatSync(fd);
  const directory = path.join(
    config.request.taskRoot,
    '.recovery',
    'reservations',
  );
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    const candidate = fs.lstatSync(file);
    if (candidate.dev !== stat.dev || candidate.ino !== stat.ino) continue;
    if (config.mode === 'resume-claim' && name.includes('.resume-'))
      process.kill(process.pid, 'SIGKILL');
    if (!name.endsWith('.json')) continue;
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      generation?: number;
      journal: unknown[];
      final?: unknown;
    };
    if (value.journal.length !== 0 || value.final !== undefined) continue;
    if (
      (config.mode === 'initial-empty' && value.generation === undefined) ||
      (config.mode === 'resumed-empty' && value.generation !== undefined)
    )
      process.kill(process.pid, 'SIGKILL');
  }
};

void executeRecovery(config.request, {
  controller: {
    id: 'crash-window-fixture',
    perform: async () => ({
      disposition: 'submitted',
      observation: 'applied',
      detail: 'fixture dispatch',
    }),
  },
})
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })
  .catch(() => {
    process.exitCode = 1;
  });
