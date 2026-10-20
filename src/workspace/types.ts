import type { Diagnostic } from '../schemas/diagnostics.js';
import type { RepositoryAccess } from '../schemas/workspace.js';
import type {
  GitRepositoryKind,
  GitRepositoryObservation,
} from '../infra/git.js';

export type WorkspaceConfigState = 'valid' | 'missing' | 'invalid';
export type MachineConfigState = 'valid' | 'missing' | 'invalid';

export interface DiscoveredRepository {
  /** Logical id from workspace.json; null for a repository found by scan. */
  readonly id: string | null;
  readonly origin: 'workspace-config' | 'scan';
  readonly external: boolean;
  readonly access: RepositoryAccess;
  /** Real absolute checkout path. External mappings may be outside the root. */
  readonly root: string;
  /** Workspace-relative POSIX path; null for external or out-of-root checkouts. */
  readonly relativePath: string | null;
  /** Original workspace.json path, kept for provenance. */
  readonly configuredPath: string | null;
  readonly git: GitRepositoryObservation;
  readonly kind: GitRepositoryKind;
  readonly diagnostics: readonly Diagnostic[];
}

export interface UnresolvedRepository {
  readonly id: string;
  readonly configuredPath: string;
  readonly diagnostics: readonly Diagnostic[];
}

export type DocumentKind = 'rule' | 'documentation' | 'decision-record';

export type DocumentOrigin =
  'workspace-config' | 'well-known' | 'directory-scan' | 'repository-scan';

export interface DiscoveredDocument {
  /** Absolute real path; the file was not moved, renamed, or rewritten. */
  readonly path: string;
  readonly workspaceRelativePath: string | null;
  readonly repositoryId: string | null;
  readonly kind: DocumentKind;
  readonly origin: DocumentOrigin;
  /** Config pointer, well-known marker, or scanned directory that produced this entry. */
  readonly declaredBy: string;
  readonly sizeBytes: number;
}

export interface ValidationCandidate {
  readonly id: string;
  readonly origin: 'workspace-config' | 'package-script';
  readonly repositoryId: string | null;
  readonly repositoryAccess: RepositoryAccess | null;
  readonly executable: string;
  readonly args: readonly string[];
  readonly workingDirectory: string | null;
  readonly declaredBy: string;
  /** How the package runner was chosen; never evidence that it is installed. */
  readonly runnerSource:
    'workspace-config' | 'declared' | 'lockfile' | 'fallback';
  /**
   * Discovery never resolves, executes, or trusts these commands. A candidate
   * is a declaration only, not evidence that the tool or script is usable.
   */
  readonly verification: 'not-verified';
}

export interface DiscoveryOptions {
  /** Directory depth below the workspace root; 0 inspects only the root. */
  readonly scanDepth?: number;
  readonly maxDirectories?: number;
  readonly maxDocuments?: number;
  readonly maxEntriesPerDirectory?: number;
  readonly gitTimeoutMs?: number;
}

export interface NormalizedDiscoveryOptions {
  readonly scanDepth: number;
  readonly maxDirectories: number;
  readonly maxDocuments: number;
  readonly maxEntriesPerDirectory: number;
  readonly gitTimeoutMs: number;
}
