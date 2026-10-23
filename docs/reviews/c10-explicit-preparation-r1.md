# C10 explicit preparation: review round 1

Verdict: changes requested. The correlated REPORT, pinned assignment/input/direction, output/readiness digests, 61-file current manifest and retired-helper deletion were independently verified. Shared strict MCP input and explicit metadata preservation follow the direction, but unsupported-harness refusal has a reproducible own-property bug.

Independent type checking, runtime build, test compilation and 173 relevant collaboration/Pi/CLI/MCP/skill/task tests passed. The cases below are outside that passing selection's current coverage.

## R1: inherited runner keys are accepted and published (P2)

`src/app/collaboration.ts`, `prepareCollaboration`, indexes the exported plain-object `RUNNER_FOR_HARNESS` using an arbitrary validated harness string and refuses only `undefined`. Inputs `constructor`, `toString` and `__proto__` therefore resolve to inherited functions/objects rather than being rejected.

Independent fixture-only script `/tmp/pappra-c10-review.mjs` reproduced all three through the built app API. Each returned `ok: true` and created the domain/task/claims. The first two serialized an assignment whose runner had no `name`; `__proto__` serialized `runner.name: {}`. This breaks the required early refusal and leaves unusable prepared state. No native process was launched and no real workspace/task was touched.

Resolve only supported own entries with a valid string runner value. Keep one shared mapping/lookup policy for preparation and admission, rather than adding a separate drifting table or merely special-casing these three names. An enum/own-property-safe map/lookup is sufficient; no general registry or framework is needed.

Add meaningful app and in-memory MCP negative cases for inherited names, asserting explicit unsupported-harness refusal before any domain/task/claim/card artifact. Preserve existing three valid mappings, strict legacy refusal, role compatibility and controller/harness limits. The installed CLI uses this same app path; verify its invalid branch on a fresh fixture as proportionate.

## Repair scope

Only the supported-runner lookup/refusal correction and focused tests are requested. Keep the chosen C10 API migration and accepted C0-C9 behavior, source exclusions and coordinator documents. No new controller, native launch, dependency/configuration change, broader cleanup or downstream init work.

Use the same Pi session and existing claims. Preflight the newly pinned repair assignment with fresh actual evidence before source writes, and return current manifest/input/readiness/test evidence through one proactive product REPORT/notification.
