# Bootstrap Pi bundle implementation

Preparation STATUS `msg-e3-bootstrap-bundle-preparation-status`, delivery `sha256:6424688cb70afbee99277fe99b8fd47ab3d2b8b13767411582f2c1b9d0da6e9c`, seven outputs, fresh runtime/nested evidence, existing scope and immutable adjacent pins verified. Proceed with the proposed ten-file scope, refined below. This exports a reviewable opt-in artifact; it does not install, trust, launch a model/session, transfer or archive.

## User entry and compatibility

Implement `pappra host bundle --host pi --out <new-private-directory> --bootstrap-config <absolute-file> [--json]`. The flag is Pi-only and bundle-only, rejects invalid host/action/flag combinations before output writes, and does not change ordinary bundles. Keep current JSON/exit conventions and make help/documentation precise. The initial bootstrap output contract is **absent destination only**, not existing-empty reuse: reserve a new private directory exclusively after input validation; reject any existing/symlink/non-directory destination without touching it. Do not broaden ordinary-bundle overwrite behavior as unrelated cleanup.

Validate a bounded64KiB no-follow regular configuration file, exact `pappra/pi-bootstrap-config/1` schema/known keys, guard limits/identities/unique claim set/safe raisable epochs, canonical existing task-domain/root identity and taskId equality. Reuse accepted local reader/guard validation semantics without changing their files or creating directories/claims while checking. Preserve current pre-transfer task records as valid export inputs: exporting a guard is not granting authority to write. Pin validated/copy data and do not reread a changed input during output generation. Task binding is private local data, not an asset compiled into the published package. New output directory0700 and config0600 on supported POSIX; artifact code may be relocated but the selected authoritative task root remains explicit and canonical.

## Startup gate and generated artifact

Use a dedicated bundled entry plus shared strict config parser. Keep existing lifecycle extension/runtime/template and accepted gate/reader/freeze/events/core modules unchanged. Bundle code imports/config paths are relative inside the export; no development checkout paths, runtime source-tree import, global config or caller allow callback. Include the existing Pi lifecycle/skill capability through the current extension entry as proposed; preserve daily tools/MCP/skills/hooks/model.

Register a default-deny native tool_call handler before attempting dynamic config/reader/lifecycle initialization. Configuration missing/malformed/changed, task-root mismatch or initialization failure while the entry is loaded must keep denial active, expose a useful read-only `bootstrap-status`, and not throw away the guard into loader fallthrough. Mark initialization complete only after the accepted runtime gate and normal lifecycle registration succeeded. No allow/thaw/release command, arbitrary model path/token, permanent unlock or bypass. The fallback's readiness must not mask actual guard failures.

Use distinct status concepts: **extension/guard registered** versus **write permitted by current transfer state**. Do not report bare ready/success as permission before transfer. A read-only status command may report registered/denied plus reason; it must not modify claims or gate state. A total Pi loader/trust/import failure is not enforced gating; keep it unverified and require the future launcher to check initialization before model work. This source slice cannot fix host load failures by assertion.

## Exact ten-file scope

1. NEW `src/hosts/integration/bootstrap-config.ts`.
2. NEW `src/hosts/integration/pi-bootstrap-extension.ts`.
3. NEW `tests/hosts/pi-bootstrap-extension.test.ts`.
4. `src/hosts/integration/bundle-export.ts`.
5. `src/cli/commands/host.ts`.
6. `src/cli/run.ts`.
7. `scripts/build-assets.ts`.
8. `docs/host-plugin-validation.md`.
9. `skills/pappra/references/hosts.md`.
10. `src/assets/integrations/skills/pappra/references/hosts.md` (exact mirror).

Do not change `bundle.ts`, templates, Pi ordinary extension runtime, host schema, package exports/dependencies/lock, accepted ten adjacent source/tests or shared build outputs. Claims establish scope, not ownership of the other Pi's accepted modules. Preserve the dirty baseline.

## Verification and report

Use an isolated staged build with **private copied dependencies**, internal link checks and direct Node commands. Shared node_modules metadata/dist/.build must stay unchanged; avoid pnpm lifecycle. Build once including the new `pappra-bootstrap-extension.mjs`, then focused tests/type/format/source policy, not a full-suite rerun. A focused non-network ignore-scripts pack/static archive check is authorized for the new required build artifact; no registry install, dependency download, publication or model/native run.

Tests must execute the generated exported entry/runtime, with actual temporary task-domain records and a faithful ExtensionAPI boundary. Check startup default deny for missing/malformed config and root/lifecycle init errors, normal fixture completed-transfer first-write success and drift denial, status not granting authority, and no handler/command bypass. Test CLI wrong-host/action/flags and malformed/oversized/symlink config before writes. Verify existing output is byte-identical on rejection, bootstrap output private/relative, and ordinary Pi bundle file set/bytes unchanged without the flag. Simulated API tests are not native-host proof. Preserve accepted adjacent hashes, pin generated artifacts/source/logs and mirror equality. Report partial output/failure truthfully; no deleting unexpected concurrent user files during cleanup.

One proactive REPORT with exact inputs/scope/output hashes, commands/counts and limits. Current genuine18:33:36Z card may be reused while fresh; exact new claims and matching new-assignment coordinator preflight precede dispatch. No hidden worker, completion polling, native/model/pane/session/install/settings/dependency/commit/publication actions.
