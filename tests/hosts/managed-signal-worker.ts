import fs from 'node:fs';
import path from 'node:path';
import { startManagedPiSession } from '../../src/hosts/pi/managed-session.js';

const root = process.argv[2]!;
const controller = await startManagedPiSession({
  cwd: root,
  model: 'fixture/no-provider',
  piBin: path.join(root, 'fake-pi'),
  journalPath: path.join(root, 'controller.jsonl'),
  controlSocketPath: path.join(root, 'controller.sock'),
  shutdownGraceMs: 50,
});
fs.writeFileSync(
  path.join(root, 'ready.json'),
  JSON.stringify({
    pid: process.pid,
    raw: process.stdin.isRaw,
    identity: controller.identity,
  }),
);
const exit = await controller.waitForExit();
controller.close();
fs.writeFileSync(
  path.join(root, 'result.json'),
  JSON.stringify({ raw: process.stdin.isRaw, exit }),
);
