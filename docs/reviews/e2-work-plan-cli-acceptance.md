# E2-B acceptance: read-only work-plan CLI and app entry

Accepted after R2 within advisory inspection scope. REPORT `sha256:e860773061914ac0b37d9b7355a421b02b8d0d7dcd819fe0296ef112fa9cf5b0`, exact participant/task/subtask/reply/attempt/epoch, assignment/input/direction/report/output pins, all seven current scope hashes and unchanged accepted core/shared reader verified. Evidence verification is `/tmp/pappra-e2cli-r2-evidence-verification.json` with no mismatches.

The coordinator compiled current source into `/private/tmp/e2cli-r2-review.O2rZ7e/build` and independently ran 38 tests: 15 actual isolated CLI tests and 23 core work-plan tests. All pass. The actual CLI regressions include unrelated missing/corrupt/oversized/numerous decisions, valid padded envelopes, corrupt JSON, and valid envelopes with mismatched registered digest or identity. Original counterexamples independently replayed in `/tmp/pappra-e2cli-r2-extra.mjs` now pass: an unrelated missing decision leaves the narrow plan evaluated/accepted; padded relevant evidence exceeds the actual raw budget and remains incomplete; eight corrupt 900 KiB files stop after four reads with `raw_bytes: 3686400`, `supplied: 0`, `over_budget: true` and no accepted nodes. Results are `/tmp/pappra-e2cli-r2-independent-findings.json`.

The public app export and `collab plan --task-root <absolute> --config <absolute plan.json> [--json]` validate the plan, derive its relevant applied reports and complete registered decision set, and preserve later rejections. Decision files use descriptor-safe bounded reads: 128 envelopes, 1 MiB each, 4 MiB aggregate raw bytes including bytes subsequently rejected. Invalid requests exit 2, incomplete evidence exits 1, evaluated advisory snapshots exit 0 even when work is blocked. Relevant evidence is never silently truncated into complete readiness. Both skill references match.

Accepted source hashes:

- app entry: `sha256:162c162ca11849532ec68daeb68cbf39f81cdbfc4709d9d346f224a3780a4a35`
- CLI command: `sha256:ebcbb4f523a869a4db983ca733dc3bb0680afc6ecd840229a0c1fa2b654fa177`
- CLI routing: `sha256:2755bac222b7f78f898b24b965dc564066480aea5693331ab535f2a96a7bc4e8`
- app export: `sha256:e895156fb1f8c139bfb40556ca40eed1d8cbb9b9fb2abedaec0cee13419482da`
- CLI tests: `sha256:502fced335e1060121b4d0b9680a56d224cd0d1866e0b4742939dd301917e242`
- both references: `sha256:8d7b6c706ec9bb0ad761dd16cacda0130784db89d1c6653cde8a797b9b46ec93`

This is planning and inspection, not a scheduler or an execution-authority grant. No automatic dispatch, claims, launch, live native query, rollover or archive is enabled. Existing record bounds, unverified filesystem aliases and resource-domain limits still apply. Fresh packed-consumer verification is the next integration check; no new package has been published or globally installed.
