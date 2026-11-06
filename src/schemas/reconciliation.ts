/** Stable serializations of a reconciliation decision at existing boundaries. */
export const reconciliationStatus = {
  workOrRole: 'reconciliation-required',
  aggregate: 'needs-reconciliation',
  native: 'reconcile_required',
} as const;
