# C7 portable bindings: acceptance

Accepted within the pinned pointer-metadata scope. Repair REPORT `msg-c7-portable-bindings-repair-r1-report` has the announced digest `sha256:2bc794324f3bb47527b9c88011b54766e2c01c3f515e4c6351a4e94d036f3cdb`. Native identities, assignment/reply/attempt/epoch, pinned input, output digests and all 50 current manifest files were independently verified.

Independent type checking, runtime build, test compilation and 162 relevant collaboration/CLI/MCP/skill/task tests passed. The original independent fixture reproducer now observes:

- Capacity refusal (`bindings_capacity`) before an oversized publication; subsequent resolution remains readable.
- Contradictory binding/tombstone metadata refused as `bindings_invalid`.
- Initial-to-apply immutable identity drift refused as `binding_identity_changed`.

The ten-test binding selection also covers exact read-limit input, byte-preserving capacity refusal for both mutation paths, own-property overlap without discovery fallback, and ordinary transaction/inode replacement accepted across the same apply seam. The source passes the exact bounded serialized bytes to the existing atomic publication helper and compares immutable identity independently of an existing alias.

The fresh same-session readiness artifacts for this repair were digest-verified; preflight reports ready at `2026-10-21T05:39:26.358Z`, with prewrite ordering recorded in Pi's report. Readiness does not establish process affiliation or authority. The preserved earlier reliability patch still passes reverse applicability checking and remains outside this acceptance.

Pi additionally reports full-suite/package/source/format/mirror checks. Those broader claims are not relabeled as independent execution; its initial unrelated onboarding failure and successful reruns remain recorded in the report. C7 verification mutated only fresh fixture indexes/domains, not real workspace bindings or live task authority.

Portable aliases provide persisted-history lookup only. They do not locate a relocated record automatically, prove native liveness, grant ownership, adopt sessions or launch/control a model. Native lifecycle parity and clean installed-workflow verification remain open before downstream init/knowledge improvements.
