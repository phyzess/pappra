import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  createRepository,
  snapshotTree,
  writeMachineConfig,
  writeText,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

const repositoryRoot = dirname(
  fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json')),
);
const cliPath = join(repositoryRoot, 'dist', 'cli', 'main.js');

const pythonPtyDriver = String.raw`
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

config = json.loads(sys.argv[1])
output = bytearray()
search_offset = 0
max_output = 1_000_000


def cleaned():
    value = bytes(output)
    value = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', value)
    value = re.sub(rb'\x1b\][^\x07]*(?:\x07|\x1b\\)', b'', value)
    return value.replace(b'\r', b'\n')


def read_available(timeout):
    ready, _, _ = select.select([master], [], [], timeout)
    if not ready:
        return
    try:
        chunk = os.read(master, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            return
        raise
    if chunk:
        output.extend(chunk)
        if len(output) > max_output:
            raise RuntimeError('PTY transcript exceeded its bounded output limit')


def wait_for(pattern, timeout_seconds=12):
    global search_offset, child_reaped
    expression = re.compile(pattern.encode('utf-8'), re.S)
    deadline = time.monotonic() + timeout_seconds
    while True:
        match = expression.search(cleaned(), search_offset)
        if match is not None:
            search_offset = match.end()
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            tail = cleaned()[-6000:].decode('utf-8', errors='replace')
            raise TimeoutError(f'timed out waiting for {pattern!r}; transcript tail:\n{tail}')
        exited, _ = os.waitpid(child, os.WNOHANG)
        if exited == child:
            child_reaped = True
            tail = cleaned()[-6000:].decode('utf-8', errors='replace')
            raise RuntimeError(f'CLI exited before {pattern!r}; transcript tail:\n{tail}')
        read_available(min(remaining, 0.2))


child, master = pty.fork()
child_reaped = False
if child == 0:
    try:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', config['rows'], config['columns'], 0, 0))
        os.chdir(config['cwd'])
        child_env = os.environ.copy()
        child_env.pop('PAPPRA_TTY_EVIDENCE_DIR', None)
        child_env.update(config['env'])
        os.execvpe(config['command'][0], config['command'], child_env)
    except BaseException as error:
        os.write(2, f'PTY child setup failed: {error}\n'.encode())
        os._exit(127)

try:
    for step in config['steps']:
        wait_for(step['pattern'], step.get('timeout_seconds', 12))
        os.write(master, step['send'].encode('utf-8'))
    deadline = time.monotonic() + config.get('completion_timeout_seconds', 20)
    status = None
    while status is None:
        exited, wait_status = os.waitpid(child, os.WNOHANG)
        if exited == child:
            child_reaped = True
            status = os.waitstatus_to_exitcode(wait_status)
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            os.kill(child, signal.SIGTERM)
            try:
                os.waitpid(child, 0)
            except ChildProcessError:
                pass
            child_reaped = True
            raise TimeoutError('fixture CLI did not exit within its bounded completion timeout')
        read_available(min(remaining, 0.2))
    while True:
        ready, _, _ = select.select([master], [], [], 0.1)
        if not ready:
            break
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        output.extend(chunk)
        if len(output) > max_output:
            raise RuntimeError('PTY transcript exceeded its bounded output limit')
    sys.stdout.buffer.write(bytes(output))
    if status < 0:
        status = 128 + abs(status)
    sys.exit(status)
except SystemExit:
    raise
except BaseException as error:
    if not child_reaped:
        try:
            os.kill(child, signal.SIGTERM)
        except OSError:
            pass
        try:
            os.waitpid(child, 0)
        except ChildProcessError:
            pass
    sys.stdout.buffer.write(bytes(output))
    print(f'PTY driver failure: {error}', file=sys.stderr)
    sys.exit(124)
finally:
    try:
        os.close(master)
    except OSError:
        pass
`;

