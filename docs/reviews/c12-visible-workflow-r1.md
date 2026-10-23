# C12 visible entry: review round 1

Verdict: changes requested, limited to the new guidance and its validation. Delivery/native correlation, pinned input/assignment/direction, all output digests and all 67 current-manifest files verify independently. The help corrections and entry-reference discoverability are sound; the operational recipe still has material accuracy/completeness gaps.

## R1: preparation is incorrectly described as plan-only (P1 documentation)

`skills/pappra/references/environment.md`, step 4, says `Write the explicit goal and claims; plan-only without --apply` above `pappra collab prepare`. The installed prepare command has no plan/apply mode: it directly creates task/prepared state, registers ASSIGN and claims resources. A reader following this safety claim would mutate state while expecting preview.

Correct both mirrors to state the real mutation boundary and explicit authorization requirement. Do not add a new prepare flag or redesign its behavior in this documentation repair. Distinguish prepare from the message/resource/binding commands that actually have plan/apply.

## R2: provide a complete product-side sequence

The derivation example ends with `| ...` and never creates `card.runtime.json`, which the next command requires. Derivation returns a versioned result containing `card`; it does not write the card. Supply a valid Nushell example that checks success and explicitly saves only the returned card, reusing the existing derivation reference. State that preparation creates no declared template/card and explain where the caller supplies that template; preserve actual evidence/time and failure limits.

Preparation also already registers the initial ASSIGN. The instruction to then send an ASSIGN for a new task is ambiguous and can create another assignment for the same attempt. Show how to identify/read the exact registered prepare message by current task/subtask/attempt/recipient/input, then notify that message once. Document additional send only for a genuinely new bounded assignment or messages not already persisted; no duplicate initial assignment/reapplication.

Complete the requested two-way sequence: recipient verifies the pointer digest and exact `to` identity/task/attempt/epoch/input, records a correlated ACK, does admitted work, persists REPORT/BLOCK/STATUS and notifies the coordinator once. Include valid minimal envelope shapes or exact links to a complete example, with reply/identity fields and real command flags. Do not merge recipient identity with task fields. Coordinator verifies artifacts and decides acceptance separately. Placeholders must be clearly labeled; use JSON null rather than a quoted fake native-session-null value.

## R3: first contact and discovery still need an actionable boundary

The new reference starts an interactive peer and then says to observe actual receiving capabilities without explaining how the unbound peer receives its first discovery instruction. Add a bounded bootstrap/discovery-contact procedure using authorized installed host/Herdr tools: read-only identity/configuration/capability discovery only, no implementation prompt, no approval answers/settings changes, no polling or work before readiness. This one-time bootstrap contact must be clearly separate from normal product notifications and not treated as work dispatch/authority. If that discovery route is unavailable, identify the concrete blocker rather than inventing a runtime card or silently launching an owned child.

Document how the discovered actual native identity/configuration/cwd/evidence are returned and pinned into the first assignment/binding, then preflight the new actual assignment before work. This must avoid requiring already verified task capabilities before even starting the receiving shell. Keep version-sensitive host command syntax conditional on installed --skill/--help; no private integration dependency or invented executable.

The C12 fixture smoke sends ASK and validates notify plan. It does not exercise ASSIGN dispatch, bootstrap, ACK/REPORT return or live delivery. Retain that useful smoke but label its scope accurately; do not call it proof of the complete new entry procedure. This repair needs a source/schema-checked desk walkthrough, not prohibited live pane/model operations or another broad implementation.

## Repair and delivery

Only documentation/reference/mirror and directly necessary desk-validation changes. Preserve accepted CLI help, all existing APIs/authority behavior, excluded reliability edits and coordinator documents. No new command/controller/bootstrap automation or global/native/model/pane operation. Same Pi session/current claims; new pinned-assignment readiness before source writes. Return current manifest/input revision, prewrite evidence, corrected desk walkthrough and proportionate formatting/mirror/help checks through one proactive REPORT/notification.
