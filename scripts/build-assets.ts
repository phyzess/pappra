import { chmodSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './project.js';

mkdirSync(join(projectRoot, 'assets'), { recursive: true });
cpSync(join(projectRoot, 'src/assets'), join(projectRoot, 'assets'), {
  recursive: true,
});
chmodSync(join(projectRoot, 'dist/cli/main.js'), 0o755);
