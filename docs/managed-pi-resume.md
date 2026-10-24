# Controlled managed Pi resume

The SDK runtime can explicitly reopen the same native session after its previously
registered process has died. This is separate from fresh-session handoff. It does
not replay the previous prompt, pending input, approval, tool, or provider request.

Use the ordinary `pappra session start --config <absolute-file>` command with
`runtime: "sdk"`, the exact existing `sessionId`, a new private `journalPath`, and
the same immediate `executionScope`. Add:

```json
{
  "resume": {
    "sourceJournalPath": "/absolute/private/source.jsonl",
    "sourceSessionFile": "/absolute/native-session.jsonl",
    "sourceRunId": "exact-source-controller-run-id"
  }
}
```

The plan command remains read-only and reports `launch_kind: "controlled-resume"`.
Neither a valid plan nor a JSON configuration grants resume authority. The runtime
must establish all of the following before native session open:

- The original process is absent according to the local OS. A live/reused PID or
  unknown process-death observation refuses admission.
- The checkpoint belongs to the same OS boot and PID namespace, identified by a
  hashed OS boot identifier (and Linux PID-namespace identity), not a hostname.
  A copied remote checkpoint or another boot/container cannot prove local death.
- The original task-owned runtime registration, private control descriptor and
  complete hash-chained source journal agree on scope/session/run identity.
- A versioned complete-idle checkpoint covers the exact native transcript. Known
  private queues, work, tools, Bash and approval paths are idle/empty; any later
  semantic/provider/tool action invalidates it. Native error/aborted outcomes do
  not establish permission to retry an unknown effect.
- The task namespace, latest active attempt, admitted Assignment, coordinator,
  input revision, approval state and exact unreleased resource claims are current.
- One exclusive task-store reservation is established for this exact source run
  and checkpoint. Concurrent reservations owned by a live process are not bypassed.
  Failed startup and normal shutdown release their exact reservation; the next
  attempt reclaims reservations whose owner is proven dead before checking capacity.

An in-process opaque authorization carries these verified pins to the SDK opener.
The reopened session must retain the same UUID, cwd and transcript. Before native
input is exposed, task-store registration atomically replaces the exact old owned
endpoint with the new one under the reservation. Claims do not move or advance.
Execution gates continue checking authority after startup. Verified registered
input IDs/digests survive the restart, so an old notification cannot start another
model turn merely because the runtime has changed.

This first mode requires one immediate task scope. Deferred initial Assignment,
bootstrap receiver and automatic-handoff startup cannot be combined with resume.
They retain their existing fresh-session contracts. Pre-upgrade journals without
resume checkpoints cannot be adopted. If the source journal is partial/altered,
native outcome is unresolved, or permissions
have drifted, preserve the evidence and reconcile explicitly.
For a Herdr-hosted source, resume stays in its recorded pane and retains the
existing participant binding; it does not silently move a route to another pane.
Journal and native-history reads are bounded at 32 MiB and 64 MiB respectively.

A session with no real conversation may have no native transcript file: Pi 1.4
does not persist setup/custom entries alone. Such startup does not manufacture a
conversation or a checkpoint. Integration acceptance first runs a genuine bounded
native turn before testing an idle checkpoint.

The ownership boundary remains the pinned SDK runtime. This feature does not
establish that arbitrary external writers or unowned descendants are stopped.
