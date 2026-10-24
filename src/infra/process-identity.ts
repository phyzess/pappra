import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export interface LocalProcessIdentity {
  readonly schema: 'pappra/local-process/1';
  readonly pid: number;
  readonly machine: string;
  readonly boot: string;
  readonly namespace: string;
  readonly start: string;
}

type HostIdentity = Pick<
  LocalProcessIdentity,
  'machine' | 'boot' | 'namespace'
>;
let host: HostIdentity | null | undefined;
let self: LocalProcessIdentity | null | undefined;
const hash = (value: string) =>
  `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;

function command(file: string, args: string[]): string | null {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    timeout: 2000,
    maxBuffer: 32 * 1024,
    shell: false,
  });
  return !result.error && result.status === 0 ? result.stdout.trim() : null;
}

function hostIdentity(): HostIdentity | null {
  if (host !== undefined) return host;
  try {
    if (process.platform === 'linux') {
      const machine = fs.readFileSync('/etc/machine-id', 'utf8').trim();
      const boot = fs
        .readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
        .trim();
      const namespace = fs.readlinkSync('/proc/self/ns/pid');
      if (
        !/^[a-f0-9]{32}$/i.test(machine) ||
        !/^[a-f0-9-]{36}$/i.test(boot) ||
        !/^pid:\[[0-9]+\]$/.test(namespace)
      )
        return (host = null);
      return (host = {
        machine: hash(machine.toLowerCase()),
        boot: hash(boot.toLowerCase()),
        namespace,
      });
    }
    if (process.platform === 'darwin') {
      const boot = command('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
      const platform = command('/usr/sbin/ioreg', [
        '-rd1',
        '-c',
        'IOPlatformExpertDevice',
      ]);
      const machine = platform?.match(
        /"IOPlatformUUID"\s*=\s*"([a-f0-9-]{36})"/i,
      )?.[1];
      if (!boot || !/^[a-f0-9-]{36}$/i.test(boot) || !machine)
        return (host = null);
      return (host = {
        machine: hash(machine.toLowerCase()),
        boot: hash(boot.toLowerCase()),
        namespace: 'native',
      });
    }
  } catch {
    /* Missing OS identity is not evidence of a dead owner. */
  }
  return (host = null);
}

function processStart(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat
        .slice(close + 2)
        .trim()
        .split(/\s+/);
      const ticks = fields[19];
      return close > 0 && ticks && /^[0-9]+$/.test(ticks) ? ticks : null;
    }
    if (process.platform === 'darwin') {
      const start = command('/bin/ps', ['-p', String(pid), '-o', 'lstart=']);
      return start &&
        /^[A-Za-z]{3} [A-Za-z]{3}\s+[0-9]+ [0-9:]{8} [0-9]{4}$/.test(start)
        ? start
        : null;
    }
  } catch {
    /* The caller distinguishes exit from unavailable observation. */
  }
  return null;
}

export function captureProcessIdentity(
  pid = process.pid,
): LocalProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (pid === process.pid && self !== undefined) return self;
  const currentHost = hostIdentity();
  const start = processStart(pid);
  const identity =
    currentHost && start
      ? {
          schema: 'pappra/local-process/1' as const,
          pid,
          ...currentHost,
          start,
        }
      : null;
  if (pid === process.pid) self = identity;
  return identity;
}

/** Identity mismatches prove replacement only on this exact physical machine. */
export function isLocalProcessIdentity(
  value: unknown,
): value is LocalProcessIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return !(
    row.schema !== 'pappra/local-process/1' ||
    !Number.isSafeInteger(row.pid) ||
    Number(row.pid) <= 0 ||
    typeof row.machine !== 'string' ||
    typeof row.boot !== 'string' ||
    typeof row.namespace !== 'string' ||
    typeof row.start !== 'string' ||
    row.start.length === 0 ||
    row.start.length > 128 ||
    !/^sha256:[0-9a-f]{64}$/.test(String(row.machine)) ||
    !/^sha256:[0-9a-f]{64}$/.test(String(row.boot)) ||
    !/^(?:native|pid:\[[0-9]+\])$/.test(String(row.namespace))
  );
}

export function observeProcessIdentity(
  value: unknown,
): 'alive' | 'dead' | 'unknown' {
  if (!isLocalProcessIdentity(value)) return 'unknown';
  const row = value;
  const currentHost = hostIdentity();
  if (!currentHost || row.machine !== currentHost.machine) return 'unknown';
  if (row.boot !== currentHost.boot) return 'dead';
  if (row.namespace !== currentHost.namespace) return 'unknown';
  try {
    process.kill(Number(row.pid), 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
      ? 'dead'
      : 'unknown';
  }
  const start = processStart(Number(row.pid));
  return start === null ? 'unknown' : start === row.start ? 'alive' : 'dead';
}
