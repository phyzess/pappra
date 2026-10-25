# Session transition architecture

The session transition path moves a collaboration task from one native Pi session
to its successor. It is a fail-closed state machine split across cohesive modules;
every side effect records durable intent and an outcome receipt so a crash never
promotes an unproven step.

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| `types.ts` | Contracts only: status/stage unions, report, journal and effect receipts, quiescence proof and receipt, host and bootstrap-executor interfaces, dependencies, retirement marker, schema literal constants. No behaviour, no I/O, no import of any sibling module. |
| `context.ts` | Shared primitives and the typed transition context. Owns the small helpers every other module needs (`failure`, `nowIso`, `requestOf`, `immutableDigestOf`, `sameHarnessIdentity`, `parseRegisteredMessageEntry`), the bounded task-local file primitives (`ensureTaskLocalDirectory`, `readTaskLocalFile`, `writeTaskLocalExclusive`, `bootstrapData`), `loadContext` and `validateBootstrapTransition`. |
| `journal.ts` | The durable record: journal bounds and key, `parseQuiescenceReceipt`, `readJournal`/`journalEntry`, the current-state drift checks (`currentStateDrift`, `managedExecutionScopeDrift`), intent/handoff lookup and `sameIntentRequest`, the append/receipt writers (`addJournalEntry`, `setJournalEffect`, `setJournalQuiescenceReceipt`), `intentTransaction` and `hasJournalConflict`. |
| `report.ts` | Report assembly: limitations, capability block, `emptyReport`/`step`, the exact receipt validators (`exactQuiescenceReceipt`, `exactRouteBindingReceipt`, `exactRetirementReceipt`), `reportForContext` and `failureReport`. |
| `effects.ts` | The effect journal protocol: `SessionTransitionEffectName`, `effectPhase`, `recordEffectIntent` and `recordEffectOutcome`. This is the only place that asserts intent-before-effect ordering and reconciles uncertain outcomes. |
| `freeze.ts` | Freeze and quiescence: `plannedSteps`, host identity and proof-support validation, freeze-token equality, the quiescence receipt digest, and `freezeAndPrepare` (freeze, reconcile, prepare-transfer). |
| `routing.ts` | Successor route binding: bootstrap reservation lookup, `validateSuccessorBinding`, and `ensureSuccessorRouteBinding` with its write/reconcile paths. |
| `retirement.ts` | Task retirement: `ensureTaskRetirementMarker`, the reversible marker write and its receipt reconciliation. |
| `collab-session-transition.ts` | The public `plan`/`apply` facade and the orchestration order: preflight, context load, intent, freeze, transfer, successor bootstrap, route binding, first work and retirement, plus the CLI/transport adapters that call them. |

Import direction is one-way and acyclic:

```
types  <-  context  <-  journal  <-  report
                              \  <-  effects  <-  freeze
                                              \  <-  routing  <-  retirement
                                                     \        /
                                                      facade
```

Within this module group, `types.ts` imports no sibling and `context.ts` imports
only `types`. The modules also use existing collaboration, persistence and native
host primitives. No sibling imports the facade or the CLI. Shared state travels
as an explicit typed `TransitionContext`; no module takes a callback bag.

## Invariants

These hold at every step and are covered by the request, transition, scoped-contract
and boundary suites:

1. **Authority and epoch.** A transition acts only for the recorded coordinator and
   only while the task record, resource claims and owner epoch still match. Every
   mutation re-reads the current record under `transact` instead of trusting the
   record loaded earlier.
2. **Journal first, then effect.** `recordEffectIntent` writes a `pending` receipt
   before a side effect starts; `recordEffectOutcome` records `completed`, `failed`
   or `unknown` afterwards. A `pending` receipt found by a later run is an uncertain
   outcome, reported as `reconcile_required`, never a silent retry.
3. **Idempotence.** Re-applying an identical request against an identical journal
   reproduces the same report without repeating a completed effect. A different
   request digest for the same transition id is `transition_request_conflict`.
4. **Quiescence proof.** `supported_quiescence` is `available` only with a complete
   scoped proof: matching session, cwd, adapter, freshness, inventory digest and
   freeze token. Idle, settled, a freeze latch, an unscoped receipt or a stale proof
   are all reported as unavailable; the excluded scope (arbitrary external writers,
   unowned processes and descendants) is stated rather than assumed away.
5. **Route binding.** The successor route is validated against the live binding and
   the completed bootstrap reservation before ownership moves, and the accepted
   binding digest is what retirement and the report cite. A route that cannot be
   validated fails closed.
6. **Retirement is not archive.** Retirement writes a reversible task-local marker
   and keeps the original transcript in place; `native_session_archive` stays
   `unavailable`. No native session data is deleted or rewritten.
7. **Request behaviour is preserved.** Raw and loaded requests behave identically at
   the public boundary: same kind, same `next_action` semantics, same codes for
   unreadable input, and the same digest of the accepted raw file.
8. **Public names are stable.** The facade keeps its exported names, report schema
   literal and journal key. Module-internal helpers (`TransitionFailure`,
   `TransitionContext`, `ValidatedSuccessorBinding`, `EnsuredRouteBinding`,
   `EnsuredRetirementMarker`) are exported for sibling modules but are not part of
   the facade's public surface.

## Journal and effects

The journal is a single bounded record (`SESSION_TRANSITION_JOURNAL_KEY`, at most 32
entries and 64 KiB). Each entry is keyed by transition id and carries the request
digest, the bootstrap request digest, per-effect receipts and the source and transfer
quiescence receipts. Effect receipts are the only record of whether a side effect
happened, so the intent timestamp is preserved when the outcome is written and the
absence of an outcome is reported as `unknown` rather than inferred from a clean
transport exit. Completed artifacts (route binding, retirement marker) are pinned to
the entry's `*_ref`/`*_digest` fields, and a receipt that no longer matches its exact
task-local file is a reconciliation failure, not a rewrite.

## Failure reporting

Every report carries a stage, a cause reference, ordered steps and the honest
capability block. Anything the implementation cannot observe (native archive,
in-flight approval completeness, Herdr process affiliation) is reported as
unavailable or unknown; a step that did not run is not reported as done.
