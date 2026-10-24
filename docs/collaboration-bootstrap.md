# Visible Pi bootstrap

`pappra collab bootstrap` prepares or performs one explicit, task-bound Pi bootstrap. It does not start a hidden pilot, create another workspace, or change the user's daily Pi settings.

```text
pappra collab bootstrap <plan|apply> --task-root <absolute-task-root> --request <absolute-request.json> [--json]
```

`plan` is read-only. `apply` is the only effectful command. The `--task-root` value must resolve to the same canonical task root as `request.task_root`.

## Request inputs

The bounded request uses schema `pappra/collab-bootstrap-request/1`. It pins:

- `request_id`: durable idempotency key. Reusing it with different request bytes is a content conflict.
- `admission`: the exact assignment/subtask/attempt/input revision and a capability-card path plus raw-file digest. The assignment and card are checked with the existing collaboration preflight, including its freshness bound.
- `caller`: requires the Herdr environment and may give an explicit pane id. A missing pane id uses only Herdr's verified inherited caller context; it never selects a focused pane.
- `participant`: the Pi agent id, harness and UUID session selector. The identity must match the accepted bootstrap config's successor. A reuse request may also provide a participant capability-card path/digest.
- `target`: an explicit `sibling` or `reuse`, absolute admitted cwd, optional `right`/`down` split direction and `preserve_focus: true`.
- `selected_model: { "preserve_daily": true, "openrouter_model"?: "provider/model" }`: the optional model selects OpenRouter explicitly; unrelated configuration overrides are rejected.
- Optional `managed_runtime: { sdk_module_path, journal_path, automatic_handoff_file?, handoff_context_file? }` selects the managed SDK successor only for a fresh sibling with an explicit `selected_model.openrouter_model`. The SDK entry must be an absolute pinned regular file; the new journal and generated config live in an already-private real directory; both optional config paths are absolute future files. `handoff_context_file` is reserved for the root controller's private immutable receiver context.
- `bootstrap`: absolute exported bundle path, canonical bundle-manifest digest, colocated config path/digest and exact extension entry.
- `message_pointer`: one already-registered message id/path/digest. Arbitrary prompt text is not accepted.
- `binding_ref`: a task-local `pappra/collab-binding/1` file. This is needed by the existing registered-message router to resolve the caller and recipient explicitly. If it is absent, plan/apply returns `binding_ref_required`; no focused-pane or workspace-default route is inferred.
- Optional `readiness` limits can only tighten the fixed 10,000 ms / 100 ms / 100-sample maximum.

The optional top-level request `action: "apply"` is accepted for compatibility with early request examples; the CLI's `plan|apply` argument remains authoritative. A null/non-UUID session selector, model override, unsupported field, stale assignment/card or mismatched digest is rejected before effects.

The `bundle_digest` is SHA-256 of the canonical JSON encoding of manifest entries sorted by UTF-8 relative-path bytes:

```json
[{"path":"relative/posix/path","digest":"sha256:<file-bytes>"}]
```

Every bundle entry must be a regular file within the bounded file/count/total-byte limits. Symlinks and special files are refused. The config must be the exact colocated `extensions/pappra-bootstrap/bootstrap.json`; the entry must be the accepted generated wrapper; and `runtime.mjs` must match the package's accepted bootstrap artifact digest.

## Read-only plan

Plan checks the current task namespace, recorded attempt/assignment, coordinator epoch, claims and rollover intent; runs the current capability preflight; resolves the exact Herdr caller and task binding; reads the registered message; validates the accepted bootstrap config/bundle; and checks the selected participant route. It may query caller/list metadata, but it performs no reservation, split, shell poll, start, close, binding write or notification.

The report contains the projected split/start argv, readiness contract, bundle/config digests, participant-selection result and downstream limits. A report is not an authorization, lock, gate-registration proof or delivery receipt.

## One-shot apply

Apply repeats the checks and reserves `request_id` plus request digest in the task record before any native effect. It records intent before each effect and bounded typed Herdr receipts/results after the command. A repeated request returns the recorded result or `reconcile_required`; it does not split/start/prompt again. A same-key/different-content request is rejected.

For `target.choice: "sibling"`, apply:

