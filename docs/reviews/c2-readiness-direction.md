# C2 standalone readiness preflight: implementation direction

Implement the missing public read-only readiness entry over the existing `src/collab/preflight.ts` primitive. Do not duplicate or weaken readiness semantics and do not require a launch merely to inspect blockers.

## Public contract

`pappra collab preflight --assignment <abs assignment.json> --capabilities <abs card.json> [--max-age-minutes <positive finite number>] [--json]`

- Read only. No `--apply`, task mutation, ownership claim, Herdr/native process, model turn, launch, input-body output or evidence refresh.
- Require existing regular, bounded assignment/card files, at most 1 MiB each. Refuse final symlinks/special files/oversized or malformed JSON before invoking the primitive. Avoid printing file contents in errors. Keep the input-validation service bounded and proportionate, reusing existing helpers where suitable.
- Invoke the existing `preflight` with the current clock, default maximum age 30 minutes or the explicit valid override. No public clock override and no changes to the primitive's evidence/freshness/identity/omission/hash checks.
- JSON uses a versioned `pappra/collaboration-preflight/1` result, preserving readiness status, task/assignment/attempt and checked time when provided, errors, blockers, warnings and limits. `ok` means ready only. CLI help and readable output distinguish `ready`, `needs_input`, and `invalid`.
- Exit codes: ready 0; needs_input 1; invalid request/JSON/contract/card 2. Reject missing/duplicate/unknown/wrong-action options consistently with the CLI's existing strictness. Assignment/max-age flags are preflight-only; capabilities retains its existing run meaning. No mode flags may silently select another operation.
- A ready result reports only current reported capability/evidence readiness. It does not authenticate self-reported runtime facts, authorize dispatch, acquire resources, verify ownership epoch, launch, prove completion or replace launch admission. Keep the primitive's warnings and limits visible.

## Installed guidance and capability scope

Update CLI help and both packaged skill mirrors with a concrete preflight-before-dispatch walkthrough. Use explicitly declared sample templates as examples only: show that a declared card yields `runtime_capabilities_unconfirmed`, rather than teaching users to relabel one as runtime.

Runtime evidence derivation is a subsequent slice; acknowledge the present public derivation gap. This entry accepts a separately obtained capability card and checks it without claiming to obtain native observations. Do not add host adapters, MCP surfaces, identity defaults, trust/model changes, dependencies, schedulers or authority operations in this slice.

## Verification and delivery

- Test the public CLI through ready, declared/required-capability blockers, stale/changed evidence and changed inputs, invalid identity/schema/JSON/options, unsafe file kinds, and advisory-only resource warnings. Reuse representative existing fixtures; do not mirror every internal branch.
- Verify no task/input bytes or mtimes change and no child/model/Herdr process is started by the service; installed CLI coverage must work in an unrelated cwd with absolute inputs.
- Type checking, build, meaningful focused collaboration/CLI regressions, mirror parity and package verification for the new installed route. Preserve the excluded reliability patch and previously accepted message/routing behavior.
- Same Pi native session and epoch-1 resource claims. Refresh actual receiving-runtime receipt/card and ready preflight before source writes. Source changes limited to the service/CLI glue, focused collaboration tests and packaged guidance; parent plans/reviews remain coordinator-owned.
- Return pinned input revision, report and current fixed-file manifest via product REPORT and one product notify. No native fallback, `--wait`, polling, extra agents, commit or publication.
