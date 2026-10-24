import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
  test(
    `${signal} restores real TTY modes and stops the owned TERM-ignoring Pi`,
    { timeout: 15_000 },
    async () => {
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'pappra-signal-')),
      );
      const fake = [
        '#!/usr/bin/env python3',
        'import os,json,sys,signal,time',
        'signal.signal(signal.SIGTERM, signal.SIG_IGN)',
        'signal.signal(signal.SIGHUP, signal.SIG_IGN)',
        'session=sys.argv[sys.argv.index("--session-id")+1]',
        'with open(os.environ["PAPPRA_MANAGED_PI_METADATA_FILE"],"a") as f: f.write(json.dumps({"type":"session_start","session_id":session,"cwd":os.getcwd()})+"\\n")',
        'while True: time.sleep(1)',
      ].join('\n');
      fs.writeFileSync(path.join(root, 'fake-pi'), fake, { mode: 0o700 });
      const program = [
        'import os,pty,sys,termios,json,select',
        'pid,master=pty.fork()',
        'if pid==0: os.execv(sys.argv[1],sys.argv[1:])',
        'with open(os.path.join(sys.argv[-1],"worker-pid"),"w") as f: f.write(str(pid))',
        'while True:',
        ' ready,_,_=select.select([master],[],[],0.05)',
        ' if ready:',
        '  try:',
        '   data=os.read(master,65536)',
        '   if data: os.write(2,data)',
        '  except OSError: pass',
        ' waited,status=os.waitpid(pid,os.WNOHANG)',
        ' if waited==pid: break',
        'modes=termios.tcgetattr(master)',
        'print(json.dumps({"canonical":bool(modes[3]&termios.ICANON),"echo":bool(modes[3]&termios.ECHO)}))',
        'sys.exit(os.waitstatus_to_exitcode(status))',
      ].join('\n');
      const child = spawn(
        'python3',
        [
          '-u',
          '-c',
          program,
          process.execPath,
          fileURLToPath(new URL('./managed-signal-worker.js', import.meta.url)),
          root,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const closed = once(child, 'close');
      let output = '';
      let errors = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errors += chunk.toString();
      });
      type Ready = {
        pid: number;
        raw: boolean;
        identity: { piPid: number; helperPid: number };
      };
      let ready: Ready | null = null;
      try {
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline && child.exitCode === null) {
          try {
            ready = JSON.parse(
              fs.readFileSync(path.join(root, 'ready.json'), 'utf8'),
            ) as Ready;
          } catch {
            /* bounded startup */
          }
          if (ready) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert(ready, `controller did not initialize: ${errors}`);
        assert.equal(ready.raw, true);
        process.kill(ready.pid, signal);
        await closed;
        assert.equal(child.exitCode, 0, errors);
        const result = JSON.parse(
          fs.readFileSync(path.join(root, 'result.json'), 'utf8'),
        ) as { raw: boolean; exit: { status: string; signal: string } };
        assert.equal(result.raw, false);
        assert.equal(result.exit.status, 'exited');
        assert.equal(result.exit.signal, 'SIGKILL');
        assert.deepEqual(JSON.parse(output), { canonical: true, echo: true });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(
              Number(fs.readFileSync(path.join(root, 'worker-pid'), 'utf8')),
              'SIGKILL',
            );
          } catch {
            /* owned worker exited */
          }
          for (const pid of ready
            ? [ready.pid, ready.identity.piPid, ready.identity.helperPid]
            : []) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              /* verified owned processes exited */
            }
          }
          child.kill('SIGKILL');
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
