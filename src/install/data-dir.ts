import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Kept in its own dependency-free module so a hot path such as the status-line beacon does
 * not load the runtime installer just to find the user data directory.
 */
export function resolveUserDataDir(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (environment['PAPPRA_DATA_HOME'] !== undefined) {
    return resolve(environment['PAPPRA_DATA_HOME']);
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Pappra');
  }
  if (platform === 'win32') {
    return join(environment['LOCALAPPDATA'] ?? home, 'Pappra');
  }
  return join(
    environment['XDG_DATA_HOME'] ?? join(home, '.local', 'share'),
    'pappra',
  );
}
