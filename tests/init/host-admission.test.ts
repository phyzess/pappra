import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { deriveInitChoices, inspectInitContext } from '../../src/app/init.js';
import { HOST_EVENT_VERSIONS } from '../../src/hosts/integration/support.js';
import {
  cleanup,
  createRepository,
  makeTempDir,
} from '../workspace/fixtures.js';

type HostName = 'claude' | 'codex' | 'pi';
const hosts: readonly HostName[] = ['claude', 'codex', 'pi'];

/**
 * A version probe whose answer comes from a fixture: `output` prints a version,
 * `unreadable` exits non-zero, and an absent entry leaves the executable off
 * PATH. The fixture PATH contains only that directory, so no host installed on
 * the machine running the suite can influence the result.
 */
type Probe = { readonly output: string } | 'unreadable';

function probeBin(probes: Partial<Record<HostName, Probe>>): string {
  const directory = makeTempDir('init-host-bin');
  for (const host of hosts) {
    const probe = probes[host];
    if (probe === undefined) continue;
    const file = join(directory, host);
    writeFileSync(
      file,
      probe === 'unreadable'
        ? '#!/bin/sh\nexit 1\n'
        : `#!/bin/sh\necho "${probe.output}"\n`,
    );
    chmodSync(file, 0o755);
  }
  return directory;
}

interface DerivedHosts {
  readonly selected: readonly string[];
  readonly reasons: ReadonlyMap<string, string>;
}

async function deriveHosts(
  probes: Partial<Record<HostName, Probe>>,
): Promise<DerivedHosts> {
  const root = makeTempDir('init-host-repo');
  const bin = probeBin(probes);
  try {
    createRepository(root);
    const inspected = await inspectInitContext(root);
    assert.equal(
      inspected.ok,
      true,
      inspected.ok ? '' : `${inspected.code}: ${inspected.message}`,
    );
    if (!inspected.ok) throw new Error('init context unavailable');
    const derived = await deriveInitChoices(inspected.context.discovery, {
      pathEnv: bin,
    });
    const reasons = new Map<string, string>();
    for (const rule of derived.rules) {
      if (rule.field === 'hosts') reasons.set(rule.value, rule.reason);
    }
    assert.equal(
      reasons.size,
      hosts.length,
      'every host reports exactly one selection reason',
    );
    return { selected: derived.choices.hosts, reasons };
  } finally {
    cleanup(bin);
    cleanup(root);
  }
}

function reasonFor(derived: DerivedHosts, host: HostName): string {
  const reason = derived.reasons.get(host);
  assert(reason !== undefined, `no reason recorded for ${host}`);
  return reason;
}

test('init admits the reference default version of a host', async () => {
  // HOST_SUPPORT.codex.version is the reference default; it is also admitted.
  const derived = await deriveHosts({ codex: { output: 'codex-cli 0.163.0' } });
  assert.deepEqual(derived.selected, ['codex']);
  const reason = reasonFor(derived, 'codex');
  assert.match(reason, /0\.163\.0/);
  assert.match(reason, /admitted for lifecycle events/);
});

test('init admits another version the event matrix accepts', async () => {
  // Regression: 0.164.0 is in HOST_EVENT_VERSIONS but is not the reference
  // default, so a reference-default equality test rejected it.
  assert.equal(HOST_EVENT_VERSIONS.codex.includes('0.164.0'), true);
  const derived = await deriveHosts({ codex: { output: 'codex-cli 0.164.0' } });
  assert.deepEqual(derived.selected, ['codex']);
  const reason = reasonFor(derived, 'codex');
  assert.match(reason, /0\.164\.0/);
  assert.match(reason, /admitted for lifecycle events/);
  assert.doesNotMatch(reason, /outside the admitted/);
});

test('init rejects a version the event matrix does not accept', async () => {
  const derived = await deriveHosts({ codex: { output: 'codex-cli 0.165.0' } });
  assert.deepEqual(derived.selected, []);
  const reason = reasonFor(derived, 'codex');
  assert.match(reason, /0\.165\.0/);
  assert.match(reason, /outside the admitted event-contract versions/);
});

test('init does not admit a same-minor patch outside the event matrix', async () => {
  // 0.163.1 shares the reference default's minor version; presence on PATH and
  // a same-minor number are not admission.
  const derived = await deriveHosts({ codex: { output: 'codex-cli 0.163.1' } });
  assert.deepEqual(derived.selected, []);
  assert.match(
    reasonFor(derived, 'codex'),
    /outside the admitted event-contract versions/,
  );
});

test('init reports an unreadable version separately from a missing host', async () => {
  const unreadable = await deriveHosts({ claude: 'unreadable' });
  assert.deepEqual(unreadable.selected, []);
  assert.match(
    reasonFor(unreadable, 'claude'),
    /observed but reported no readable version/,
  );

  const missing = await deriveHosts({});
  assert.deepEqual(missing.selected, []);
  assert.match(reasonFor(missing, 'claude'), /not observed on PATH/);
});

test('admission does not claim host loading, trust or callability', async () => {
  const derived = await deriveHosts({
    claude: { output: '2.1.308 (Claude Code)' },
    codex: { output: 'codex-cli 0.164.0' },
    pi: { output: '1.4.0' },
  });
  assert.deepEqual(derived.selected, ['claude', 'codex', 'pi']);
  for (const host of hosts) {
    const reason = reasonFor(derived, host);
    assert.match(reason, /admitted for lifecycle events/);
    assert.match(reason, /loading, trust and callability still need/);
    assert.match(reason, /explicit native check/);
    assert.doesNotMatch(reason, /verified|trusted|callable:/);
  }
});
