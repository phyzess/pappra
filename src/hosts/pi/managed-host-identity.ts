import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

let cached: string | null | undefined;

/** A PID is meaningful only within this OS boot and PID namespace. Never use hostname as proof. */
export function managedPiHostIdentity(): string | null {
  if (cached !== undefined) return cached;
  try {
    let boot: string;
    let namespace = 'native';
    if (process.platform === 'linux') {
      boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      namespace = fs.readlinkSync('/proc/self/ns/pid');
      if (!/^pid:\[[0-9]+\]$/.test(namespace)) return (cached = null);
    } else if (process.platform === 'darwin') {
      // Absolute OS utility, direct argv, no shell/config/PATH interpretation.
      const result = spawnSync(
        '/usr/sbin/sysctl',
        ['-n', 'kern.bootsessionuuid'],
        {
          encoding: 'utf8',
          timeout: 2000,
          maxBuffer: 1024,
          shell: false,
        },
      );
      if (result.error || result.status !== 0) return (cached = null);
      boot = result.stdout.trim();
    } else return (cached = null);
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(boot))
      return (cached = null);
    cached = `sha256:${crypto.createHash('sha256').update(`pappra/managed-host/1\0${process.platform}\0${boot.toLowerCase()}\0${namespace}`).digest('hex')}`;
    return cached;
  } catch {
    return (cached = null);
  }
}
