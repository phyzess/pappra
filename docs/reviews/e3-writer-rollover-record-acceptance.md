# E3-B1 acceptance: bounded writer rollover record correlation

Accepted after R2 within record-reducer scope. REPORT `sha256:f73078814fadb51d2e7a2bfd960b235b1dc707084ade345b043635c8a58b452b`, exact participant/reply/attempt/epoch, assignment/input/direction/report/output pins and five current owned source plus unchanged helper hashes verified. Coordinator fresh isolated compile `/private/tmp/rollover-r2-review.IEnRFE/build` excludes the other Pi's actively edited host extension. Independent rollover22 + messages33 + core16 tests all pass (71 total).

All eleven independent counterexamples now refuse correctly in `/tmp/pappra-rollover-r2-extra.mjs`, results `/tmp/pappra-rollover-r2-independent-findings.json`: unknown source native, wrong ACK input, unrelated successor native, first-work input/resource drift, malformed rollover field, source native drift before transfer, superseded source attempt, malformed attempt entry, malformed successor run identity and claim epoch drift before confirmation. Invalid native input leaves the record persistable rather than reporting a transfer success with invalid state. The original six and subsequent five failures remain recorded separately.

The optional intent/succession metadata persists inside the existing task record. Existing handoff/claim/attempt state remains authoritative. Native/source/input/current attempt and resource facts are revalidated before transfer; applied ACK and post-transfer successor REPORT evidence is correlated to registered envelope content and pinned input/generation. Only valid first work creates an old-native retained-history marker; successor attempt stays active and routing stays pending. Writer transfer changes resource epochs rather than coordinator epoch. Guarded mutations clone before commit and use the actual record validator; unknown inventory is not completed by default. Exact replay is historical no-op, not renewed execution permission.

Accepted hashes:

- `src/collab/rollover.ts`: `sha256:640a6e893790866509101b32344f62e17af25fa9768631b582171d2448843a20`
- `src/collab/types.ts`: `sha256:fbcacf8976ee4f4db0b6fc41a73667509a58018503d0ccdda1aa00dff37b5751`
- `src/collab/validation.ts`: `sha256:7822d64bd7c9eb1de02a91b99349c37dc32370b5a360f1eacfac87f90a3f8773`
- `src/collab/index.ts`: `sha256:ae5826f0449960cd208e3a9b17d34ce81063ed211b34014ab8996573e8c9a2a5`
- `tests/collab/rollover.test.ts`: `sha256:b53c02bd7e62af8d3f32928c1efe3609a39bba84d6a11a165d75e1ccd03dbddd`

No app/CLI orchestration or real session authority is accepted here. The reducer validates explicit observed native references but does not authenticate a live host or verify a linked bundle against disk. It does not freeze tools, launch/stop sessions, remove routing, archive native sessions or trigger automatic handoff. The separately assigned Pi extension and future guarded app/native integration must supply those capabilities. Previously packed-consumer acceptance predates these source additions and must not be represented as package validation of this new reducer.
