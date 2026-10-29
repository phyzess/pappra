/**
 * Persisted file identity helpers.
 *
 * On-disk documents that must survive reboots compare files by inode only.
 * The device number (`dev`) of a volume can change across reboots on macOS,
 * so persisted comparisons ignore it. In-process TOCTOU checks continue to
 * compare the full `{dev, ino}` pair elsewhere.
 */

export interface PersistedFileIdentity {
  readonly ino: number;
  readonly dev?: number | undefined;
}

/**
 * Returns true when two persisted identities refer to the same inode.
 * The optional `dev` field is intentionally ignored so that documents
 * written before a reboot remain valid when only the device number changes.
 */
export function persistedIdentityMatches(
  stored: PersistedFileIdentity | null,
  observed: PersistedFileIdentity | null,
): boolean {
  if (stored === null || observed === null) return false;
  return stored.ino === observed.ino;
}
