/** Persisted execution pins shared by orchestration and native host adapters. */
export const MANAGED_PI_EXECUTION_SCOPE_SCHEMA =
  'pappra/managed-pi-execution-scope/1';

export interface ManagedPiExecutionScope {
  readonly schema: typeof MANAGED_PI_EXECUTION_SCOPE_SCHEMA;
  readonly task_id: string;
  readonly task_root: string;
  readonly session_id: string;
  readonly cwd: string;
  readonly subtask_id: string;
  readonly attempt: number;
  readonly owner_epoch: number;
  readonly claim_epochs: readonly {
    readonly claim_id: string;
    readonly resource_epoch: number;
  }[];
}
