import { devNull } from 'node:os';

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
