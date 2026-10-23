# C8 native lifecycle discovery: review and direction

Accepted as a read-only investigation, not native-host parity or implementation acceptance. The announced REPORT digest, native participants/reply/attempt/epoch, assignment/direction/input, output/readiness artifacts, 38 inspected repository files, unchanged C7 50-file baseline and four pinned legacy references were independently verified.

Independent source checks confirm the key architectural limits: `driveRun` records CANCEL before calling its controller; `PiRpcController` delegates to the owned Pi handle whose cancel method records another CANCEL. `prepareFromObjective` supplies fixed identities/configuration and derives cwd from a resource, while assignment generation fixes the runner to Pi. Installed live controllers remain fixture/Pi RPC. Native ownership is not recovered by reading a pointer or opening a new client.

The cancellation issue is a confirmed source path, with runtime reproduction still required. Do not claim duplicate uncertainty rows without inspecting core deduplication. C9 will first demonstrate the combined driver/Pi controller behavior using a fake executable, then repair intent propagation while retaining the driver's refusal before native calls and the standalone owned-handle contract.

Next sequencing:

1. C9: one recorded cancellation intent across the owned Pi stack, with deterministic combined tests.
2. Explicit preparation contract: unify or correct MCP inputs, independent cwd, role/runner support and early unsupported-host refusal. Final schema/compatibility direction remains to be pinned separately; do not implement it in C9.
3. Separate completed-history candidate recovery from live owned control, implementing only required missing public routes with demonstrable authority. No durable owner reconstruction, PID adoption or new controller daemon.
4. Clean tarball/consumer walkthrough of supported installed workflows, using fixtures/fake hosts with honest live-host limits. The real visible Herdr product roundtrip already provides messaging evidence, not native-control proof.

Keep the legacy pilot isolated: its deliberate MCP/hooks/tools/permission overrides conflict with transparent daily-runtime reuse. Do not expose it as a daily default. Current visible peer messaging remains the primary collaboration loop. Missing non-Herdr notification is a separate capability gap, not a reason to launch another hidden worker or improvise session adoption.

The report's static findings and historical host evidence are useful design inputs; no current real three-host launch/cancel/stop verification was performed. Preserve that limitation. Subsequent authored repository documents/reports should use professional English, as required by the working agreement.
