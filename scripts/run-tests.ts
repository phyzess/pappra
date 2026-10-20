import { join } from 'node:path';
import { listFiles, projectRoot, runNode } from './project.js';

const files = listFiles(join(projectRoot, '.build/test/tests'))
  .filter((file) => file.endsWith('.test.js'))
  .sort();
if (files.length === 0) throw new Error('No compiled tests were found.');
// Real-engine fixtures spawn bounded CodeGraph processes. Four workers keep
// CPU contention from starving unrelated Git/CLI timeout tests.
runNode(['--test', '--test-concurrency=4', ...files]);