const ptyProbe = spawnSync('python3', ['-c', 'import fcntl, pty, termios'], {
  encoding: 'utf8',
  shell: false,
  timeout: 5_000,
});
const ptySkip =
  process.platform === 'win32' || ptyProbe.status !== 0
    ? 'POSIX Python PTY facilities are unavailable on this platform.'
    : false;

function runRealTty(
  workspace: string,
  dataHome: string,
  args: readonly string[],
  steps: readonly { readonly pattern: string; readonly send: string }[],
) {
  const result = spawnSync(
    'python3',
    [
      '-c',
      pythonPtyDriver,
      JSON.stringify({
        command: [process.execPath, cliPath, 'init', ...args],
        cwd: workspace,
        rows: 48,
        columns: 140,
        completion_timeout_seconds: 20,
        env: {
          PAPPRA_DATA_HOME: dataHome,
          NO_COLOR: '1',
          TERM: 'xterm-256color',
          COLUMNS: '140',
          LINES: '48',
        },
        steps,
      }),
    ],
    {
      cwd: workspace,
      encoding: 'utf8',
      shell: false,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function readableTranscript(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\r/g, '\n');
}

function recordTtyEvidence(
  name: string,
  run: ReturnType<typeof runRealTty>,
  workspace: string,
  before: ReturnType<typeof snapshotTree>,
  after: ReturnType<typeof snapshotTree>,
  dataHome: string,
): void {
  const evidenceDirectory = process.env.PAPPRA_TTY_EVIDENCE_DIR;
  if (evidenceDirectory === undefined) return;
  if (!evidenceDirectory.startsWith('/')) {
    throw new Error('PAPPRA_TTY_EVIDENCE_DIR must be an absolute path');
  }
  mkdirSync(evidenceDirectory, { recursive: true });
  const transcript = readableTranscript(`${run.stdout}\n${run.stderr}`).slice(
    -60_000,
  );
  writeFileSync(join(evidenceDirectory, `${name}.transcript.txt`), transcript);
  writeFileSync(
    join(evidenceDirectory, `${name}.outcome.json`),
    `${JSON.stringify(
      {
        scenario: name,
        exit_code: run.status,
        workspace,
        workspace_unchanged: JSON.stringify(before) === JSON.stringify(after),
        data_home_exists_after: existsSync(dataHome),
        transcript_truncated_to_last_characters: 60_000,
      },
      null,
      2,
    )}\n`,
  );
}

test(
  'real TTY fresh init adds bounded paths, corrects destination in place, and cancels before mutation',
  { skip: ptySkip },
  async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'pappra-init-tty-fresh-'));
    const workspace = join(temporary, 'fresh-default-workspace');
    const dataHome = join(temporary, 'pappra-data');
    try {
      mkdirSync(workspace, { recursive: true });
      createRepository(join(workspace, 'projects/one/two/three/explicit-repo'));
      mkdirSync(join(workspace, 'notes', 'empty'), { recursive: true });
      const before = snapshotTree(workspace);
      const steps = [
        { pattern: 'Workspace name', send: '' },
        {
          pattern: 'fresh-default-workspace',
          send: '\u0001\u000bFresh TTY workspace\r',
        },
        { pattern: 'Section navigation', send: '\r' },
        { pattern: 'Select repositories in this workspace', send: '' },
        { pattern: 'Add existing repository', send: ' \r' },
        {
          pattern: 'Existing repository path under workspace root',
          send: 'projects/one/two/three/explicit-repo\r',
        },
        { pattern: 'Select repositories in this workspace', send: '\r' },
        { pattern: 'Repository access policy for', send: '\r' },
        { pattern: 'Section navigation', send: '\r' },
        { pattern: 'Select knowledge sources under workspace root', send: '' },
        { pattern: 'Add existing knowledge file or folder', send: ' \r' },
        {
          pattern:
            'Existing knowledge file or folder path under workspace root',
          send: 'notes/empty\r',
        },
        {
          pattern: 'Select knowledge sources under workspace root',
          send: '\r',
        },
        {
          pattern: 'New authored-document destination',
          send: '\u0001\u000b../escape\r',
        },
        {
          pattern: 'does not escape the root',
          send: '\u0001\u000b.pappra/knowledge\r',
        },
        { pattern: 'Task document visibility policy', send: '\r' },
        { pattern: 'Section navigation', send: '\r' },
        { pattern: 'Keep current advanced settings', send: '\r' },
        {
          pattern: 'Edit a section or continue to the detailed plan',
          send: '\u0003',
        },
      ];
      const run = runRealTty(workspace, dataHome, ['--no-runtime'], steps);
      const after = snapshotTree(workspace);
      recordTtyEvidence(
        'fresh-add-cancel',
        run,
        workspace,
        before,
        after,
        dataHome,
      );

      const transcript = readableTranscript(run.stdout);
      assert.equal(run.status, 130, run.stderr || transcript.slice(-4000));
      assert(transcript.includes('Add existing repository'));
      assert(transcript.includes('Add existing knowledge file or folder'));
      assert(transcript.includes('projects/one/two/three/explicit-repo'));
      assert(transcript.includes('notes/empty'));
      assert(transcript.includes('New authored-document destination'));
      assert(transcript.includes('does not escape the root'));
      assert(transcript.includes('Init cancelled'));
      assert.equal(transcript.includes('Pappra init plan'), false);
      assert.deepEqual(after, before);
      assert.equal(existsSync(dataHome), false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);

test(
  'real TTY reconfigure prefill supports Back and review edits before declining apply',
  { skip: ptySkip },
  async () => {
    const temporary = mkdtempSync(
      join(tmpdir(), 'pappra-init-tty-reconfigure-'),
    );
    const workspace = join(temporary, 'workspace');
    const dataHome = join(temporary, 'pappra-data');
    try {
      mkdirSync(workspace, { recursive: true });
      createRepository(workspace);
      writeText(join(workspace, 'README.md'), '# terminal fixture\n');
      writeWorkspaceConfig(
        workspace,
        baseWorkspaceConfig({
          name: 'Existing TTY workspace',
          repositories: [{ id: 'app', path: '.', access: 'write' }],
          knowledge: {
            sources: ['README.md'],
            newDocuments: '.pappra/knowledge',
            taskVisibility: 'private',
          },
          extensions: { 'pappra.tty': { retained: true } },
          continuity: { autoResume: true },
        }),
      );
      writeMachineConfig(
        workspace,
        baseMachineConfig(workspace, { selectedHosts: ['pi'] }),
      );
      const before = snapshotTree(workspace);
      const steps = [
        { pattern: 'Workspace name', send: '' },
        {
          pattern: 'Existing TTY workspace',
          send: '\u0001\u000bEdited before Back\r',
        },
        { pattern: 'Section navigation', send: '\r' },
        { pattern: 'Select repositories in this workspace', send: '\r' },
        { pattern: 'Repository access policy for', send: '\r' },
        { pattern: 'Section navigation', send: '\u001b[A\r' },
        { pattern: 'Workspace name', send: '' },
        {
          pattern: 'Edited before Back',
          send: '\u0001\u000bEdited after Back\r',
        },
        { pattern: 'Section navigation', send: '\r' },
        { pattern: 'Select repositories in this workspace', send: '\r' },
        { pattern: 'Repository access policy for', send: '\r' },
        { pattern: 'Section navigation', send: '\r' },
        {
          pattern: 'Select knowledge sources under workspace root',
          send: '\r',
        },
        { pattern: 'New authored-document destination', send: '\r' },
        { pattern: 'Task document visibility policy', send: '\r' },
        { pattern: 'Section navigation', send: '\r' },
        { pattern: 'Keep current advanced settings', send: '\r' },
        {
          pattern: 'Edit a section or continue to the detailed plan',
          send: '\u001b[B\r',
        },
        { pattern: 'Workspace name', send: '' },
        { pattern: 'Edited after Back', send: '\u0001\u000bReview edited\r' },
        {
          pattern: 'Edit a section or continue to the detailed plan',
          send: '\r',
        },
        { pattern: 'Pappra init plan', send: '' },
        {
          pattern:
            'Apply the planned workspace/machine configuration files only',
          send: '\r',
        },
      ];
      const run = runRealTty(
        workspace,
        dataHome,
        ['--reconfigure', '--no-runtime'],
        steps,
      );
      const after = snapshotTree(workspace);
      recordTtyEvidence(
        'reconfigure-back-review-decline',
        run,
        workspace,
        before,
        after,
        dataHome,
      );

      const transcript = readableTranscript(run.stdout);
      assert.equal(run.status, 130, run.stderr || transcript.slice(-4000));
      assert(transcript.includes('Existing TTY workspace'));
      assert(transcript.includes('README.md'));
      assert(transcript.includes('Edited before Back'));
      assert(transcript.includes('Edited after Back'));
      assert(transcript.includes('Review edited'));
      assert(transcript.includes('Keep current advanced settings'));
      assert(transcript.includes('Pappra init plan'));
      assert(
        transcript.includes(
          'Apply the planned workspace/machine configuration files only',
        ),
      );
      assert.deepEqual(after, before);
      assert.equal(existsSync(dataHome), false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);

test(
  'real TTY apply with --no-runtime writes configuration only after explicit confirmation',
  { skip: ptySkip },
  async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'pappra-init-tty-apply-'));
    const workspace = join(temporary, 'confirmed-workspace');
    const dataHome = join(temporary, 'pappra-data');
    try {
      mkdirSync(workspace, { recursive: true });
      createRepository(workspace);
      const before = snapshotTree(workspace);
      const steps = [
        { pattern: 'Workspace name', send: '' },
        {
          pattern: 'confirmed-workspace',
          send: '\u0001\u000bConfirmed TTY workspace\r',
        },
        { pattern: 'Section navigation', send: '\r' },
        { pattern: 'Select repositories in this workspace', send: '\r' },
        { pattern: 'Repository access policy for', send: '\r' },
        { pattern: 'Section navigation', send: '\r' },
        {
          pattern: 'Select knowledge sources under workspace root',
          send: '\r',
        },
        { pattern: 'New authored-document destination', send: '\r' },
        { pattern: 'Task document visibility policy', send: '\r' },
        { pattern: 'Section navigation', send: '\r' },
        { pattern: 'Keep current advanced settings', send: '\r' },
        {
          pattern: 'Edit a section or continue to the detailed plan',
          send: '\r',
        },
        { pattern: 'Pappra init plan', send: '' },
        {
          pattern:
            'Apply the planned workspace/machine configuration files only',
          send: 'y',
        },
        { pattern: 'Applied files:', send: '' },
      ];
      const run = runRealTty(workspace, dataHome, ['--no-runtime'], steps);
      const after = snapshotTree(workspace);
      recordTtyEvidence(
        'apply-no-runtime-confirmed',
        run,
        workspace,
        before,
        after,
        dataHome,
      );

      const transcript = readableTranscript(run.stdout);
      assert.equal(run.status, 1, run.stderr || transcript.slice(-4000));
      assert(transcript.includes('Confirmed TTY workspace'));
      assert(transcript.includes('Applied files: .pappra/workspace.json,'));
      assert(
        transcript.includes(
          'Runtime operation: intentionally deferred by --no-runtime; none was run.',
        ),
      );
      assert.equal(
        existsSync(join(workspace, '.pappra', 'workspace.json')),
        true,
      );
      const config = JSON.parse(
        readFileSync(join(workspace, '.pappra', 'workspace.json'), 'utf8'),
      );
      assert.equal(config.name, 'Confirmed TTY workspace');
      assert.deepEqual(
        config.repositories.map((repository: { id: string; path: string }) => ({
          id: repository.id,
          path: repository.path,
        })),
        [{ id: 'confirmed-workspace', path: '.' }],
      );
      assert.equal(existsSync(dataHome), false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
