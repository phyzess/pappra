import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  statSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { HostIntegrationService } from '../../src/hosts/integration/service.js';
import { exportHostPluginBundle } from '../../src/hosts/integration/bundle-export.js';
import {
  mapNativeHookEvent,
  runHostHook,
} from '../../src/hosts/integration/hook.js';
import { createPiExtension } from '../../src/hosts/integration/pi-extension-runtime.js';
import type { HostHookInput } from '../../src/schemas/host.js';
import {
  baseWorkspaceConfig,
  cleanup,
  makeTempDir,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

function runtimeEntry(): string {
  return join(
    dirname(fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json'))),
    'dist',
    'hosts',
    'integration',
    'pappra-hook.mjs',
  );
}

function collaborationArtifact(name: string): string {
  return join(dirname(runtimeEntry()), name);
}

function workspace(): string {
  const root = makeTempDir('host-integration');
  writeWorkspaceConfig(
    root,
    baseWorkspaceConfig({
      repositories: [{ id: 'app', path: '.', access: 'write' }],
    }),
  );
  return root;
}

test('describes pinned host versions honestly and rejects unknown versions', () => {
  const root = workspace();
  try {
    const service = new HostIntegrationService({
      root,
      homeDir: makeTempDir('host-home'),
      pathEnv: '',
      hostVersion: '2.1.292',
      observedAt: '2026-10-19T00:00:00.000Z',
    });
    const claude = service.describe('claude');
    assert.equal(claude.version, '2.1.292');
    assert.equal(
      claude.capabilities.find((entry) => entry.event === 'compact')?.state,
      'unknown',
    );
    assert.equal(
      claude.capabilities.find((entry) => entry.event === 'checkpoint-request')
        ?.state,
      'unsupported',
    );
    assert.equal(claude.reloadRequired, true);
    assert.equal(claude.trustRequired, true);

    const unknown = new HostIntegrationService({
      root,
      homeDir: makeTempDir('host-home'),
      pathEnv: '',
      observedAt: '2026-10-19T00:00:00.000Z',
    }).describe('codex');
    assert.equal(unknown.version, null);
    assert.equal(
      unknown.capabilities.find((entry) => entry.event === 'startup')?.state,
      'unknown',
    );

    const unsupported = new HostIntegrationService({
      root,
      homeDir: makeTempDir('host-home'),
      pathEnv: '',
      hostVersion: '9.9.9',
      observedAt: '2026-10-19T00:00:00.000Z',
    }).describe('pi');
    assert.equal(
      unsupported.capabilities.find((entry) => entry.event === 'startup')
        ?.state,
      'unsupported',
    );
  } finally {
    cleanup(root);
  }
});

test('plans, installs, verifies and preserves a user Claude config', async () => {
  const root = workspace();
  const hostRoot = join(makeTempDir('host-claude'), 'home with spaces Ω');
  mkdirSync(hostRoot, { recursive: true });
  writeFileSync(
    join(hostRoot, 'settings.json'),
    `${JSON.stringify(
      {
        theme: 'dark',
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }],
          SessionStart: [
            {
              matcher: 'USER_MATCHER',
              hooks: [
                { type: 'command', command: 'echo pappra-managed-user-log' },
                { type: 'command', command: 'echo KEEP_USER_HOOK' },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  try {
    const service = new HostIntegrationService({
      root,
      homeDir: hostRoot,
      pathEnv: '',
      runtimeEntry: runtimeEntry(),
      hostVersion: '2.1.292',
      observedAt: '2026-10-19T00:00:00.000Z',
    });
    const plan = await service.plan('claude', { hostRoot });
    assert(plan.files.some((file) => file.path === 'skills/pappra/SKILL.md'));
    assert(
      plan.files.some(
        (file) => file.path === 'skills/pappra/references/lifecycle.md',
      ),
    );
    assert(
      plan.files.some((file) => file.path === 'templates/claude/hooks.json'),
    );
    assert(plan.files.some((file) => file.path === 'settings.json'));
    assert(plan.files.some((file) => file.path === 'pappra-host.json'));
    assert.equal(existsSync(join(hostRoot, 'skills')), false);

    const planned = await service.install('claude', { hostRoot, apply: false });
    assert.equal(planned.status, 'planned');
    assert.equal(existsSync(join(hostRoot, 'skills')), false);

    const installed = await service.install('claude', {
      hostRoot,
      apply: true,
    });
    assert.equal(installed.status, 'applied');
    const settings = JSON.parse(
      readFileSync(join(hostRoot, 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(settings['theme'], 'dark');
    const hooks = settings['hooks'] as Record<string, unknown>;
    assert(Array.isArray(hooks['Stop']));
    assert(Array.isArray(hooks['SessionStart']));
    assert(Array.isArray(hooks['PostCompact']));
    assert(JSON.stringify(hooks['SessionStart']).includes('pappra-managed'));
    assert(JSON.stringify(hooks['SessionStart']).includes('KEEP_USER_HOOK'));
    assert.equal(
      readFileSync(join(hostRoot, 'skills/pappra/SKILL.md'), 'utf8').includes(
        'name: pappra',
      ),
      true,
    );

    const verified = await service.verify('claude', { hostRoot });
    assert.equal(verified.status, 'verified');
    assert(
      verified.checks.some(
        (check) =>
          check.id === 'host.native-callability' && check.status === 'unknown',
      ),
    );

    const second = await new HostIntegrationService({
      root,
      homeDir: hostRoot,
      pathEnv: '',
      runtimeEntry: runtimeEntry(),
      hostVersion: '2.1.292',
      observedAt: '2026-10-19T00:00:01.000Z',
    }).install('claude', { hostRoot, apply: true });
    assert.equal(second.status, 'unchanged');

    writeFileSync(
      join(hostRoot, 'settings.json'),
      `${JSON.stringify({ theme: 'light', custom: { keep: true } }, null, 2)}\n`,
    );
    const merged = await service.install('claude', {
      hostRoot,
      apply: true,
    });
    assert.equal(merged.status, 'applied');
    const mergedSettings = JSON.parse(
      readFileSync(join(hostRoot, 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(mergedSettings['theme'], 'light');
    assert.deepEqual(mergedSettings['custom'], { keep: true });
    assert(JSON.stringify(mergedSettings['hooks']).includes('pappra-managed'));
    const verifiedAfterMerge = await service.verify('claude', { hostRoot });
    assert.equal(verifiedAfterMerge.status, 'verified');

    writeFileSync(
      join(hostRoot, 'skills/pappra/SKILL.md'),
      'USER_EDIT_SKILL\n',
    );
    const conflict = await service.install('claude', {
      hostRoot,
      apply: true,
    });
    assert.equal(conflict.status, 'conflict');
    assert.equal(
      readFileSync(join(hostRoot, 'skills/pappra/SKILL.md'), 'utf8'),
      'USER_EDIT_SKILL\n',
    );
    const stale = await service.verify('claude', { hostRoot });
    assert.equal(stale.status, 'conflict');
  } finally {
    cleanup(root);
    cleanup(hostRoot);
  }
});

test('installs Codex hooks without inventing compact support', async () => {
  const root = workspace();
  const hostRoot = makeTempDir('host-codex');
  try {
    writeFileSync(
      join(hostRoot, 'hooks.json'),
      `${JSON.stringify(
        {
          custom: { keep: true },
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user' }] }] },
        },
        null,
        2,
      )}\n`,
    );
    const service = new HostIntegrationService({
      root,
      homeDir: hostRoot,
      pathEnv: '',
      runtimeEntry: runtimeEntry(),
      hostVersion: '0.163.0',
      observedAt: '2026-10-19T00:00:00.000Z',
    });
    const result = await service.install('codex', { hostRoot, apply: true });
    assert.equal(result.status, 'applied');
    const hooks = JSON.parse(
      readFileSync(join(hostRoot, 'hooks.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.deepEqual(hooks['custom'], { keep: true });
    const hookMap = hooks['hooks'] as Record<string, unknown>;
    assert(Array.isArray(hookMap['Stop']));
    assert(Array.isArray(hookMap['SessionStart']));
    assert.equal('PostCompact' in hookMap, false);
    const verified = await service.verify('codex', { hostRoot });
    assert.equal(verified.status, 'verified');
    assert.equal(
      verified.capabilities.find((entry) => entry.event === 'compact')?.state,
      'unsupported',
    );
  } finally {
    cleanup(root);
    cleanup(hostRoot);
  }
});

test('installs a Pi extension shim with a relative runtime reference', async () => {
  const root = workspace();
  const hostRoot = makeTempDir('host-pi');
  try {
    const service = new HostIntegrationService({
      root,
      homeDir: hostRoot,
      pathEnv: '',
      runtimeEntry: runtimeEntry(),
      hostVersion: '1.3.0',
      observedAt: '2026-10-19T00:00:00.000Z',
    });
    const result = await service.install('pi', { hostRoot, apply: true });
    assert.equal(result.status, 'applied');
    const extension = readFileSync(
      join(hostRoot, 'extensions/pappra/index.ts'),
      'utf8',
    );
    assert(extension.includes('@earendil-works/pi-coding-agent'));
    assert(extension.includes('./runtime.mjs'));
    assert(!extension.includes('file:///'));
    assert(!extension.includes('src/hosts'));
    assert(extension.includes('createPiExtension'));
    assert.equal(existsSync(join(hostRoot, 'templates/pi/runtime.mjs')), true);
    assert.equal(
      readFileSync(join(hostRoot, 'skills/pappra/SKILL.md'), 'utf8').includes(
        '# Pappra',
      ),
      true,
    );
    const verified = await service.verify('pi', { hostRoot });
    assert.equal(verified.status, 'verified');
  } finally {
    cleanup(root);
    cleanup(hostRoot);
  }
});

test('exports host-native plugin bundles without registering them', async () => {
  const out = makeTempDir('host-plugin-bundle');
  try {
    const claude = await exportHostPluginBundle({
      host: 'claude',
      hostVersion: '2.1.292',
      outDir: join(out, 'claude'),
      packageVersion: '9.9.9',
    });
    assert(claude.files.includes('hooks/pappra-hook.mjs'));
    assert(claude.files.includes('.claude-plugin/plugin.json'));
    assert(claude.files.includes('skills/pappra/SKILL.md'));
    assert.equal(claude.verification, 'unsupported');
    assert.equal(
      JSON.stringify(
        JSON.parse(
          readFileSync(join(out, 'claude', 'hooks/hooks.json'), 'utf8'),
        ),
      ).includes('${CLAUDE_PLUGIN_ROOT}/hooks/pappra-hook.mjs'),
      true,
    );

    const codex = await exportHostPluginBundle({
      host: 'codex',
      hostVersion: '0.163.0',
      outDir: join(out, 'codex'),
      packageVersion: '9.9.9',
    });
    assert(codex.files.includes('.claude-plugin/plugin.json'));
    assert.equal(
      JSON.stringify(
        JSON.parse(
          readFileSync(join(out, 'codex', 'hooks/hooks.json'), 'utf8'),
        ),
      ).includes('./hooks/pappra-hook.mjs'),
      true,
    );

    const pi = await exportHostPluginBundle({
      host: 'pi',
      hostVersion: '1.3.0',
      outDir: join(out, 'pi'),
      packageVersion: '9.9.9',
    });
    assert(pi.files.includes('extensions/pappra/index.ts'));
    assert(pi.files.includes('extensions/pappra/runtime.mjs'));
    assert.equal(
      readFileSync(
        join(out, 'pi', 'extensions', 'pappra', 'index.ts'),
        'utf8',
      ).includes('./runtime.mjs'),
      true,
    );
    const manifest = JSON.parse(
      readFileSync(join(out, 'pi', 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.deepEqual((manifest.pi as Record<string, unknown>).extensions, [
      './extensions/pappra/index.ts',
    ]);
    assert.equal(pi.verification, 'unsupported');

    const marketplace = await exportHostPluginBundle({
      host: 'claude',
      hostVersion: '2.1.292',
      outDir: join(out, 'marketplace'),
      packageVersion: '9.9.9',
      marketplace: true,
    });
    assert.equal(marketplace.outDir, join(out, 'marketplace', 'pappra'));
    assert(marketplace.files.includes('.claude-plugin/marketplace.json'));
    assert(marketplace.files.includes('pappra/.claude-plugin/plugin.json'));
    assert(marketplace.files.includes('pappra/hooks/hooks.json'));
    assert(marketplace.files.includes('pappra/hooks/pappra-hook.mjs'));
    const marketplaceManifest = JSON.parse(
      readFileSync(
        join(out, 'marketplace', '.claude-plugin', 'marketplace.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    assert.deepEqual(
      (marketplaceManifest.plugins as readonly Record<string, unknown>[])[0]
        ?.source,
      './pappra',
    );
  } finally {
    cleanup(out);
  }
});

test('exports explicitly selected recovery and transition Pi extensions as movable packages', async () => {
  const out = makeTempDir('host-pi-collaboration-bundle');
  const outDir = join(out, 'opt-in');
  const configFile = join(out, 'private-recovery.json');
  const config = {
    schema: 'pappra/pi-recovery-config/1',
    taskRoot: join(out, 'task'),
    planFile: join(out, 'task', 'work-plan.json'),
    self: { agent_id: 'writer', session_id: 'native-session', harness: 'pi' },
    policy: { role: 'writer' },
    expected: {
      session_id: 'native-session',
      cwd: out,
      binding_ref: join(out, 'task', 'binding.json'),
      binding_digest: `sha256:${'a'.repeat(64)}`,
      pane_id: 'w3:p8',
      harness: 'pi',
    },
    mode: 'plan',
    target: { agent: 'writer' },
    requestId: 'recovery-request',
  };
  const configBytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(configFile, configBytes);
  try {
    const invalidConfig = join(out, 'invalid-recovery.json');
    writeFileSync(invalidConfig, '{}\n');
    await assert.rejects(
      exportHostPluginBundle({
        host: 'pi',
        hostVersion: '1.3.0',
        outDir: join(out, 'invalid-output'),
        packageVersion: '9.9.9',
        recovery: {
          configFile: invalidConfig,
          artifactPath: collaborationArtifact('pappra-recovery-extension.mjs'),
        },
      }),
      /recovery config is invalid/,
    );
    assert.equal(existsSync(join(out, 'invalid-output')), false);

    const bundle = await exportHostPluginBundle({
      host: 'pi',
      hostVersion: '1.3.0',
      outDir,
      packageVersion: '9.9.9',
      recovery: {
        configFile,
        artifactPath: collaborationArtifact('pappra-recovery-extension.mjs'),
      },
      transition: {
        artifactPath: collaborationArtifact(
          'pappra-session-transition-extension.mjs',
        ),
      },
    });

    assert.equal(bundle.verification, 'unsupported');
    assert.equal(bundle.recovery?.schema, 'pappra/pi-recovery-config/1');
    assert.equal(bundle.recovery?.registeredByExport, false);
    assert.equal(bundle.transition?.registeredByExport, false);
    assert.equal(bundle.transition?.nativeQuiescence, 'unavailable');
    assert(bundle.files.includes('extensions/pappra-recovery/index.ts'));
    assert(bundle.files.includes('extensions/pappra-recovery/runtime.mjs'));
    assert(bundle.files.includes('extensions/pappra-recovery/recovery.json'));
    assert(
      bundle.files.includes('extensions/pappra-session-transition/index.ts'),
    );
    assert(
      bundle.files.includes('extensions/pappra-session-transition/runtime.mjs'),
    );

    const manifest = JSON.parse(
      readFileSync(join(outDir, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.deepEqual((manifest.pi as Record<string, unknown>).extensions, [
      './extensions/pappra-recovery/index.ts',
      './extensions/pappra-session-transition/index.ts',
    ]);
    assert.equal(
      readFileSync(
        join(outDir, 'extensions/pappra-recovery/index.ts'),
        'utf8',
      ).includes('./runtime.mjs'),
      true,
    );
    assert.equal(
      readFileSync(
        join(outDir, 'extensions/pappra-session-transition/index.ts'),
        'utf8',
      ).includes('./runtime.mjs'),
      true,
    );
    const copiedConfig = join(
      outDir,
      'extensions/pappra-recovery/recovery.json',
    );
    assert.deepEqual(readFileSync(copiedConfig), configBytes);
    assert.equal(statSync(copiedConfig).mode & 0o777, 0o600);
    assert.equal(
      readFileSync(join(outDir, 'package.json'), 'utf8').includes(
        'native-session',
      ),
      false,
    );
    for (const path of [
      'extensions/pappra-recovery/runtime.mjs',
      'extensions/pappra-session-transition/runtime.mjs',
    ]) {
      const runtime = readFileSync(join(outDir, path), 'utf8');
      assert.equal(runtime.includes('file:///'), false);
      assert.equal(runtime.includes('src/hosts/integration'), false);
    }
    assert.equal(existsSync(outDir), true);
  } finally {
    cleanup(out);
  }
});

test('hooks deduplicate stable ids, keep distinct events and reject foreign cwd', async () => {
  const root = workspace();
  try {
    const base: HostHookInput = {
      schema: 'pappra/host-hook-input/1',
      host: 'claude',
      event: 'startup',
      nativeEvent: 'SessionStart',
      eventId: 'event-1',
      sessionId: 'session-1',
      cwd: root,
      root: null,
      taskId: null,
      source: 'startup',
      observedAt: '2026-10-19T00:00:00.000Z',
    };
    const first = await runHostHook(base);
    assert.equal(first.status, 'processed');
    assert.equal(first.duplicate, false);
    const duplicate = await runHostHook(base);
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(duplicate.duplicate, true);
    const distinct = await runHostHook({
      ...base,
      event: 'resume',
      source: 'resume',
      eventId: 'event-2',
    });
    assert.equal(distinct.status, 'processed');
    const noId = await runHostHook({
      ...base,
      eventId: null,
      observedAt: '2026-10-19T00:00:01.000Z',
    });
    assert.equal(noId.status, 'processed');
    assert.equal(noId.duplicate, false);

    const timed = await runHostHook(
      {
        ...base,
        eventId: 'event-timeout',
        observedAt: '2026-10-19T00:00:02.000Z',
      },
      {
        deadlineMs: 1,
        now: (() => {
          let value = 0;
          return () => {
            value += 2;
            return value;
          };
        })(),
      },
    );
    assert.equal(timed.status, 'timeout');

    const foreign = await runHostHook({
      ...base,
      eventId: 'event-3',
      cwd: makeTempDir('host-foreign'),
    });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.status, 'unsupported');

    const unsupported = await runHostHook({
      ...base,
      host: 'codex',
      event: 'compact',
      nativeEvent: 'PostCompact',
      eventId: 'event-4',
    });
    assert.equal(unsupported.status, 'unsupported');
    assert.equal(
      existsSync(join(root, '.pappra/local/host-events/codex')),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('maps only observed native event shapes', () => {
  const claude = mapNativeHookEvent(
    'claude',
    {
      hook_event_name: 'SessionStart',
      session_id: 's',
      cwd: '/tmp/example',
      source: 'resume',
      event_id: 'e',
    },
    'startup',
    null,
  );
  assert.equal(claude.ok, true);
  if (claude.ok) {
    assert.equal(claude.input.event, 'resume');
    assert.equal(claude.input.eventId, 'e');
  }
  const compact = mapNativeHookEvent(
    'claude',
    { hook_event_name: 'PostCompact', cwd: '/tmp/example' },
    'startup',
    null,
  );
  assert.equal(compact.ok, true);
  if (compact.ok) assert.equal(compact.input.event, 'compact');

  const unsupported = mapNativeHookEvent(
    'codex',
    { hook_event_name: 'PostCompact', cwd: '/tmp/example' },
    'startup',
    null,
  );
  assert.equal(unsupported.ok, false);

  const malformed = mapNativeHookEvent('pi', 'not-json', 'startup', null);
  assert.equal(malformed.ok, false);
});

test('generated hook entry and Pi adapter deliver bounded advisory context', async () => {
  const root = workspace();
  try {
    const entry = spawnSync(
      process.execPath,
      [runtimeEntry(), 'claude', 'startup'],
      {
        cwd: root,
        input: JSON.stringify({
          hook_event_name: 'SessionStart',
          cwd: root,
          source: 'startup',
          event_id: 'entry-advisory',
        }),
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    assert.equal(entry.status, 0, entry.stderr);
    const output: unknown = JSON.parse(entry.stdout);
    assert(typeof output === 'object' && output !== null);
    assert('hookSpecificOutput' in output);
    const hookOutput = output.hookSpecificOutput;
    assert(typeof hookOutput === 'object' && hookOutput !== null);
    assert('additionalContext' in hookOutput);
    assert(
      typeof hookOutput.additionalContext === 'string' &&
        hookOutput.additionalContext.includes('Pappra workspace') &&
        hookOutput.additionalContext.length <= 8192,
    );

    const handlers = new Map<
      string,
      (event: unknown, context: unknown) => Promise<void> | void
    >();
    const notifications: string[] = [];
    createPiExtension({
      on(event, handler) {
        handlers.set(event, handler);
      },
      registerCommand() {},
    });
    const handler = handlers.get('session_start');
    assert.notEqual(handler, undefined);
    await handler?.(
      {},
      {
        cwd: root,
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      },
    );
    assert.equal(notifications.length, 1);
    assert(notifications[0]?.includes('Pappra workspace'));
  } finally {
    cleanup(root);
  }
});

test('plugin install mode fails closed with per-host evidence', async () => {
  const root = workspace();
  const hostRoot = makeTempDir('host-plugin-mode');
  try {
    for (const [host, version, state] of [
      ['pi', '1.3.0', 'verified'],
      ['codex', '0.163.0', 'unsupported'],
      ['claude', '2.1.292', 'verified'],
    ] as const) {
      const service = new HostIntegrationService({
        root,
        homeDir: hostRoot,
        pathEnv: '',
        runtimeEntry: runtimeEntry(),
        hostVersion: version,
        observedAt: '2026-10-19T00:00:00.000Z',
      });
      const result = await service.install(host, {
        hostRoot,
        apply: true,
        mode: 'plugin',
      });
      assert.equal(result.status, 'unsupported', `${host} plugin mode`);
      assert.equal(result.appliedFiles.length, 0);
      assert.equal(existsSync(join(hostRoot, 'settings.json')), false);
      assert.equal(
        result.diagnostics.some((entry) =>
          JSON.stringify(entry).includes(state),
        ),
        true,
        `${host} reports ${state}`,
      );
    }
  } finally {
    cleanup(root);
    cleanup(hostRoot);
  }
});
