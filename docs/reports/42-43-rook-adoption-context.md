# #42/#43: reuse-first adoption and bounded context in rook

Date: 2026-11-05. Status: scoped documentation and local mechanism evidence;
**neither issue is complete**. No eligible rook implementation ticket was found.

## Baselines and ownership

- Pappra base: `885e9992133b9ccafeeeffe3d70a0d327db4a370`, including accepted
  configuration-authority, init-version and delivery-observation work.
- Rook selected baseline: `941b68b3a33e14470e4d1092516593abddbfe837` from
  `phyzess/rook` main. The user's actual checkout is `~/personal/rook`, not the
  initially supplied `~/personal/YU/rook`.
- All adoption state lives in a task-owned independent Git clone,
  `/private/tmp/rook-pappra-adoption`, branch `codex/pappra-adoption`. The original
  rook checkout was not switched, built or edited by this task.
- Pappra changes live on `codex/42-43-rook-adoption`. One writer owned the three
  skill/reference files; the coordinator owns this report and local evidence.

## Work breakdown and acceptance

| Slice | Deliverable                                                    | Acceptance                                                                                                  | Current result                                                        |
| ----- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 42.1  | Reuse-first adoption reference linked from the canonical skill | Correct CLI/root selection, existing rules preserved, no-graph/private defaults and authority limits stated | Implemented; independent review recorded separately                   |
| 42.2  | Real external-project local adoption                           | Reproducible steps, source selection/corrections, actual files and coverage recorded                        | Local no-graph mechanism exercised in rook                            |
| 42.3  | First accepted useful task in the adopted project              | An unoccupied task with satisfied dependencies, a fixed deliverable, verification and explicit acceptance   | Blocked: no eligible implementation ticket; not replaced by a fixture |
| 43.1  | Bounded task-context reference using existing carriers         | Reasons, provenance, bounds, omissions and freshness; direct/delegated work reference the same evidence     | Implemented without schema/API changes                                |
| 43.2  | Fresh native consumer reads the retained context               | Finds root, rules, baseline and one safe next action without the previous transcript                        | Read-only consumption exercised; no product implementation authorized |
| 43.3  | Only scenario-proven product gaps                              | Small behavioral change justified by observed evidence and appropriate review                               | No new CLI/service/schema justified in this slice                     |

