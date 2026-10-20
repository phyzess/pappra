import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './project.js';

for (const directory of ['dist', 'assets', '.build/test']) {
  rmSync(join(projectRoot, directory), { recursive: true, force: true });
}
