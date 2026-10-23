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
- `selected_model: { "preserve_daily": true }`: model/config override fields are rejected.
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

1. Revalidates the caller and splits the explicitly resolved pane with `--no-focus`, the admitted cwd and the requested direction.
2. Polls the returned owned pane locally for the installed available-shell predicate, at most 10 seconds, 100 ms intervals and 100 samples. It checks pane/workspace/terminal/cwd identity and shell incarnation and reconciles identity again before start. Samples contain only sanitized PID/group/shell/process-name facts.
3. Starts Pi in that pane with the exact UUID and accepted gate entry, equivalent to:

   ```text
   herdr agent start <name> --kind pi --pane <created-pane-id> --timeout 45000 -- --session-id <successor-uuid> --name <name> --extension <absolute-entry>
   ```

   It passes no model or settings override. This selects the daily default at launch; it does **not** prove inheritance of another session's mutable selected model.
4. Requires the live start result to match the requested agent, pane, workspace, terminal, UUID and interactive-ready state. It writes a separate task-local binding only after that exact identity is observed.
5. Notifies the registered message pointer once through the existing message protocol. A successful prompt submission is reported as `submitted`, not as consumed or accepted.

If readiness fails or is unknown, cleanup is limited to the pane returned by this request's successful split. Before `pane close`, apply rechecks the owned pane identity/cwd, confirms there is no agent, and requires the expected available-shell process facts. It never closes a reused or unrelated pane. An unknown split/start/close outcome is not converted into an invented pane id or cleanup proof.

For `target.choice: "reuse"`, the task-local binding, live Herdr occupant, exact native session/cwd and a fresh runtime capability card must match. The existing participant receives the one registered message. Reuse does not inspect process-info, wait for a shell, split, start, or close anything. A mismatch returns `unsupported_reuse`; it never falls back to a sibling launch.

## Outcomes and boundaries

- `planned`: read-only plan completed.
- `applied`: one-shot effect path completed and message submission was confirmed.
- `already_recorded`: the same request/message was already completed; no effect was repeated.
- `needs_input` / `invalid`: a required identity, pin or current-state fact is missing or conflicts.
- `unknown` / `reconcile_required`: an effect or notification outcome is ambiguous. Inspect the recorded reservation and original Herdr/message state before creating a new request.

This slice does not prove extension registration from a report, synthesize successor capabilities, transfer task authority, stop/quiesce the old writer, remove production routing, prove first work, archive a native session, or set automatic rollover thresholds. The accepted gate remains the authority and denies writes until its recorded transfer conditions are satisfied. Herdr pane/session metadata is routing evidence, not authentication or OS-level process affiliation. Shell readiness is bounded local polling, not an event or worker-completion guarantee.