The scope intentionally leaves large-batch scanning (#14), provenance command
exposure (#44), portability (#45) and delivery reuse (#46) in their own work.

## Model choices and evidence limits

All delegates used fresh contexts via the host's native subagent tool:

| Responsibility              | Explicit configuration | Reason                                    |
| --------------------------- | ---------------------- | ----------------------------------------- |
| #42/#43 scoping             | `gpt-6.1-sol`, medium  | Existing-carrier and contract assessment  |
| Rook issue readiness        | `gpt-6-luna`, medium   | Bounded read-only labels/dependency check |
| Skill/reference writer      | `gpt-6.1-sol`, medium  | One cohesive documentation scope          |
| Fresh context consumer      | `gpt-6.1-sol`, medium  | Independent evidence consumption          |
| Independent recipe reviewer | `gpt-6.1-sol`, high    | Privacy, authority and evidence semantics |

These are explicit host selections, not independently attested model snapshots
or provider billing. Native task paths were observed from the host tool; no
separate native session journal or runtime capability card was established.
An inherited environment session ID was not promoted to a child identity.
There was no Herdr/Pi launch, typed-workflow dispatch, ownership or stop proof.
This native consumption experiment does not validate those other transports.
Attributable token/dollar cost and human active minutes are unavailable.

## Local adoption observations

The original clone had neither `.pappra/` nor `.codegraph/`. Discovery used the
selected Pappra worktree's built CLI with cwd in the rook clone; an older build
in the original Pappra checkout was not used as the current candidate's CLI.

Before applying, the coordinator reviewed a `pappra/init-choices/1` document:

- repository `.` with read access; name `rook`;
- sources `AGENTS.md`, `README.md`, `CONTEXT.md`, `docs`;
- `code.graph: none`, `code.symbols: none`, `code.prepare: manual`, no hosts;
- private task visibility; `check` and `test` as validation candidates only.

The discovery defaults selected fewer rule/context sources and selected a lint
subcommand rather than the whole check gate. Those were explicit operator
choices to review, not unqualified product defects. No validation was executed
merely because it appeared in configuration.

| Actual operation                                       | Result                                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `init --config <reviewed choices> --no-runtime --json` | Exit 0, preview proposed only workspace and machine configuration                       |
| Same command with `--apply`                            | Exit 0; configuration applied, runtime intentionally pending                            |
| `docs scan --apply --json`                             | Exit 0; 18 existing documents registered privately, content unchanged                   |
| `docs list`                                            | Empty default view with an explicit private-document hint                               |
| `docs list/check --include-private --json`             | Exit 0; private records inspected locally, not published                                |
| `doctor --json`                                        | Exit 1; workspace/authority checks healthy, runtime and host integration incomplete     |
| `code status` and `code query --kind explore`          | Exit 1; explicit no-graph selection/unsupported coverage, not semantic navigation proof |
| `code query --kind text --query ready-for-agent`       | Exit 0; 3,850 result bytes, no truncation                                               |

No index, runtime, hook, global configuration or rook product dependency was
installed. Rook already ignores `.pappra/`; Git status therefore stays clean.
That is the actual pre-existing ignore policy, not a new exclusion introduced
to conceal task fingerprints. Private files are retained separately.

The user corrected the target directory and stated that #7 was already being
handled elsewhere. Its occupancy is a user instruction, not verified native
ownership. It was excluded before implementation. Independent live issue checks
found no open `ready-for-agent` implementation ticket: #8 waits for #7, #10 for
#8, #11 for #10, and later work for the relevant Gate. The old #9 offline
exception was not borrowed for another ticket. Nothing in rook was relabeled,
implemented or reported accepted. Time to first accepted implementation remains
unavailable because that milestone has not happened.

## Bounded context and fresh consumption

The coordinator used existing `decisions[]`, `limitations[]`, `artifacts[]` and
`nextActions[]`, with no new persistent schema. Three private files hold a task
note, selection reasons/digests and a timestamped open-issue snapshot. These
files are evidence pointers, not a replacement authoritative issue database.

The captured checkpoint is revision 1,
`checkpoints/0001-554cd6e7-56a5-4329-bfee-a3dd0c14630c.json`, digest
`sha256:45270f81265ffc9047616a74579db1f0cf701345de68394460c19bb1e8fccc42`.
The coordinator and native consumer referenced that same checkpoint and files.
Its retained bytes are current; `executionAllowed` remains false. Unknown
writer/live ownership and partial context are preserved, not inferred away.

The fresh consumer received only the CLI/task/root entry and read-only scope,
not the original discussion or the writer's draft. Before live GitHub checks,
it correctly inferred the next step: recheck for an admitted, unoccupied ticket;
if none exists, report blocked and stop product writes. It then independently
confirmed that dependency outcome and checked the selected source digests.

Measured unique file inputs: three evidence files, 16,892 bytes; the checkpoint,
2,363 bytes; nine project-required documents, 57,319 bytes: 13 unique files,
76,574 bytes. These are file sizes, not token usage. The consumer encountered
tool-output truncation and re-read five documents: required-document read
volume became 91,072 bytes within its 100,000-byte document budget. Repeated
reads, packet output and GitHub output are not silently counted as unique
material or asserted as measured total model context.

The historical local branch revision was explicitly superseded by the full
selected baseline; unrelated project/UI material was omitted. Semantic
supersession is a host explanation, not a claim that the resume API proves
it. Current issue status was re-read rather than trusted from the snapshot.

## Deliberate mechanism probes

A separate, explicitly labeled fixture task captured four task-owned files.
After capture, one file's bytes were changed and another was moved to a retained
name so its original path was missing. Actual resume returned `stale`, artifact
statuses `changed` and `missing`, and `executionAllowed: false`. The old/current
advice pair remained byte-unchanged; its supersession was explained in a host
decision. This does not test a product supersede command or prove a cloud task.

## Verification, disposition and remaining work

- Explicit Prettier checks include the ignored `docs/` report path; final results
  and candidate identity are in the coordinator's retained evidence.
- Initial `pnpm build` and `pnpm package:check` passed in the isolated Pappra
  worktree with 615 files. This did **not** verify that the new references were
  distributed: only `skills/pappra` had been updated, while the distribution
  source in `src/assets/integrations/skills/pappra` retained the old skill.
  The earlier bundled-reference statement was incomplete and is corrected here.
- PR #53 CI caught that omission in every matrix's existing skill-mirror test.
  The coordinator reproduced the failure, then synchronized the three reviewed
  documentation files into the distribution source. The same test passed 2/2
  afterward, without weakening its assertions. Final integration outcomes are
  recorded in the CI follow-up below.
- No executable source or dependency changed. The full unit suite was initially
  omitted for the documentation slice; that validation choice missed a required
  distribution invariant. No rook build/test was needed for a read-only task.
- The fresh consumer supports read-only usefulness, not full #42 acceptance,
  live ownership or all #43 transports. Independent recipe review is a separate
  result; a report alone never accepts implementation.
- Raw command responses, init choices, probe files and the step plan are retained
  privately by the coordinator. This report publishes no raw private document
  contents. Nothing has been pushed, merged, released, or cleaned up by this task.

Next: select a genuinely available external implementation task or explicitly
approve a new independent rook slice; then exercise first useful delivery and
its acceptance. Separately complete any remaining #43 acceptance coverage before
closing that issue. #7 and the existing A/B/C branches/reports remain untouched.

## PR #53 CI follow-up

The push and pull-request runs both failed the skill-mirror invariant. The
pull-request Ubuntu/Node 26 job additionally failed a 500 ms elapsed-time lower
bound in the silent-initialize timeout test; the equivalent push job did not.
That difference alone does not establish a cause or justify changing the test.
The correction preserves the reviewed documentation bytes and synchronizes
their distribution source. A subsequent full local run also exposed the
ordinary Pi bundle test's exact file list, which still described the previous
skill file set. Its expected list now includes both references and checks their
exported bytes against the reviewed documents; existing runtime, hook and
non-bootstrap assertions are retained. A fresh native reviewer verified this
test delta without changing or weakening those assertions. After recompiling,
the skill-mirror and Pi bootstrap/bundle test files passed 20/20. Full-run and
package outcomes are recorded separately; that targeted result alone is not a
claim that the complete CI matrix passed.
