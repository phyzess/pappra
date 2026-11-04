# Product roadmap

Updated 2026-11-04. Product direction is approved for planning; work packages still need current-source triage and explicit execution scope. GitHub [#41](https://github.com/phyzess/pappra/issues/41) tracks this roadmap. Existing execution policy is unchanged.

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
- [#7](https://github.com/phyzess/pappra/issues/7) retry policy, [#20](https://github.com/phyzess/pappra/issues/20) receipt observation, [#13](https://github.com/phyzess/pappra/issues/13) relocation identity and [#21](https://github.com/phyzess/pappra/issues/21) configuration authority remain separate open scopes. [#5](https://github.com/phyzess/pappra/issues/5)'s compatibility decision remains open.
- Historical attempt rows in [#34](https://github.com/phyzess/pappra/issues/34) are not ten independent tasks or a paired comparison. Its original sample/baseline/budget and formal G3 contract stay intact.

## Work packages and milestones

| Work package                                                                                              | Existing capabilities to reuse                                                                                                                                                                                                                     | Milestone                                                                                      |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [#42](https://github.com/phyzess/pappra/issues/42) First useful work in a newly adopted workspace         | init/onboard, discovery, docs, code, doctor; [#14](https://github.com/phyzess/pappra/issues/14) scan behaviour                                                                                                                                     | [Workspace adoption and knowledge growth](https://github.com/phyzess/pappra/milestone/6)       |
| [#43](https://github.com/phyzess/pappra/issues/43) Bounded task context for direct and collaborative work | [#30](https://github.com/phyzess/pappra/issues/30) handoff carrier, selected knowledge/code, provenance and freshness                                                                                                                              | [Shared foundations](https://github.com/phyzess/pappra/milestone/5)                            |
| [#44](https://github.com/phyzess/pappra/issues/44) Reviewed knowledge and demonstrated later reuse        | register/write/review, sources, supersede/archive                                                                                                                                                                                                  | [Workspace adoption and knowledge growth](https://github.com/phyzess/pappra/milestone/6)       |
| [#45](https://github.com/phyzess/pappra/issues/45) Portable project value with local rebinding            | portability/onboard/handoff, [#13](https://github.com/phyzess/pappra/issues/13) identity, [#8](https://github.com/phyzess/pappra/issues/8) compatibility                                                                                           | [Workspace adoption and knowledge growth](https://github.com/phyzess/pappra/milestone/6)       |
| [#46](https://github.com/phyzess/pappra/issues/46) Reusable collaborative delivery and handoff            | [#30](https://github.com/phyzess/pappra/issues/30), completed [#17](https://github.com/phyzess/pappra/issues/17), scoped [#22](https://github.com/phyzess/pappra/issues/22)/#23 increments, [#43](https://github.com/phyzess/pappra/issues/43)/#44 | [Collaborative execution and reusable delivery](https://github.com/phyzess/pappra/milestone/7) |

These are product groupings, not permissions or strictly serial phases. `needs-triage` means a current capability/evidence assessment is still required, not ready for unattended dispatch. The [backlog disposition](roadmap-backlog.md) maps every existing item to its current role.

## Delivery sequence

### Baseline reconciliation

Produce one capability/evidence map covering existing APIs, CLI paths, skills, documented limitations and real-host evidence. Classify each item as accepted, implemented but unverified, in flight or proposed. Record [#17](https://github.com/phyzess/pappra/issues/17) as completed baseline and preserve its regression contract; do not assign another implementation for it.

Exit: the next write scopes have known owners, dependencies and missing evidence; previously accepted gates remain intact.

### Shared correctness and usable entry points

Prioritize the bounded remaining authorization classification in [#21](https://github.com/phyzess/pappra/issues/21), current-version reproduction of [#13](https://github.com/phyzess/pappra/issues/13) and the delivery/retry decision in [#7](https://github.com/phyzess/pappra/issues/7). Reuse the completed [#17](https://github.com/phyzess/pappra/issues/17) notification-admission gate. These are local prerequisites only for the paths they affect, not a blanket requirement to finish all backlog before useful product work.

Exit: the selected adoption and collaboration scenarios have explicit, tested identity and authority boundaries, or an exact supported limitation.

### Parallel product loops

Workspace loop: adopt project → prepare relevant context → complete real work → review a knowledge candidate → reuse it in a later task.

Collaboration loop: choose split → dispatch → observe result → independently review when required → explicitly accept or correct → hand off if needed.

Reuse existing commands and artifacts first. New commands, schemas and infrastructure require demonstrated gaps. Neither loop requires full automation to count as useful.

Exit: each loop has a reproducible external-project example, actual outcomes and unresolved limitations.

### Connected external-project trial

Use the same external project to connect collaboration delivery with reviewed knowledge and later-session reuse. Include the actual host/environment coverage, direct-work fallback and operator interventions. Do not silently claim a second machine or second host from a fixture.

Exit: a fresh session can use the accepted delivery and knowledge without the originating chat, with provenance and stale-state handling visible.

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
