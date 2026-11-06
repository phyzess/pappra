import { realpathSync } from 'node:fs';
import { devNull, homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

export interface TestEnvironmentOptions {
  /** Only the named PAPPRA variables can be injected deliberately by this test case. */
  readonly allowPappra?: readonly string[];
}

/** Isolate test children without changing this process or unrelated native sessions. */
export function testSubprocessEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  options: TestEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^PAPPRA_/i.test(key) && !/^GIT_/i.test(key)) result[key] = value;
  }
  Object.assign(result, {
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
    LC_ALL: 'C',
  });
  const allowed = new Set(options.allowPappra ?? []);
  for (const [key, value] of Object.entries(overrides)) {
    if (!/^PAPPRA_/i.test(key) || allowed.has(key)) result[key] = value;
  }
  return result;
}

/** Give the default suite its own home and no inherited Herdr route. */
export function isolatedTestSuiteEnvironment(
  suiteHome: string,
): NodeJS.ProcessEnv {
  const root = realpathSync(suiteHome);
  const fromHome = relative(realpathSync(homedir()), root);
  if (
    fromHome === '' ||
    (!isAbsolute(fromHome) &&
      fromHome !== '..' &&
      !fromHome.startsWith(`..${sep}`))
  ) {
    throw new Error(
      'The test suite home must be outside the real home directory.',
    );
  }

  const env = testSubprocessEnvironment();
  for (const key of Object.keys(env)) {
    if (/^(HERDR_|XDG_|HOME$|USERPROFILE$|HOMEDRIVE$|HOMEPATH$)/i.test(key)) {
      delete env[key];
    }
  }
  return {
    ...env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_RUNTIME_DIR: join(root, 'run'),
    HERDR_BIN_PATH: join(root, 'disabled-herdr'),
    HERDR_SOCKET_PATH: join(root, 'disabled-herdr.sock'),
  };
}
