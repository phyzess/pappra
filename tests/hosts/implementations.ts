import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as claude from '../../src/hosts/claude/native.js';
import * as codex from '../../src/hosts/codex/native.js';
import * as pi from '../../src/hosts/pi/rpc.js';
import * as piHistory from '../../src/hosts/pi/query-result.js';
import * as pilot from '../../src/hosts/pilot.js';
import * as groups from '../../src/infra/owned-process-group.js';
import { object } from '../../src/collab/validation.js';

const current = { claude, codex, pi, piHistory, pilot, groups };
const files = {
  claude: 'claude-native.mjs',
  codex: 'codex-native.mjs',
  pi: 'pi-rpc.mjs',
  piHistory: 'query-pi-result.mjs',
  pilot: 'run-native-pilot.mjs',
  groups: 'owned-process-group.mjs',
};

/** Optional test-only ABI binding to the exact source materialized by compare-legacy. */
export async function implementation<Key extends keyof typeof current>(
  key: Key,
): Promise<(typeof current)[Key]> {
  const root = process.env['PAPPRA_LEGACY_FIXTURE'];
  if (!root) return current[key];
  const loaded: unknown = await import(
    pathToFileURL(join(root, 'scripts', files[key])).href
  );
  assert(object(loaded));
  for (const [name, value] of Object.entries(current[key]))
    assert.equal(typeof loaded[name], typeof value, `${key}.${name}`);
  return loaded as (typeof current)[Key];
}
