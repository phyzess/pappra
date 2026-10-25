import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  admit,
  applyFixes,
  applySkillAlias,
  collectChecks,
  inspectSkillAlias,
  PACKAGE_NAME,
  SKILL_ALIAS_TARGET,
} from '../../scripts/self-host.js';
import type { CliDeps, CliResult } from '../../scripts/self-host.js';

const packageRoot = dirname(
  fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json')),
);
const entry = join(packageRoot, 'scripts/self-host.ts');
const hostDirs = ['.agents', '.pi', '.claude'] as const;

interface FixtureOptions {
  readonly packageName?: string;
  readonly graph?: string;
  readonly withSource?: boolean;
  readonly withDist?: boolean;
}

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), 'pappra-self-host-'));
}

function withRoot(body: (root: string) => void): void {
  const root = temporaryRoot();
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(root: string, options: FixtureOptions = {}): void {
  writeJson(join(root, 'package.json'), {
    name: options.packageName ?? PACKAGE_NAME,
  });
  if (options.withSource !== false) {
    mkdirSync(join(root, 'skills', 'pappra'), { recursive: true });
    writeFileSync(join(root, 'skills', 'pappra', 'SKILL.md'), '# fixture\n');
  }
  mkdirSync(join(root, '.pappra'), { recursive: true });
  writeJson(join(root, '.pappra', 'workspace.json'), {
    workspaceId: 'workspace-fixture',
    repositories: [{ id: 'app', path: '.', access: 'write' }],
    knowledge: { sources: ['docs'], newDocuments: '.pappra/knowledge' },
    code: {
      graph: options.graph ?? 'codegraph',
      symbols: 'auto',
      prepare: 'on-demand',
    },
  });
  if (options.withDist === true) {
    mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
    writeFileSync(join(root, 'dist', 'cli', 'main.js'), 'process.exit(0);\n');
  }
}

interface FakeCli {
  readonly deps: CliDeps;
  readonly calls: readonly (readonly string[])[];
}

function fakeCli(respond: (args: readonly string[]) => CliResult): FakeCli {
  const calls: string[][] = [];
  const deps: CliDeps = {
    runCli: (args) => {
      calls.push([...args]);
      return respond(args);
    },
  };
  return { deps, calls };
}

function jsonResult(value: unknown): CliResult {
  return { status: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
}

function checkState(
  checks: readonly { id: string; state: string; detail: string }[],
  id: string,
): { id: string; state: string; detail: string } {
  const found = checks.find((check) => check.id === id);
  assert(found !== undefined, `missing check ${id}`);
  return found;
}

test('an unrelated repository root is refused without any write', () => {
  withRoot((root) => {
    fixture(root, { packageName: 'some-other-package' });
    const admission = admit(root);
    assert.equal(admission.ok, false);
    assert.equal(
      admission.ok === false && admission.check,
      'repository-admission',
    );
    assert.deepEqual(applyFixes(root), []);
    for (const host of hostDirs) {
      assert.equal(
        lstatSync(join(root, host), { throwIfNoEntry: false }),
        undefined,
      );
    }
  });
});

test('a missing canonical source is refused without writes', () => {
  withRoot((root) => {
    fixture(root, { withSource: false });
    const admission = admit(root);
    assert.equal(admission.ok, false);
    assert.match(admission.ok === false ? admission.detail : '', /is missing/);
    assert.deepEqual(applyFixes(root), []);
    assert.deepEqual(readdirSync(root).sort(), ['.pappra', 'package.json']);
  });
});

test('a redirected canonical source is refused without writes', () => {
  withRoot((root) => {
    fixture(root, { withSource: false });
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(join(elsewhere, 'pappra'), { recursive: true });
    writeFileSync(join(elsewhere, 'pappra', 'SKILL.md'), '# moved\n');
    symlinkSync(elsewhere, join(root, 'skills'), 'dir');
    const admission = admit(root);
    assert.equal(admission.ok, false);
    assert.match(
      admission.ok === false ? admission.detail : '',
      /must not be redirected/,
    );
    assert.deepEqual(applyFixes(root), []);
    assert.equal(
      lstatSync(join(root, '.pi'), { throwIfNoEntry: false }),
      undefined,
    );
  });
});

test('a matching raw alias is not linked when the source is gone', () => {
  withRoot((root) => {
    fixture(root);
    mkdirSync(join(root, '.pi', 'skills'), { recursive: true });
    symlinkSync(
      SKILL_ALIAS_TARGET,
      join(root, '.pi', 'skills', 'pappra'),
      'dir',
    );
    rmSync(join(root, 'skills'), { recursive: true, force: true });
    const state = inspectSkillAlias(root, 'pi');
    assert.equal(state.kind, 'conflict');
    assert.match(
      state.kind === 'conflict' ? state.detail : '',
      /does not resolve/,
    );
  });
});

test('a non-codegraph workspace stops every mutation and every child', () => {
  withRoot((root) => {
    fixture(root, { graph: 'hybrid', withDist: true });
    const cli = fakeCli(() => jsonResult({ ok: true }));
    const admission = admit(root);
    assert.equal(admission.ok, false);
    assert.equal(
      admission.ok === false && admission.check,
      'workspace-selection',
    );
    assert.deepEqual(applyFixes(root, cli.deps), []);
    assert.deepEqual(cli.calls, []);
    for (const host of hostDirs) {
      assert.equal(
        lstatSync(join(root, host), { throwIfNoEntry: false }),
        undefined,
      );
    }
  });
});

test('failed docs JSON is blocked, never read as registered', () => {
  withRoot((root) => {
    fixture(root, { withDist: true });
    const cli = fakeCli((args) =>
      args[0] === 'docs'
        ? jsonResult({ ok: false, code: 'docs_scan_failed', message: 'boom' })
        : jsonResult({ ok: false }),
    );
    const checks = collectChecks(root, cli.deps);
    const docs = checkState(checks, 'docs-registration');
    assert.equal(docs.state, 'blocked');
    assert.match(docs.detail, /docs_scan_failed/);
    assert.doesNotMatch(docs.detail, /undefined/);
  });
});

test('malformed docs output and incomplete summaries stay blocked', () => {
  withRoot((root) => {
    fixture(root, { withDist: true });
    const malformed = fakeCli(() => ({
      status: 0,
      stdout: 'not json\n',
      stderr: '',
    }));
    assert.equal(
      checkState(collectChecks(root, malformed.deps), 'docs-registration')
        .state,
      'blocked',
    );
    const incomplete = fakeCli((args) =>
      args[0] === 'docs' && args[1] === 'scan'
        ? jsonResult({ ok: true, candidates: [] })
        : jsonResult({ ok: true }),
    );
    const docs = checkState(
      collectChecks(root, incomplete.deps),
      'docs-registration',
    );
    assert.equal(docs.state, 'blocked');
    assert.match(docs.detail, /summary is incomplete/);
    assert.doesNotMatch(docs.detail, /undefined/);
  });
});

test('a failed or unreadable prepare plan never invokes apply', () => {
  withRoot((root) => {
    fixture(root, { withDist: true });
    const cli = fakeCli((args) => {
      if (args[1] === 'prepare') {
        return args.includes('--apply')
          ? jsonResult({ ok: true, status: 'ready' })
          : jsonResult({ ok: false, code: 'plan_failed', message: 'nope' });
      }
      return jsonResult({ ok: true, candidates: [] });
    });
    applyFixes(root, cli.deps);
    assert.equal(
      cli.calls.some((args) => args.includes('--apply')),
      false,
    );
    const unreadable = fakeCli((args) =>
      args[1] === 'prepare'
        ? { status: 0, stdout: '', stderr: '' }
        : jsonResult({ ok: true, candidates: [] }),
    );
    applyFixes(root, unreadable.deps);
    assert.equal(
      unreadable.calls.some((args) => args.includes('--apply')),
      false,
    );
  });
});

test('code status is an action only with an explicit health state', () => {
  withRoot((root) => {
    fixture(root, { withDist: true });
    const stale = fakeCli((args) =>
      args[1] === 'status'
        ? jsonResult({
            ok: false,
            health: { state: 'stale', reasons: ['source_changes_pending'] },
          })
        : jsonResult({ ok: true, candidates: [] }),
    );
    const staleCheck = checkState(
      collectChecks(root, stale.deps),
      'code-index',
    );
    assert.equal(staleCheck.state, 'action');
    assert.match(staleCheck.detail, /source_changes_pending/);
    const opaque = fakeCli((args) =>
      args[1] === 'status'
        ? jsonResult({ ok: false })
        : jsonResult({ ok: true, candidates: [] }),
    );
    const opaqueCheck = checkState(
      collectChecks(root, opaque.deps),
      'code-index',
    );
    assert.equal(opaqueCheck.state, 'blocked');
  });
});

test('an admitted root creates only the owned aliases, idempotently', () => {
  withRoot((root) => {
    fixture(root);
    const actions = applyFixes(root);
    assert.equal(actions.length, 3);
    assert.deepEqual(readdirSync(root).sort(), [
      '.agents',
      '.claude',
      '.pappra',
      '.pi',
      'package.json',
      'skills',
    ]);
    const linkPath = join(root, '.pi', 'skills', 'pappra');
    assert.equal(readlinkSync(linkPath), SKILL_ALIAS_TARGET);
    const inode = lstatSync(linkPath).ino;
    assert.equal(applySkillAlias(root, 'pi').kind, 'linked');
    assert.deepEqual(applyFixes(root), []);
    assert.equal(lstatSync(linkPath).ino, inode);
  });
});

test('user paths and symlinked parents are preserved', () => {
  withRoot((root) => {
    fixture(root);
    const userPath = join(root, '.claude', 'skills', 'pappra');
    mkdirSync(userPath, { recursive: true });
    writeFileSync(join(userPath, 'SKILL.md'), 'user copy\n');
    assert.equal(applySkillAlias(root, 'claude').kind, 'conflict');
    assert.equal(
      readFileSync(join(userPath, 'SKILL.md'), 'utf8'),
      'user copy\n',
    );
    const shared = join(root, 'shared-config');
    mkdirSync(shared);
    symlinkSync(shared, join(root, '.agents'), 'dir');
    assert.equal(applySkillAlias(root, 'agents').kind, 'refused');
    assert.equal(
      lstatSync(join(shared, 'skills'), { throwIfNoEntry: false }),
      undefined,
    );
  });
});

test('check mode leaves an unrelated root byte-identical', () => {
  withRoot((root) => {
    writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n');
    const before = readdirSync(root).sort();
    const result = spawnSync(process.execPath, [entry, '--check'], {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      timeout: 120_000,
    });
    if (result.error) throw result.error;
    assert.deepEqual(readdirSync(root).sort(), before);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /blocked repository-admission/);
  });
});

test('docs check reads the private catalog and surfaces review instead of success', () => {
  withRoot((root) => {
    fixture(root, { withDist: true });
    // A shared-only catalog would look converged; this workspace's private
    // documents are not current, so the flag must be passed and reported.
    const report = (includePrivate: boolean) =>
      jsonResult({
        schema: 'pappra/docs-check/1',
        ok: !includePrivate,
        entries: [],
        diagnostics: [],
        summary: includePrivate
          ? { total: 33, current: 32, needsReview: 1, unknown: 0 }
          : { total: 0, current: 0, needsReview: 0, unknown: 0 },
        coverage: {
          catalogs: includePrivate ? 'shared-and-private' : 'shared',
          pathReferences: 'unchecked',
          repositoryContent: 'not-scanned',
          taskExecution: 'unknown',
        },
      });
    const cli = fakeCli((args) => {
      if (args[0] === 'docs' && args[1] === 'scan') {
        return jsonResult({ ok: true, candidates: [] });
      }
      return report(args.includes('--include-private'));
    });
    const checks = collectChecks(root, cli.deps);
    const docs = checkState(checks, 'docs-registration');
    const full = checks.find((check) => check.id === 'docs-registration');
    assert(full !== undefined);
    const scanCall = cli.calls.find(
      (args) => args[0] === 'docs' && args[1] === 'scan',
    );
    const checkCall = cli.calls.find(
      (args) => args[0] === 'docs' && args[1] === 'check',
    );
    assert(scanCall !== undefined && checkCall !== undefined);
    // `docs scan` has no private flag; `docs check` must carry it.
    assert.equal(scanCall.includes('--include-private'), false);
    assert.equal(checkCall.includes('--include-private'), true);
    assert.equal(docs.state, 'action');
    assert.match(docs.detail, /1 of 33 registered or private document\(s\)/);
    assert.doesNotMatch(docs.detail, /no readable JSON/);
    assert.doesNotMatch(docs.detail, /current \(0 of 0\)/);
    // Review is an explicit route, never an automatic forget or re-approval.
    assert.match(full.command ?? '', /docs list --include-private --json/);
    assert.doesNotMatch(full.command ?? '', /forget|--apply/);
  });
});

test('a current private catalog converges with its own counts', () => {
  withRoot((root) => {
    fixture(root, { withDist: true });
    const cli = fakeCli((args) =>
      args[0] === 'docs' && args[1] === 'scan'
        ? jsonResult({ ok: true, candidates: [] })
        : jsonResult({
            schema: 'pappra/docs-check/1',
            ok: true,
            entries: [],
            diagnostics: [],
            summary: { total: 2, current: 2, needsReview: 0, unknown: 0 },
            coverage: {
              catalogs: 'shared-and-private',
              pathReferences: 'unchecked',
              repositoryContent: 'not-scanned',
              taskExecution: 'unknown',
            },
          }),
    );
    const docs = checkState(collectChecks(root, cli.deps), 'docs-registration');
    assert.equal(docs.state, 'ok');
    assert.match(docs.detail, /current \(2 of 2\)/);
  });
});

test('error diagnostics and inconsistent failures never become review actions', () => {
  withRoot((root) => {
    fixture(root, { withDist: true });
    const failing = fakeCli((args) => {
      if (args[0] === 'docs' && args[1] === 'scan') {
        return jsonResult({ ok: true, candidates: [] });
      }
      return jsonResult({
        schema: 'pappra/docs-check/1',
        ok: false,
        entries: [],
        diagnostics: [
          {
            severity: 'error',
            code: 'document_unreadable',
            message: 'Document is not readable.',
          },
        ],
        summary: { total: 3, current: 1, needsReview: 2, unknown: 0 },
      });
    });
    const errored = checkState(
      collectChecks(root, failing.deps),
      'docs-registration',
    );
    assert.equal(errored.state, 'blocked');
    assert.match(errored.detail, /document_unreadable/);
    const inconsistent = fakeCli((args) => {
      if (args[0] === 'docs' && args[1] === 'scan') {
        return jsonResult({ ok: true, candidates: [] });
      }
      return jsonResult({
        schema: 'pappra/docs-check/1',
        ok: false,
        entries: [],
        diagnostics: [],
        summary: { total: 2, current: 2, needsReview: 0, unknown: 0 },
      });
    });
    const wrong = checkState(
      collectChecks(root, inconsistent.deps),
      'docs-registration',
    );
    assert.equal(wrong.state, 'blocked');
    assert.match(wrong.detail, /inconsistent/);
  });
});
