import { resolveUserDataDir } from '../../install/data-dir.js';
import {
  decodeChain,
  runStatuslineBeacon,
} from '../../usage/statusline-beacon.js';

/**
 * Status-line entrypoint: `node statusline-entry.js [--chain-base64 <command>]`.
 *
 * It reads the payload from stdin, records the session's context usage as a numbers-only
 * private observation, and prints what the user's own chained status-line command prints (or a
 * short `ctx NN%` when none is chained). It starts no model, makes no network request and
 * never writes a checkpoint.
 *
 * The chained command receives the payload exactly as the host sent it. If the host has not
 * closed stdin after two seconds, what arrived so far is used; a payload beyond the hard
 * 8 MiB cap is cut there. Usage is only recorded from a payload within the 1 MiB bound.
 */
const HARD_CAP_BYTES = 8 * 1024 * 1024;

async function readStdin(timeoutMs: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  let open = true;
  const done = new Promise<void>((resolve) => {
    process.stdin.on('data', (chunk: Buffer) => {
      if (!open || total >= HARD_CAP_BYTES) return;
      const room = HARD_CAP_BYTES - total;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      total += kept.length;
      chunks.push(kept);
    });
    process.stdin.on('end', resolve);
    process.stdin.on('error', resolve);
  });
  await Promise.race([
    done,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  // Later chunks must not change what the chain was given.
  open = false;
  return Buffer.concat(chunks).toString('utf8');
}

const flag = process.argv.indexOf('--chain-base64');
const rawChain = flag >= 0 ? process.argv[flag + 1] : undefined;
const chain = decodeChain(rawChain);
const stdin = await readStdin(2000);
const result =
  flag >= 0 && chain === null
    ? // A chain was configured but cannot be decoded: say so instead of silently replacing
      // the user's status line with ours.
      { stdout: 'pappra: status-line chain is invalid', exitCode: 1 }
    : await runStatuslineBeacon(stdin, chain, {
        dataDir: resolveUserDataDir(),
      });
// The flush callback matters: exiting first could truncate the status line.
process.stdout.write(result.stdout, () => process.exit(result.exitCode));