1. Creates one sibling pane in the admitted cwd without changing focus.
2. Verifies that exact returned pane and waits for its available-shell process observation before queueing the single approved launch.
3. Without `managed_runtime`, starts legacy native Pi in that pane with the exact UUID and accepted gate entry, equivalent to:

   ```text
   herdr agent start <name> --kind pi --pane <created-pane-id> --timeout 180000 -- --session-id <successor-uuid> --name <name> --extension <absolute-entry>
   ```

   Legacy launch preserves daily settings and uses the daily default unless an explicit OpenRouter model was admitted. It does **not** prove inheritance of another session's mutable selected model.

   With `managed_runtime`, it instead writes a private immutable SDK request containing the pinned SDK module, explicit model, successor UUID, verified `bootstrapExtensionPath`, exact `herdrAgentName`, owned `herdrPaneId`, journal/control paths and optional future handoff config. It queues only the current package CLI using `herdr pane run <created-pane-id> <fixed Nushell command>`; argument values are encoded as literal Nushell strings, with no configurable executable or shell command. It never falls back to `herdr agent start`.
   The config supplies no `executionScope`: the successor is not yet the assignee. The root CLI loads the default-deny extension and publishes only the actual SDK identity after verifying pane/process ownership; execution scope and any future handoff watcher wait for authoritative completed transfer.
   When supplied, the root writes the immutable `handoff_context_file` from the captured transition and verified bundle before SDK launch. The receiver verifies/imports it and emits the native handoff ACK before starting work; this bootstrap slice only validates and forwards its path.
4. Legacy mode requires a live start result matching the requested agent, pane, workspace, terminal, UUID and interactive-ready state. Managed mode treats `pane run` as queue submission only, then requires matching Herdr name/cwd/live state and authenticated SDK control launch metadata for the actual UUID, model, SDK module, loaded extension and journal. It also matches the control socket's OS peer PID to the actual pane foreground PID; the attached native identity is explicitly `owned-pi-sdk-control`, never a raw Herdr session report. A separate task-local binding is written only after this exact SDK-native identity is verified.
5. Notifies the registered message pointer once through the existing message protocol. A successful prompt submission is reported as `submitted`, not as consumed or accepted.

If readiness fails or is unknown before startup, cleanup is limited to the pane returned by this request's successful split. Before `pane close`, apply rechecks the owned pane identity/cwd, confirms there is no agent, and requires the expected available-shell process facts. It never closes a reused or unrelated pane. After a managed CLI may have been submitted, unknown/late/mismatched startup is not auto-closed or reissued; the reservation remains for reconciliation and no binding or notification is written.

`target.start_timeout_ms` optionally sets the startup budget from 1 to 600,000 ms; the
default is 180,000 ms for both native and managed SDK starts. Session transitions verify
the successor SDK package version and pinned private source before freezing the source,
and recheck immediately before the first freeze. An interrupted reservation can be
reclaimed only when its exact owner is proven dead and it still has no native intent,
receipt or created pane. Ambiguous split/start outcomes remain for reconciliation. A
known failed start releases its reservation only after the exact owned pane is verified
empty and closed.

For `target.choice: "reuse"`, the task-local binding, live Herdr occupant, exact native session/cwd and a fresh runtime capability card must match. The existing participant receives the one registered message. Reuse does not inspect process-info, wait for a shell, split, start, or close anything. A mismatch returns `unsupported_reuse`; it never falls back to a sibling launch.

## Outcomes and boundaries

- `planned`: read-only plan completed.
- `applied`: one-shot effect path completed and message submission was confirmed.
- `already_recorded`: the same request/message was already completed; no effect was repeated.
- `needs_input` / `invalid`: a required identity, pin or current-state fact is missing or conflicts.
- `unknown` / `reconcile_required`: an effect or notification outcome is ambiguous. Inspect the recorded reservation and original Herdr/message state before creating a new request.

This slice does not prove extension registration from a report, synthesize successor capabilities, transfer task authority, stop/quiesce the old writer, remove production routing, prove first work, archive a native session, or set automatic rollover thresholds. The accepted gate remains the authority and denies writes until its recorded transfer conditions are satisfied. Herdr pane/session metadata is routing evidence, not authentication or OS-level process affiliation. Shell readiness is bounded local polling, not an event or worker-completion guarantee.
Managed SDK identity additionally requires the authenticated SDK control launch record, matching socket-owner PID and pane foreground PID; it is not inferred from Herdr `agent_session` fields.
