import { join } from 'node:path';
import { listFiles, projectRoot, runNode } from './project.js';
import { testSubprocessEnvironment } from './test-environment.js';

const files = listFiles(join(projectRoot, '.build/test/tests'))
  .filter((file) => file.endsWith('.test.js'))
  .sort();
if (files.length === 0) throw new Error('No compiled tests were found.');
// Real-engine fixtures spawn bounded CodeGraph processes. Four workers keep
// CPU contention from starving unrelated Git/CLI timeout tests.
// The complete real-engine/CLI matrix exceeded the former six-minute ceiling
// with passing tests still active. Keep other commands' existing deadline.
runNode(
  ['--test', '--test-concurrency=4', ...files],
  projectRoot,
  900_000,
  testSubprocessEnvironment(),
);
