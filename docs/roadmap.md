# Product roadmap

Updated 2026-11-06. [#41](https://github.com/phyzess/pappra/issues/41) remains open
for the product-level decision. The work packages below are closed in their
documented scopes. [#28](https://github.com/phyzess/pappra/issues/28) and its
[#34](https://github.com/phyzess/pappra/issues/34) G3 evaluation remain open.

## Product direction

Pappra brings reusable working capabilities into a workspace so agents can understand the project, accumulate knowledge, coordinate execution and carry work forward across sessions and environments.

Two equally important product tracks:

| Track                                | User outcome                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Workspace adoption and growth        | Enter a project, find its rules and knowledge, work effectively, preserve useful learning and reuse it later.         |
| Collaborative execution and delivery | Choose an appropriate work split, dispatch reliably, produce reviewable results, accept explicitly and resume safely. |

Shared foundations are task/repository identity, bounded context, provenance, freshness, evidence and authorization. Track importance does not prescribe a fixed staffing or spending ratio.

## Existing programme and completed foundation

- [#28](https://github.com/phyzess/pappra/issues/28) retains its original programme: G1 accepted, G2 implemented, [#34](https://github.com/phyzess/pappra/issues/34)/G3 outstanding. Preserve the accepted work in [#29](https://github.com/phyzess/pappra/issues/29)–[#33](https://github.com/phyzess/pappra/issues/33) and [#35](https://github.com/phyzess/pappra/issues/35).
- [#17](https://github.com/phyzess/pappra/issues/17) is closed through [PR #40](https://github.com/phyzess/pappra/pull/40), merged as `366f49f`. The merged tree matches reviewed candidate `70aeb19`; the eight PR CI check runs succeeded. This is recorded review/CI evidence, not new live-host consumption proof.
- Notify now requires a matching recomputed protocol content digest and an `applied`/`recorded` task-record entry before forwarding, with final revalidation. Message protocol acceptance is distinct from receipt and task-result acceptance.
- [#21](https://github.com/phyzess/pappra/issues/21) established the configuration-authority contract in [PR #48](https://github.com/phyzess/pappra/pull/48). [#49](https://github.com/phyzess/pappra/issues/49) closed the separate diagnostic follow-up.
- [#5](https://github.com/phyzess/pappra/issues/5) retains the exact managed Pi SDK version and private-source hashes with a documented upgrade procedure. [#7](https://github.com/phyzess/pappra/issues/7) preserves the work-run intent after a post-intent refusal and documents the separate typed-dispatch retry contract.
- [#13](https://github.com/phyzess/pappra/issues/13) surfaces a workspace mismatch before rebinding. [#20](https://github.com/phyzess/pappra/issues/20) adds opt-in bounded recipient activity observation. The roster cannot attribute a turn to a specific message, so message-level receipt remains unknown on that path.
- Historical attempt rows in [#34](https://github.com/phyzess/pappra/issues/34) are not ten independent tasks or a paired comparison. Its original sample/baseline/budget and formal G3 contract stay intact.

## Closed work packages and evidence

| Work package | Accepted or observed scope | Evidence boundary |
| --- | --- | --- |
| [#42 Adoption](https://github.com/phyzess/pappra/issues/42#issuecomment-6677701021) | UIVIU reached an accepted local feature after selecting its existing rules, repository and validation. A later reader reused reviewed material. | The trial covered public fixtures and local HTTP. Production data, deployment and host wiring were outside scope. |
| [#43 Bounded context](https://github.com/phyzess/pappra/issues/43#issuecomment-6659942912) | Direct and delegated readers used pinned inputs with visible drift and omissions. A fresh reader recovered the next action. | This acceptance covers context preparation and consumption. Execution authority follows its own workflow. |
| [#44 Reviewed knowledge](https://github.com/phyzess/pappra/issues/44#issuecomment-6659942994) | Pappra's own workspace retained an independently reviewed result and a fresh task reused it. The UIVIU trial separately demonstrated later reuse. | The retained knowledge and review artifacts keep their recorded visibility. |
| [#45 Portability](https://github.com/phyzess/pappra/issues/45#issuecomment-6679035630) | Accepted same-machine relocation and a supplemental Tencent Cloud Linux x86_64 replay preserved shared configuration and document bytes, regenerated local registrations and verified the durable runtime. | The cloud rehearsal excluded host wiring and source-private state. A second physical device was unavailable. |
| [#46 Collaborative delivery](https://github.com/phyzess/pappra/issues/46#issuecomment-6677494697) | In the Check Receipt pilot, separate Codex sessions received Herdr-routed assignments, delivered exact reports and released claims after explicit acceptance. A fresh session reused the accepted output. | The pilot exercised a specific local project and transport. Process affiliation, takeover authority and attributable cost require separate evidence. |

The [backlog disposition](roadmap-backlog.md) records the closed engineering
decisions and the remaining evaluation work.

## Delivery sequence

### Baseline and shared correctness

Reuse the closed configuration authority, notification admission, dispatch retry
and relocation contracts above. The [#41 capability evaluation](https://github.com/phyzess/pappra/issues/41#issuecomment-6677956643)
maps the product journeys to observed results and coverage limits.

### Product trials

UIVIU exercised adoption, delivery of an independently reviewed local feature
and later knowledge reuse. Check Receipt separately exercised the formal
Herdr-to-Codex assignment, report, acceptance and handoff workflow. The two
trials used different routes. The portability rehearsal in #45 used the UIVIU
archive and tested destination-local rebinding separately.

### Capability-level continuation decisions

Finish [#34](https://github.com/phyzess/pappra/issues/34) under its declared scope. Add any prospective measurement extension with a dated method version, preserving old observations and denominators. Evaluate capability benefits separately before selecting the following release scope.

Ten tasks provide exploratory evidence, not statistical safety proof or adequate evidence for every product area. Inconclusive results remain inconclusive.

## Evaluation

| Capability             | Primary observations                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| Adoption               | Time to first useful work, human explanation steps, wrong repository/rule choices.                  |
| Knowledge              | Demonstrated later reuse, repeated investigation, stale/superseded material handling.               |
| Collaboration          | Accepted delivery quality, elapsed time, human coordination, rework and complete attributable cost. |
| Continuity/portability | Recovery effort, missing context, identity errors, repeated work.                                   |
| Engineering support    | Measured failures, maintenance effort or latency reduced in those journeys.                         |

Cost, quality and human effort stay separately visible. Unknown cost never becomes zero. [#34](https://github.com/phyzess/pappra/issues/34)'s directional cost target remains a hypothesis; changing its formal decision contract requires an explicit reviewed amendment, not an interpretation of this roadmap.

## Boundaries

Preserve current host-owned execution, explicit acceptance and independent review for authorization, ownership, persisted recovery and release execution. Preserve the existing beta reset/no-automatic-migration decision. Nothing here grants model, spending, dispatch, merge or publishing authorization.

Retain the existing budget constraints. A cap is not permission to spend. Prefer observation of actual work; paired experiments remain separately authorized.

## Sources and related documents

- [Existing host-native programme](https://github.com/phyzess/pappra/issues/28).
- [G1/G2 acceptance and G3 progress](https://github.com/phyzess/pappra/issues/28#issuecomment-6621188951).
- [Real-task evaluation](https://github.com/phyzess/pappra/issues/34).
- [Notification admission implementation](https://github.com/phyzess/pappra/pull/40).
- [Notification admission closeout](https://github.com/phyzess/pappra/issues/17#issuecomment-6625994750).
- [Host-native boundaries](host-native-boundaries.md), [handoff and review](handoff-and-review.md), [portability](portability.md), [cost ledger](cost-ledger.md) and the [canonical skill](../skills/pappra/SKILL.md).
