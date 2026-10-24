# Managed Pi owned-runtime transition contract

`bindManagedPiExecutionScope` runs before the native TUI admits input. It binds
the controller's live session/cwd to the authoritative task, active attempt,
coordinator epoch and exact held claim epochs. Binding rejects unknown queues,
pending work/dialogs, unhealthy ingress journals and stale identities. The result
is an in-process branded object; serialized configuration cannot create it.

`createManagedPiTransitionHost` fences and quiesces that actual controller. Fresh
version 2 proofs are likewise branded in process and include the binding digest,
controller sequence and journal head. Their explicit scope is
`pinned_pi_1_4_owned_runtime`; arbitrary external writers, unrelated processes
and unowned descendants are excluded. Unscoped legacy requests cannot consume
these proofs. Existing ACK, current authority, claim transfer, registered
first-work and retirement gates still apply.

The SDK CLI opens its private control server and registers the owned runtime
before starting the TUI when an execution scope is supplied. Role repair can
query that registration, verify the control socket's actual OS owner and stop
only the matching runtime. A stop confirms SDK runtime disposal; it does not
claim that the host PID exited.

After authoritative successor first work reaches `task_retired`,
`retireManagedPiSource` stops the owned source runtime and retains a bounded,
identity-checked transcript plus a receipt under the continuity task's
`retired-sessions` directory. It preserves the original native transcript.
Repeated retention requires matching artifacts and a still-disposed controller;
a static receipt alone is not live stop authority. Pi's native history remains
unchanged because the installed SDK exposes no archive operation.

Focused tests cover the real guarded transition with the concrete controller
and test runtime ports, stale/malformed scope refusal, legacy separation,
retirement gates and authenticated stop deduplication. These are not a native
provider end-to-end takeover demonstration. In particular, ordinary bootstrap
still launches native Pi rather than recursively launching another scoped SDK
controller. Repeated automatic managed rollovers and their visible host
recognition remain an integration gap.
