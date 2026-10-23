# E3-B3 acceptance: read-only public inspection and notify-only route exclusion

Accepted after R1 within public inspection/notify scope. REPORT `sha256:1be737101552ea19ec500a10afd92fcecf3de98f5a8dde061c6f2ac0ee6997dc`, exact participants/reply/attempt/epoch, assignment/input/direction/report, all ten current owned source hashes and unchanged accepted core/continuity/helper hashes verified. Although outputs remains an empty list, all nine explicit logs object ref/digest pairs were verified, including actual typecheck,18 CLI tests,132 reported regression tests, formatting, mirrors and preserved counterexample results.

Coordinator fresh isolated compilation `/private/tmp/rollover-app-r1-review.3CtPHi/build` and18 actual CLI/app/notify tests pass. Adapted independent fixtures `/tmp/pappra-rollover-app-r1-extra.mjs`, findings `/tmp/pappra-rollover-app-r1-independent-findings.json`, verify all four original defects: a different valid bundle from the same workspace cannot replace an intent's pinned bundle; valid completed transfer has no false source drift and reports historical plan completion; removing intent/ledger/result proof makes old-native route unknown; corrupt900KiB evidence incurs zero unbounded pre-read and exactly921600 reported raw bytes with message_corrupt.

The public `collab rollover inspect|plan --task-root <absolute> --request <absolute JSON> [--json]` is read-only. Request/report schemas and strict CLI contracts expose unavailable native stop/launch/archive capabilities without an apply path. It checks linked bundle pins, identity/context/inventory association and stage-aware current record facts. Notify checks retained-history succession/first-work proof before live query/send, refuses archived old sender/recipient and leaves original envelopes/deliveries/bindings intact. Task-alias bindings remain distinct from per-agent notification participants. Main collab help advertises the new read-only command and mirrored references agree.

Primary accepted source hashes:

- app: `sha256:ea4c84e826d89f0872561907e7b256fa9f6124046d039bf4516925c34c8b3a61`
- route predicate: `sha256:9c1018d7d0e21654ccba4afbf42b5c5c6eec6775c052a01ac10e0024955af1b1`
- notify: `sha256:c1a92b7bbcbff1a42f8ca6085318c2e3c7fb6ec8b579450dff8e122778bcaad9`
- test: `sha256:c819881be271414c4fe85bb94e73cbbc96cf0e0dbd326e0240fbac9f092a60f2`
- umbrella help: `sha256:e8b4174270fe8e39b7e002b03216d9ff44fabf340696c047bb2632c7b2e74e29`
- both references: `sha256:c00ca81841569034a4a8d33bd32d2bcc81436c443ccc4846a3e5e438ecca011d`

Scope limits remain explicit: notify exclusion is not complete dispatch/global routing removal or native session archive. Historical plan_complete does not authorize execution, and no supplied JSON is accepted as a live stop proof. The accepted core/controller/public surfaces need a new cumulative integration/package milestone; prior package acceptance covers only the earlier E2/E3-A foundation. Native bridge/visible successor bootstrap/control and automatic thresholds remain outstanding.
