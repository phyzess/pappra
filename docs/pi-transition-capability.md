# Historical Pi 1.3 extension transition boundary

Status: historical dependency observation, retained for its evidence boundary.
This page describes an extension-bound Pi 1.3 session and does not describe the
current installed Pi version. The separately owned Pi 1.4 SDK controller has its
own bounded contract; see [managed sessions](managed-pi-session.md). It cannot
retroactively establish ownership of an arbitrary existing session.

**Observed result:** that Pi 1.3 installation could not supply the complete, replay-safe native quiescence
proof required by `SessionTransitionHost.observe/freeze`. This is a version-pinned dependency
finding, not a closed rollover path. Do not promote an idle/settled event, a managed-tool
latch, an RPC queue count, or an `abort()` completion into source-stop proof.

## Installed API evidence

The observed fresh visible runtime was Pi **1.3.0**. Its packaged `docs/extensions.md`
documents lifecycle/message/tool callbacks, including `agent_settled` as final
notification-only; it also notes automatic retries/recovery/compaction/queued work can follow
`agent_end`. Extension commands receive an `ExtensionCommandContext` with wait-until-idle,
reload and session-replacement operations, and extensions may request `ctx.shutdown()`. These
are not a complete queue/approval inventory, an all-writer fence, or an acknowledged
process-stop receipt. The extension surface exposes no documented operation for those facts.

The same package's `docs/sdk.md` describes a distinct `AgentSession` surface: it owns queued
messages, offers current `session.messages`, `abort()`/`waitForIdle()`, and emits queue events.
`abort()` stops the active operation and waits for idle; it is not process termination or a
complete queue snapshot. The extension context does not provide this `AgentSession` handle.
The local binary package declares `dist/index.js` and `dist/index.d.ts`, but the installed
package directory has no `dist/` tree, so this installation supplies no SDK module or
declarations to safely bind from the opt-in extension.

The documented RPC surface is also insufficient for the current interactive source:

- `get_state` reports `sessionId`, `isStreaming`, `isCompacting`, and `pendingMessageCount`,
  not the queued payloads, pending approvals, all active writers, or a completion receipt.
- `clear_queue` returns and removes steering/follow-up text only; it is not an atomic freeze
  and does not prove that other input sources cannot enqueue after the call.
- `abort` waits for idle, and the RPC docs explicitly warn that queued messages may continue
  if not removed. Closing stdin requests orderly shutdown; only a controller that owns the
  child can subsequently observe that child's exit.

Thus no documented installed API provides a correlated, fresh, complete inventory of pending
messages/approvals and in-flight work, atomically fences every writer, and confirms stop for
the exact source session/process. Extension callbacks cannot establish external-writer
ownership or an OS-level fence. The smallest upstream contract that would close this gap is a
public session-quiesce operation that atomically fences all ingress and returns the complete
recoverable pending-work/approval inventory plus active-work identities under the exact
session, cwd, freeze token and monotone evidence sequence, followed by an authenticated stop
receipt for that same source. An independently owned controller is only an alternative for
sessions it launches and exclusively owns: it must mediate all ingress, retain/capture pending
work, fence further input, then await exit of its exact child. That does **not** retroactively
prove quiescence of this interactive Pi session.

## Local bridge boundary

`src/adapters/pi/session-transition-extension.ts` already reports
`pi_native_quiescence_proof_unavailable`; its existing managed-tool freeze is not native or
external-writer stop proof. The composition lives in the adapter layer while the observed
primitives stay in `src/hosts/integration/pi-native-events.ts`, which tracks only supported
in-process observations: queue and approvals remain `unknown`, in-flight completeness remains
`unknown`, and `nativeStop` is always `false`. No additional native proof was added. The
existing owned RPC controller in `src/hosts/pi/rpc.ts` can stop only the child it launched; its
documented scope excludes arbitrary background/descendant writers and it is not the current
extension-bound interactive source.

## Pinned sources

All installed Pi files below come from the local Pi 1.3.0 package directory
(`<install-root>`); content hashes pin the observed bytes:

- `package.json` — `@earendil-works/pi-coding-agent@1.3.0`, SDK export paths; SHA-256
  `83c3bb7619f590c213cc96a24216eb29a819a3ef6dc548607cc037ed276e8dc5`.
- `docs/extensions.md` — event/extension API boundary; SHA-256
  `a2b5ff0f95e7e470ed0846d7c4fbfc5781fe7e694b8e7f51ea08859f3ad7325d`.
- `docs/sdk.md` — `AgentSession`, queues, abort and lifecycle; SHA-256
  `d9034ccbf2219a58712d8dd4fcdf47e687d77131e71dd5d119d8a71e9bd2a2e8`.
- `docs/rpc-commands.md` — `get_state`, `clear_queue`, and `abort`; SHA-256
  `4deeee367852f4633ef594bc079f9e9fb14640a4e3ba8a69b7c89b6f54740838`.
- `docs/rpc.md` — RPC event and child shutdown boundary; SHA-256
  `37a03d180115460a0a275022f4aeabef1e5345458df6a9b6e8a6de18474de720`.
- `examples/extensions/send-user-message.ts` — steer/follow-up submission only; SHA-256
  `9261e433c782f354530105e1c9723a19798868f72fd1f5d68af3a4624ad7e446`.

Local implementation pins (hash the checked-out file to compare):

- `src/adapters/pi/session-transition-extension.ts` — composition moved out of `src/hosts`;
  primitives below are unchanged.
- `src/hosts/integration/pi-native-events.ts` — native event tracking.
- `src/hosts/pi/rpc.ts` — owned RPC controller.
- `docs/pi-rpc.md` — RPC contract.

## Bounded observation

One fresh visible session was used for this finding: Pi 1.3.0, OpenRouter
`openai/gpt-6-luna`, medium thinking, one generated session identifier and one dedicated
test pane. The startup observation and launch record stayed in private evidence storage; no
session identifier, pane name or machine path is published here. A matching read-only product
preflight reported `ready` with no blockers and a single warning,
`resource_ownership_not_enforced`; that is reported runtime readiness only, not authorization
or resource locking. A read-only claim listing showed the five assigned claims live at the
time of observation.

**Disposition:** keep the accepted core guards unchanged and leave the production adapter
blocked. Tests with injected complete proofs would prove ordering only, not installed Pi
support; no such cosmetic adapter was added. Functional rollover acceptance remains pending
the upstream quiescence/stop capability or a separately authorized, fully ingress-owning
controller.
