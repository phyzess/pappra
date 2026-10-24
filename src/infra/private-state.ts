import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { diagnosticCodes } from '../schemas/errors.js';
import {
  errorMessage,
  failed,
  succeeded,
  type Outcome,
} from '../schemas/outcome.js';
import { observePath, resolveRealpath } from './fs.js';

const MAX_IGNORE_BYTES = 64 * 1024;

interface NamespaceIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

function hasFinalIgnoreAll(text: string): boolean {
  const rules = text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line !== '' && !line.startsWith('#'));
  return rules.at(-1) === '*';
}

/**
 * Prepare private state before its first write, independently of init. Existing
 * ignore rules are preserved; an appended final wildcard prevents earlier
 * negations from exposing machine paths, checkpoints, or task metadata.
 */
export async function ensurePrivateState(
  root: string,
  directory: 'local' | 'local-archive' = 'local',
): Promise<Outcome<null>> {
  if (directory !== 'local' && directory !== 'local-archive')
    return failed(
      diagnosticCodes.initTargetUnsafe,
      'Unknown private-state namespace.',
      { nextAction: 'Use a supported private-state directory.' },
    );
  const canonical = await resolveRealpath(root);
  if (canonical === null)
    return failed(
      diagnosticCodes.initTargetUnsafe,
      `Cannot resolve the private-state workspace: ${root}`,
      { nextAction: 'Use an existing workspace root.' },
    );
  const pinned: NamespaceIdentity[] = [];
  const assertCurrent = async (): Promise<void> => {
    for (const identity of pinned) {
      const current = await observePath(identity.path);
      if (
        current.kind !== 'directory' ||
        current.stats?.dev !== identity.dev ||
        current.stats.ino !== identity.ino
      ) {
        throw new Error(`Private-state namespace changed: ${identity.path}`);
      }
    }
  };
  const local = join(canonical, '.pappra', directory);
  const ignore = join(local, '.gitignore');
  try {
    for (const path of [canonical, join(canonical, '.pappra'), local]) {
      await assertCurrent();
      let observation = await observePath(path);
      if (observation.kind === 'missing' && path !== canonical) {
        await mkdir(path, { mode: 0o700 }).catch(async (error: unknown) => {
          if ((await observePath(path)).kind !== 'directory') throw error;
        });
        observation = await observePath(path);
      }
      if (
        observation.kind !== 'directory' ||
        observation.stats === null ||
        (await resolveRealpath(path)) !== path
      ) {
        throw new Error(
          `Private-state namespace is redirected or not a directory: ${path}`,
        );
      }
      pinned.push({
        path,
        dev: observation.stats.dev,
        ino: observation.stats.ino,
      });
    }
    await assertCurrent();
    let observation = await observePath(ignore);
    if (observation.kind === 'missing') {
      let created;
      try {
        created = await open(
          ignore,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_APPEND |
            constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if ((await observePath(ignore)).kind === 'missing') throw error;
      }
      if (created !== undefined) {
        try {
          await assertCurrent();
          await created.writeFile('*\n');
          await created.sync();
          const stats = await created.stat();
          observation = await observePath(ignore);
          if (
            observation.kind !== 'file' ||
            observation.stats?.dev !== stats.dev ||
            observation.stats.ino !== stats.ino
          ) {
            throw new Error(
              `Private-state ignore file changed during creation: ${ignore}`,
            );
          }
          await assertCurrent();
        } finally {
          await created.close();
        }
      }
      observation = await observePath(ignore);
    }
    if (observation.kind !== 'file' || observation.stats === null)
      throw new Error(
        `Private-state ignore path is not a regular file: ${ignore}`,
      );
    const handle = await open(
      ignore,
      constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
    );
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.dev !== observation.stats.dev ||
        stats.ino !== observation.stats.ino
      ) {
        throw new Error(`Private-state ignore identity changed: ${ignore}`);
      }
      const readText = async (): Promise<string> => {
        const bytes = Buffer.alloc(MAX_IGNORE_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(
            bytes,
            length,
            bytes.length - length,
            length,
          );
          if (read.bytesRead === 0) break;
          length += read.bytesRead;
        }
        if (length > MAX_IGNORE_BYTES)
          throw new Error(
            `Private-state ignore file exceeds ${MAX_IGNORE_BYTES} bytes: ${ignore}`,
          );
        return new TextDecoder('utf-8', { fatal: true }).decode(
          bytes.subarray(0, length),
        );
      };
      const text = await readText();
      await assertCurrent();
      if (!hasFinalIgnoreAll(text)) {
        // O_APPEND preserves existing bytes even if another writer extends the
        // file after it was read; no user file is replaced or truncated.
        await handle.writeFile(
          `${text.endsWith('\n') || text === '' ? '' : '\n'}*\n`,
        );
        await handle.sync();
      }
      const current = await observePath(ignore);
      if (
        current.kind !== 'file' ||
        current.stats?.dev !== stats.dev ||
        current.stats.ino !== stats.ino ||
        !hasFinalIgnoreAll(await readText())
      ) {
        throw new Error(
          `Private-state ignore file changed during preparation: ${ignore}`,
        );
      }
      await assertCurrent();
      return succeeded(null);
    } finally {
      await handle.close();
    }
  } catch (error) {
    return failed(
      diagnosticCodes.initTargetUnsafe,
      `Cannot prepare private state: ${errorMessage(error)}`,
      {
        nextAction: `Restore real .pappra/${directory} directories and a writable regular .gitignore; existing state and rules were preserved.`,
      },
    );
  }
}
