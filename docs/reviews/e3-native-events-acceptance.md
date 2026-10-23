# Native event producer acceptance

Accept R2 as an opt-in in-process event observation module only. It is not installed or activated, does not feed the freeze controller, and does not prove quiescence, transfer or automatic rollover. No full-suite or new package acceptance is implied.

REPORT delivery `sha256:9bdaf09dc386e2beb5c6b75aff39e2e6b75a1ea6b09a5f5539debe3ee9c0a4f3`, reply/session/epoch correlation, six output pins, current producer/test pins and nested runtime evidence verified. Accepted files:

- `src/hosts/integration/pi-native-events.ts`: `sha256:c2ddeeb3ba8c93b7de3b2ead85067f4ba2e673eda5a07da61224a971771c7107`.
- `tests/hosts/pi-native-events.test.ts`: `sha256:e80f1358fb908d818ffea3d852ec3b041e67237186435856ea6e2d20072474ea`.

Freeze source/test remain unchanged at `cf794b1e15b226053b01544dd44e54edea90e48b16a02e02b671faa95de2e0f2` / `148ec4ed18220d939cf5cf2ba6c8a3fff2420f6ce255bc5e63fe92b10409a038`.

Coordinator helper `/tmp/pappra-native-events-r2-review.mjs` performs a fresh isolated compilation and43 producer/freeze tests, all passing. It replays the original four callback counterexamples plus both finite notification-loss probes and asserts conservative outcomes. Findings: `/private/tmp/native-events-review.BXeyxH/findings.json`; tests: `/private/tmp/native-events-review.BXeyxH/tests.log`.

Unknown identity no longer resurrects settled facts or consumes old-session tool IDs. Throwing tool payload access invalidates confidence and still notifies. Normal reentrant delivery preserves sequence order. Both queue capacity and per-drain budget loss end active listeners on an explicit conservative gap notification; terminal reentry stays bounded in the focused regression suite. A delivery gap is sticky for the producer lifetime; recreating a producer loses prior history and is not recovery evidence or permission to transfer. Sequence saturation remains explicit. Queue, global approvals and in-flight completeness remain unknown; nativeStop remains false.

Source-policy closure from the preceding comment-only correction remains accepted. Historical package evidence predates this producer and is not relabeled. The next work should map a complete supported explicit transfer path using existing ownership, handoff, readiness, binding and first-work primitives, rather than add isolated observation layers or claim unknown native authority.
