import { join, resolve } from 'node:path';
import type { Diagnostic } from '../../schemas/diagnostics.js';
import { diagnosticCodes } from '../../schemas/errors.js';
import {
  INIT_CHOICES_SCHEMA,
  parseInitChoices,
  type InitChoices,
} from '../../schemas/init.js';
import { readTextFileBounded } from '../../infra/fs.js';
import { getPackageInfo, getPackageRoot } from '../../package-info.js';
import { installRuntime, runtimePaths } from '../../install/runtime.js';
import {
  applyInitPlan,
  bindAndRecordRuntime,
  ensureDefaultRuntime,
  inspectInitContext,
  listKnowledgeCandidates,
  deriveCommonInitDefaults,
  deriveInitChoices,
  existingInitChoices,
  listRepositoryCandidates,
  validateInitField,
  inspectInitPathAddition,
  planWorkspaceInit,
  type InitApplyResult,
  type InitContext,
  type InitEditableField,
  type InitPathObservation,
  type KnowledgeCandidate,
  type RepositoryCandidate,
  type InitFailure,
  type InitPlanBundle,
  type RuntimeFlowResult,
} from '../../app/init.js';
import type { CliOutput } from '../output.js';
import {
  clackProgress,
  clackWizardUi,
  confirmApply,
  type ProgressUi,
  type SelectOption,
  type WizardUi,
} from '../interactive.js';
import { runSetupFollowUps } from './setup-flow.js';

const addExistingRepositoryAction =
  '../__pappra_add_existing_repository_action__';
const addExistingKnowledgeAction =
  '../__pappra_add_existing_knowledge_action__';
const collectedPathObservations = new WeakMap<
  InitChoices,
  readonly InitPathObservation[]
>();
function initPathObservationKey(
  kind: InitPathObservation['kind'],
  path: string,
): string {
  return `${kind}:${path}`;
}

function repositoryCandidateFromPathObservation(
  observation: InitPathObservation,
): RepositoryCandidate | null {
  if (observation.kind !== 'repository' || observation.git === null) {
    return null;
  }
  return {
    key: observation.path,
    id: null,
    external: false,
    access: 'read',
    root: observation.git.root,
    kind: observation.git.kind,
    dirty: observation.git.dirty,
    configured: false,
  };
}

function knowledgeCandidateFromPathObservation(
  observation: InitPathObservation,
): KnowledgeCandidate | null {
  if (observation.kind !== 'knowledge') return null;
  return {
    path: observation.path,
    kind: observation.targetKind,
    origin: 'explicit-path',
    repositoryId: null,
  };
}

export type { SelectOption, WizardUi } from '../interactive.js';
export { clackWizardUi } from '../interactive.js';

async function promptValue<T>(
  promise: Promise<T | symbol>,
  ui: WizardUi,
): Promise<T | null> {
  const value = await promise;
  if (typeof value === 'symbol') {
    ui.cancel('Init cancelled; no files were written.');
    return null;
  }
  return value;
}

async function askHosts(
  ui: WizardUi,
  initial: readonly string[],
): Promise<readonly string[] | null> {
  return promptValue(
    ui.multiselect(
      'Select hosts to record (declaration only; no installation, detection or wiring)',
      [
        {
          value: 'pi',
          label: 'Pi',
          hint: 'Declaration only; not detected or verified',
        },
        {
          value: 'codex',
          label: 'Codex',
          hint: 'Declaration only; not detected or verified',
        },
        {
          value: 'claude',
          label: 'Claude',
          hint: 'Declaration only; not detected or verified',
        },
      ],
      initial,
    ),
    ui,
  );
}

/**
 * UI-only selection collection. All validation and plan generation remains in
 * the app service; cancelling this function never writes to the workspace.
 */
export async function collectInitChoices(
  context: InitContext,
  ui: WizardUi,
  options: {
    readonly reconfigure?: boolean;
    readonly draft?: InitChoices;
    readonly reviewOnly?: boolean;
    readonly pathObservations?: readonly InitPathObservation[];
    readonly introShown?: boolean;
  } = {},
): Promise<InitChoices | null> {
  if (options.introShown !== true) ui.intro('Pappra workspace init');
  const existingConfig = context.workspaceInspection.value;
  const existingMachine = context.machineInspection.value;
  if (
    existingConfig !== null &&
    options.reconfigure !== true &&
    options.draft === undefined
  ) {
    const hosts = existingMachine?.selectedHosts ?? (await askHosts(ui, []));
    if (hosts === null) return null;
    const choices = {
      ...existingInitChoices(existingConfig, existingMachine),
      hosts: [...new Set(hosts)] as InitChoices['hosts'],
    };
    ui.note(
      'Existing valid workspace configuration is reused. Only missing local state is planned; no existing file is overwritten.',
      'Existing configuration',
    );
    collectedPathObservations.set(choices, options.pathObservations ?? []);
    ui.outro('Selections complete. Review the plan before applying.');
    return choices;
  }

  const seed =
    options.draft ??
    (existingConfig === null
      ? undefined
      : existingInitChoices(existingConfig, existingMachine));
  const common = deriveCommonInitDefaults(context.discovery);
  const repositoryCandidates = listRepositoryCandidates(context.discovery);
  const knowledgeCandidates = listKnowledgeCandidates(context.discovery);
  const pathObservations = new Map<string, InitPathObservation>();
  for (const observation of options.pathObservations ?? []) {
    pathObservations.set(
      initPathObservationKey(observation.kind, observation.path),
      observation,
    );
  }
  const explicitRepositoryCandidates = new Map<string, RepositoryCandidate>();
  const explicitKnowledgeCandidates = new Map<string, KnowledgeCandidate>();
  for (const observation of pathObservations.values()) {
    const repository = repositoryCandidateFromPathObservation(observation);
    if (repository !== null) {
      explicitRepositoryCandidates.set(repository.key, repository);
    }
    const knowledge = knowledgeCandidateFromPathObservation(observation);
    if (knowledge !== null) {
      explicitKnowledgeCandidates.set(knowledge.path, knowledge);
    }
  }
  const knownKnowledge = new Set([
    ...knowledgeCandidates.map((candidate) => candidate.path),
    ...explicitKnowledgeCandidates.keys(),
  ]);
  const initialRepositories: InitChoices['repositories'] =
    seed !== undefined
      ? seed.repositories.map((repository) => ({ ...repository }))
      : repositoryCandidates.length === 1
        ? [
            {
              path: repositoryCandidates[0]!.key,
              access: repositoryCandidates[0]!.access,
              ...(repositoryCandidates[0]!.id === null
                ? {}
                : { id: repositoryCandidates[0]!.id }),
            },
          ]
        : [];
  const draft: InitChoices = {
    schema: INIT_CHOICES_SCHEMA,
    ...(seed?.workspaceId === undefined
      ? {}
      : { workspaceId: seed.workspaceId }),
    name: seed?.name ?? common.name,
    repositories: initialRepositories,
    knowledge: {
      ...(seed?.knowledge ?? common.knowledge),
      sources: [...(seed?.knowledge.sources ?? common.knowledge.sources)],
    },
    code: seed?.code ?? {
      graph: 'none',
      symbols: common.code.symbols,
      prepare: common.code.prepare,
    },
    validation: [...(seed?.validation ?? [])],
    excludes: [...(seed?.excludes ?? common.excludes)],
    hosts: [...(seed?.hosts ?? [])] as InitChoices['hosts'],
  };

  if (!options.reviewOnly)
    ui.note(
      `Workspace root: ${context.root}\nMode: ${
        existingConfig === null
          ? 'new workspace'
          : 'editing existing workspace settings'
      }\nSelections are a read-only draft until the later plan confirmation. Existing knowledge source files/folders are discovered and registered in place later; the new document destination is only for future authored documents. No files are created or changed while collecting choices.`,
      'Workspace context',
    );

  const promptText = async (
    message: string,
    initialValue: string,
    field?: 'name' | 'newDocuments' | 'excludes',
  ): Promise<string | null> => {
    const value = await promptValue(
      ui.text(
        message,
        initialValue,
        field === undefined
          ? undefined
          : (candidate) => validateInitField(field, candidate) ?? undefined,
      ),
      ui,
    );
    return typeof value === 'symbol' ? null : value;
  };

  const promptExplicitPath = async (
    kind: InitPathObservation['kind'],
  ): Promise<InitPathObservation | null> => {
    const field: InitEditableField =
      kind === 'repository' ? 'repositoryPath' : 'knowledgePath';
    let initialValue = '';
    for (;;) {
      const value = await ui.text(
        kind === 'repository'
          ? `Existing repository path under workspace root ${context.root}`
          : `Existing knowledge file or folder path under workspace root ${context.root}`,
        initialValue,
        (candidate) => validateInitField(field, candidate) ?? undefined,
      );
      if (typeof value !== 'string') {
        ui.note(
          'Path addition cancelled; the current draft selections are unchanged.',
          'Path addition',
        );
        return null;
      }
      const inspected = await inspectInitPathAddition(
        context.root,
        kind,
        value,
        draft.excludes,
      );
      if (inspected.ok) return inspected.observation;
      ui.note(diagnosticLines(inspected.diagnostics), 'Path not added');
      initialValue = value;
    }
  };

  const editWorkspace = async (): Promise<boolean> => {
    const name = await promptText('Workspace name', draft.name ?? '', 'name');
    if (name === null) return false;
    draft.name = name;
    return true;
  };

  const editRepositories = async (): Promise<boolean> => {
    const buildCandidateMap = (): Map<string, RepositoryCandidate> => {
      const candidates = new Map<string, RepositoryCandidate>();
      for (const candidate of repositoryCandidates) {
        candidates.set(candidate.key, candidate);
      }
      for (const candidate of explicitRepositoryCandidates.values()) {
        if (!candidates.has(candidate.key))
          candidates.set(candidate.key, candidate);
      }
      return candidates;
    };
    const buildOptions = (
      candidates: ReadonlyMap<string, RepositoryCandidate>,
    ): SelectOption[] => {
      const result = [...candidates.values()].map((candidate) => ({
        value: candidate.key,
        label: `${candidate.key}${candidate.external ? ' (external)' : ''}`,
        hint: `${candidate.kind}; ${candidate.external ? 'explicit external mapping' : 'discovered or explicitly inspected checkout'}${candidate.dirty === true ? '; dirty' : ''}`,
      }));
      for (const repository of draft.repositories) {
        if (result.some((candidate) => candidate.value === repository.path)) {
          continue;
        }
        result.push({
          value: repository.path,
          label: `${repository.path} (configured; not discovered)`,
          hint: 'Retained existing selection; planning fails if it cannot be resolved',
        });
      }
      result.push({
        value: addExistingRepositoryAction,
        label: 'Add existing repository…',
        hint: `Inspect one workspace-relative checkout beneath ${context.root}; no global or ancestor discovery`,
      });
      return result;
    };

    let selectedKeys = [
      ...new Set(draft.repositories.map((repository) => repository.path)),
    ];
    for (;;) {
      const candidates = buildCandidateMap();
      const selected = await promptValue(
        ui.multiselect(
          `Select repositories in this workspace (resolved root: ${context.root})`,
          buildOptions(candidates),
          selectedKeys,
        ),
        ui,
      );
      if (selected === null) return false;
      selectedKeys = [
        ...new Set(
          selected.filter((key) => key !== addExistingRepositoryAction),
        ),
      ];
      if (!selected.includes(addExistingRepositoryAction)) break;

      const observation = await promptExplicitPath('repository');
      if (observation === null) continue;
      const candidate = repositoryCandidateFromPathObservation(observation);
      if (candidate === null) {
        ui.note(
          'The entered location did not produce a repository observation.',
          'Path not added',
        );
        continue;
      }
      const observationKey = initPathObservationKey(
        'repository',
        observation.path,
      );
      pathObservations.set(observationKey, observation);
      const existing = [...buildCandidateMap().values()].find(
        (entry) => entry.key === candidate.key || entry.root === candidate.root,
      );
      if (existing !== undefined) {
        if (!selectedKeys.includes(existing.key))
          selectedKeys.push(existing.key);
        ui.note(
          `That checkout is already available as ${existing.key}; it was selected without adding a duplicate.`,
          'Repository already available',
        );
        continue;
      }
      explicitRepositoryCandidates.set(candidate.key, candidate);
      if (!selectedKeys.includes(candidate.key))
        selectedKeys.push(candidate.key);
      ui.note(
        `Added ${candidate.key} as an existing workspace-local checkout. The selected access policy remains a separate workspace choice; no files were written.`,
        'Repository added',
      );
    }

    const candidates = buildCandidateMap();
    const repositories: InitChoices['repositories'] = [];
    for (const key of selectedKeys) {
      const candidate = candidates.get(key);
      const seeded = draft.repositories.find(
        (repository) => repository.path === key,
      );
      const access = await promptValue(
        ui.select(
          `Repository access policy for ${key} (workspace policy only; not a host permission or command execution)`,
          [
            { value: 'read', label: 'read', hint: 'Least-privilege policy' },
            {
              value: 'write',
              label: 'write',
              hint: 'Workspace policy cap only; host permissions still apply',
            },
          ],
          seeded?.access ?? candidate?.access ?? 'read',
        ),
        ui,
      );
      if (access === null) return false;
      const id = seeded?.id ?? candidate?.id ?? null;
      repositories.push({
        path: key,
        access: access as 'read' | 'write',
        ...(id === null ? {} : { id }),
      });
    }
    draft.repositories = repositories;
    return true;
  };

  const editKnowledge = async (): Promise<boolean> => {
    const rank = (path: string, isDirectory: boolean): number =>
      isDirectory ? 1 : path.includes('/') ? 2 : 0;
    const buildCandidateMap = (): Map<string, KnowledgeCandidate> => {
      const candidates = new Map<string, KnowledgeCandidate>();
      for (const candidate of knowledgeCandidates) {
        candidates.set(candidate.path, candidate);
      }
      for (const candidate of explicitKnowledgeCandidates.values()) {
        if (!candidates.has(candidate.path))
          candidates.set(candidate.path, candidate);
      }
      return candidates;
    };
    const buildOptions = (
      candidates: ReadonlyMap<string, KnowledgeCandidate>,
    ): SelectOption[] => {
      const result = [...candidates.values()]
        .map((candidate) => ({
          candidate,
          rank: rank(candidate.path, candidate.kind === 'directory'),
        }))
        .sort(
          (left, right) =>
            left.rank - right.rank ||
            left.candidate.path.localeCompare(right.candidate.path),
        )
        .map(({ candidate }) => {
          const explicit = candidate.origin === 'explicit-path';
          return {
            value: candidate.path,
            label:
              candidate.kind === 'directory'
                ? `Folder: ${candidate.path}${explicit ? ' (explicitly inspected)' : ' (covers supported files beneath)'}`
                : candidate.path.includes('/')
                  ? `File: ${candidate.path}${explicit ? ' (explicitly inspected)' : ''}`
                  : `Root file: ${candidate.path}${explicit ? ' (explicitly inspected)' : ''}`,
            hint: explicit
              ? candidate.kind === 'directory'
                ? 'Existing source path inspected only; no documents were enumerated or read. Empty folders are valid.'
                : 'Existing source path inspected only; init did not read its document body or copy/move it.'
              : candidate.kind === 'directory'
                ? 'Includes supported discovered documents beneath it, subject to exclusions, limits and symlink boundaries; does not promise the entire filesystem tree.'
                : candidate.path.includes('/')
                  ? 'Select this file directly; its folder is not selected implicitly.'
                  : 'Existing root file; selecting it does not copy or register it now.',
          };
        });
      for (const source of draft.knowledge.sources) {
        if (result.some((candidate) => candidate.value === source)) continue;
        result.push({
          value: source,
          label: `Retained configured: ${source} (unavailable/unverified)`,
          hint: 'Existing configured selection retained; not freshly discovered or verified. You may remove it explicitly.',
        });
      }
      result.push({
        value: addExistingKnowledgeAction,
        label: 'Add existing knowledge file or folder…',
        hint: `Inspect one workspace-relative source beneath ${context.root}; no document bodies are read`,
      });
      return result;
    };

    let sources = [...draft.knowledge.sources];
    for (;;) {
      const candidates = buildCandidateMap();
      const selected = await promptValue(
        ui.multiselect(
          `Select knowledge sources under workspace root ${context.root}`,
          buildOptions(candidates),
          sources,
        ),
        ui,
      );
      if (selected === null) return false;
      sources = [
        ...new Set(
          selected.filter((source) => source !== addExistingKnowledgeAction),
        ),
      ];
      if (!selected.includes(addExistingKnowledgeAction)) break;

      const observation = await promptExplicitPath('knowledge');
      if (observation === null) continue;
      const candidate = knowledgeCandidateFromPathObservation(observation);
      if (candidate === null) {
        ui.note(
          'The entered location did not produce a knowledge-source observation.',
          'Path not added',
        );
        continue;
      }
      const observationKey = initPathObservationKey(
        'knowledge',
        observation.path,
      );
      pathObservations.set(observationKey, observation);
      const existing = buildCandidateMap().get(candidate.path);
      if (existing !== undefined) {
        if (!sources.includes(existing.path)) sources.push(existing.path);
        ui.note(
          `${existing.path} is already an available knowledge source; it was selected without adding a duplicate.`,
          'Knowledge source already available',
        );
        continue;
      }
      explicitKnowledgeCandidates.set(candidate.path, candidate);
      knownKnowledge.add(candidate.path);
      sources.push(candidate.path);
      ui.note(
        `Added ${candidate.kind} source ${candidate.path}. It remains in place; init did not read document bodies or create, copy, move, or register documents. Empty folders are valid knowledge sources.`,
        'Knowledge source added',
      );
    }
    sources = [...new Set(sources)];
    ui.note(
      `Existing source folders cover supported discovered documents beneath them, subject to exclusions, limits and symlink boundaries. The new document destination is a workspace-relative path under ${context.root}; it is not scanned/imported and is not created here.`,
      'Knowledge sources and destination',
    );
    const newDocuments = await promptText(
      'New authored-document destination (workspace-relative; not created here)',
      draft.knowledge.newDocuments,
      'newDocuments',
    );
    if (newDocuments === null) return false;
    const visibility = await promptValue(
      ui.select(
        'Task document visibility policy (declaration only; no existing record is shared or migrated)',
        [
          {
            value: 'private',
            label: 'private',
            hint: 'Default; raw evidence and checkpoints remain private',
          },
          {
            value: 'shared',
            label: 'shared',
            hint: 'Task documents may be committed according to workspace policy',
          },
        ],
        draft.knowledge.taskVisibility,
      ),
      ui,
    );
    if (visibility === null) return false;
    draft.knowledge = {
      sources: [...sources],
      newDocuments,
      taskVisibility: visibility as 'private' | 'shared',
    };
    return true;
  };

  const editAdvanced = async (): Promise<boolean> => {
    const graph = await promptValue(
      ui.select(
        'Code graph preference (optional; no installation or indexing here)',
        [
          { value: 'none', label: 'none', hint: 'No graph provider' },
          {
            value: 'codegraph',
            label: 'codegraph',
            hint: 'Preference only; nothing is installed or indexed',
          },
        ],
        draft.code.graph,
      ),
      ui,
    );
    if (graph === null) return false;
    const symbols = await promptValue(
      ui.select(
        'Symbol provider preference (optional; no installation here)',
        [
          {
            value: 'auto',
            label: 'auto',
            hint: 'Use available existing tools',
          },
          { value: 'serena', label: 'serena', hint: 'Preference only' },
          { value: 'none', label: 'none' },
        ],
        draft.code.symbols,
      ),
      ui,
    );
    if (symbols === null) return false;
    const prepare = await promptValue(
      ui.select(
        'Index preparation preference (optional; nothing is prepared here)',
        [
          {
            value: 'on-demand',
            label: 'on-demand',
            hint: 'Prepare only when a later authorized operation asks',
          },
          {
            value: 'manual',
            label: 'manual',
            hint: 'Never prepare automatically',
          },
        ],
        draft.code.prepare,
      ),
      ui,
    );
    if (prepare === null) return false;
    const validationOptions = context.discovery.validationCandidates.map(
      (candidate) => ({
        value: candidate.id,
        label: `${candidate.id}`,
        hint: `${candidate.origin}; ${candidate.executable} ${candidate.args.join(' ')}; not executed or verified`,
      }),
    );
    for (const candidateId of draft.validation) {
      if (
        validationOptions.some((candidate) => candidate.value === candidateId)
      ) {
        continue;
      }
      validationOptions.push({
        value: candidateId,
        label: `${candidateId} (configured; not discovered)`,
        hint: 'Retained existing selection; planning fails if it cannot be bound',
      });
    }
    const selectedValidation =
      validationOptions.length === 0
        ? []
        : await promptValue(
            ui.multiselect(
              'Select validation command candidates (optional; none are executed or verified)',
              validationOptions,
              draft.validation,
            ),
            ui,
          );
    if (selectedValidation === null) return false;
    const hosts = await askHosts(ui, draft.hosts);
    if (hosts === null) return false;
    const excludesText = await promptText(
      'Workspace-relative exclude prefixes (complete seeded list; comma separated; literal prefixes only)',
      draft.excludes.join(', '),
      'excludes',
    );
    if (excludesText === null) return false;
    draft.code = {
      graph: graph as 'codegraph' | 'none',
      symbols: symbols as 'serena' | 'auto' | 'none',
      prepare: prepare as 'on-demand' | 'manual',
    };
    draft.validation = [...selectedValidation];
    draft.hosts = [...new Set(hosts)] as InitChoices['hosts'];
    draft.excludes = excludesText
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter((value) => value !== '');
    ui.note(
      'Advanced choices only record preferences. No validation command, host probe, installation, index preparation or global wiring runs here.',
      'Advanced choices',
    );
    return true;
  };

  type Section = 'workspace' | 'repositories' | 'knowledge' | 'advanced';
  const sections: readonly Section[] = [
    'workspace',
    'repositories',
    'knowledge',
    'advanced',
  ];
  const editSection = async (section: Section): Promise<boolean> => {
    if (section === 'workspace') return editWorkspace();
    if (section === 'repositories') return editRepositories();
    if (section === 'knowledge') return editKnowledge();
    return editAdvanced();
  };

  let index = 0;
  let reviewRequested = false;
  while (
    !reviewRequested &&
    index < sections.length &&
    options.reviewOnly !== true
  ) {
    const section = sections[index]!;
    if (section !== 'advanced' && !(await editSection(section))) return null;
    const last = index === sections.length - 1;
    const navigation: readonly {
      readonly value: string;
      readonly label: string;
      readonly hint: string;
    }[] =
      section === 'advanced'
        ? [
            {
              value: 'skip',
              label: 'Keep current advanced settings',
              hint: 'Retain graph/symbols/preparation/validation/hosts/excludes and continue to review',
            },
            {
              value: 'edit',
              label: 'Edit advanced preferences',
              hint: 'Explicitly edit graph, symbols, preparation, validation, hosts and excludes',
            },
            {
              value: 'back',
              label: 'Back',
              hint: 'Return to the knowledge section',
            },
            {
              value: 'cancel',
              label: 'Cancel',
              hint: 'Discard the draft; no files are written',
            },
          ]
        : [
            ...(index > 0
              ? [
                  {
                    value: 'back',
                    label: 'Back',
                    hint: 'Return to the previous setup section',
                  },
                ]
              : []),
            {
              value: 'next',
              label: last ? 'Review selections' : 'Continue',
              hint: last
                ? 'Review the draft; a detailed plan follows'
                : 'Move to the next setup section',
            },
            {
              value: 'review',
              label: 'Review selections',
              hint: 'Skip remaining setup and review retained values',
            },
            {
              value: 'cancel',
              label: 'Cancel',
              hint: 'Discard the draft; no files are written',
            },
          ];
    const action = await promptValue(
      ui.select(
        'Section navigation',
        navigation,
        section === 'advanced' ? 'skip' : 'next',
      ),
      ui,
    );
    if (action === null) return null;
    if (action === 'cancel') {
      ui.cancel('Init cancelled; no files were written.');
      return null;
    }
    if (action === 'skip') {
      reviewRequested = true;
    } else if (action === 'edit') {
      if (!(await editSection(section))) return null;
      reviewRequested = true;
    } else if (action === 'back') {
      index = Math.max(0, index - 1);
    } else if (action === 'review') {
      reviewRequested = true;
    } else {
      index += 1;
    }
  }

  const reviewSummary = (): string => {
    const unavailable = draft.knowledge.sources.map((source) =>
      knownKnowledge.has(source) ? source : `${source} (retained/unverified)`,
    );
    return `Workspace root: ${context.root}\nMode: ${
      existingConfig === null ? 'new workspace' : 'editing existing settings'
    }\nName: ${draft.name}\nRepositories (workspace policy): ${
      draft.repositories.length === 0
        ? '(none)'
        : draft.repositories
            .map((repository) => `${repository.path}=${repository.access}`)
            .join(', ')
    }\nKnowledge sources (discover/register in place): ${
      unavailable.length === 0 ? '(none)' : unavailable.join(', ')
    }\nNew document destination (future authored documents only): ${draft.knowledge.newDocuments}\nDocument policy: ${draft.knowledge.taskVisibility} (raw evidence/checkpoints remain private)\nAdvanced: graph=${draft.code.graph}, symbols=${draft.code.symbols}, prepare=${draft.code.prepare}, validation=${draft.validation.length === 0 ? '(none)' : draft.validation.join(', ')}, hosts=${draft.hosts.length === 0 ? '(none)' : draft.hosts.join(', ')}, excludes=${draft.excludes.length === 0 ? '(none)' : draft.excludes.join(', ')}\nThis is a read-only draft. A detailed file/runtime plan and final apply confirmation follow; review does not authorize writes.`;
  };

  while (true) {
    ui.note(reviewSummary(), 'Review selections');
    const action = await promptValue(
      ui.select(
        'Edit a section or continue to the detailed plan',
        [
          { value: 'continue', label: 'Continue to plan' },
          { value: 'workspace', label: 'Edit workspace name' },
          { value: 'repositories', label: 'Edit repositories' },
          { value: 'knowledge', label: 'Edit knowledge sources/destination' },
          { value: 'advanced', label: 'Edit advanced settings' },
          { value: 'cancel', label: 'Cancel' },
        ],
        'continue',
      ),
      ui,
    );
    if (action === null) return null;
    if (action === 'cancel') {
      ui.cancel('Init cancelled; no files were written.');
      return null;
    }
    if (action === 'continue') {
      collectedPathObservations.set(draft, [...pathObservations.values()]);
      ui.outro('Selections complete. Review the plan before applying.');
      return draft;
    }
    if (!(await editSection(action as Section))) return null;
  }
  collectedPathObservations.set(draft, [...pathObservations.values()]);
  ui.outro('Selections complete. Review the plan before applying.');
  return draft;
}
export interface InitCommandOptions {
  readonly cwd: string;
  readonly configPath: string | null;
  readonly apply: boolean;
  readonly json: boolean;
  readonly installRuntime?: boolean;
  readonly runtimeTarball?: string | null;
  readonly runtimeVersion?: string | null;
  /** Derives deterministic selections from discovery instead of prompting. */
  readonly yes?: boolean;
  /** Prints the derived selections and writes nothing. */
  readonly printChoices?: boolean;
  /** Leaves the runtime action pending instead of installing a durable copy. */
  readonly noRuntime?: boolean;
  /** Rebuilds workspace.json from the selections even when a valid config exists. */
  readonly reconfigure?: boolean;
}

export interface InitRuntimeOperationDescription {
  readonly mode: 'default-self' | 'tarball' | 'version' | 'disabled';
  readonly runtimeRequested: boolean;
  readonly targetVersion: string;
  readonly source: string | null;
  readonly runtimeRoot: string | null;
  readonly machineBindingPath: string;
  readonly previewLines: readonly string[];
  readonly confirmationMessage: string;
}

/** Describes the runtime work this invocation would perform without touching it. */
export function describeInitRuntimeOperation(
  options: InitCommandOptions,
  bundle: InitPlanBundle,
  dataDir?: string,
): InitRuntimeOperationDescription {
  const targetVersion = bundle.scope.runtimeVersion;
  const runtimeRoot = runtimePaths(targetVersion, dataDir).runtimeRoot;
  const machineBindingPath = join(
    bundle.scope.workspaceRoot,
    '.pappra',
    'local',
    'machine.json',
  );
  const packageInfo = getPackageInfo();

  if (options.installRuntime === true) {
    const tarball = options.runtimeTarball ?? null;
    const sourceVersion = options.runtimeVersion ?? targetVersion;
    const versionMismatch = sourceVersion !== targetVersion;
    const source =
      tarball === null
        ? `${packageInfo.name}@${sourceVersion}`
        : `tarball ${resolve(options.cwd, tarball)} for ${packageInfo.name}@${sourceVersion}`;
    const sourceKind = tarball === null ? 'version' : 'tarball';
    const previewLines = [
      `Explicit ${sourceKind} source: ${source}.`,
      `Workspace target: ${targetVersion} at ${runtimeRoot}.`,
      `Machine runtime binding: ${machineBindingPath}.`,
      versionMismatch
        ? `The requested version ${sourceVersion} does not match the workspace target; after config apply the runtime request will be rejected before installation.`
        : 'On apply, run the package manager and existing runtime verification before recording the machine binding; dependency resolution may require network access.',
      'This preview does not install, pack, probe or write runtime state.',
    ];
    const confirmationMessage = versionMismatch
      ? `Apply the planned workspace files? The runtime request ${source} does not match workspace target ${targetVersion} and will fail before installation.`
      : `Apply the planned workspace files, then install/verify ${source} at ${runtimeRoot} and bind it in ${machineBindingPath}? Package-manager work may require network access; optional preferences remain deferred.`;
    return {
      mode: sourceKind,
      runtimeRequested: true,
      targetVersion,
      source,
      runtimeRoot,
      machineBindingPath,
      previewLines,
      confirmationMessage,
    };
  }

  if (options.noRuntime === true) {
    return {
      mode: 'disabled',
      runtimeRequested: false,
      targetVersion,
      source: null,
      runtimeRoot: null,
      machineBindingPath,
      previewLines: [
        'No runtime installation, verification or binding operation will run (--no-runtime).',
        'The planned workspace/machine configuration files may still be applied; existing runtime files are not written or bound by this invocation.',
      ],
      confirmationMessage:
        'Apply the planned workspace/machine configuration files only? No runtime operation will run (--no-runtime); knowledge registration, code indexing/preparation and host integration remain deferred.',
    };
  }

  const source = `current package ${packageInfo.name}@${packageInfo.version} at ${getPackageRoot()}`;
  const versionMismatch = packageInfo.version !== targetVersion;
  const previewLines = [
    `Default self-package source: ${source}.`,
    `Workspace target: ${targetVersion} at ${runtimeRoot}.`,
    `Machine runtime binding: ${machineBindingPath}.`,
    versionMismatch
      ? `The current package version ${packageInfo.version} differs from workspace target ${targetVersion}. A verified runtime for this workspace target may still be reused. If no verified runtime can be reused, the current package source cannot satisfy this target and runtime setup will fail after config apply.`
      : 'On apply, first verify/reuse an existing runtime for the workspace target. Reuse occurs only if the manifest, package contents, executable and smoke check pass; otherwise the current package may be packed and installed.',
    'This preview does not pack, install, run smoke/version probes or write user-data state; it cannot promise reuse.',
  ];
  const confirmationMessage = versionMismatch
    ? `Apply the planned workspace files, then first verify/reuse a runtime for the workspace target ${targetVersion} at ${runtimeRoot} and bind it in ${machineBindingPath}? A previously installed verified target runtime may still be reused. If no verified target runtime is reusable, the current package cannot satisfy this target; runtime setup will fail after config apply. Knowledge registration, code indexing/preparation and host integration remain deferred.`
    : `Apply the planned workspace files, then verify/reuse a runtime for the workspace target ${targetVersion} at ${runtimeRoot}, or install ${source} if needed, and bind it in ${machineBindingPath}? Reuse requires the manifest, package contents, executable and smoke check to pass; package-manager and smoke-verification work may run. Knowledge registration, code indexing/preparation and host integration remain deferred.`;
  return {
    mode: 'default-self',
    runtimeRequested: true,
    targetVersion,
    source,
    runtimeRoot,
    machineBindingPath,
    previewLines,
    confirmationMessage,
  };
}

function runtimeOptionsFailure(
  message: string,
  nextAction: string,
): InitFailure {
  return {
    ok: false,
    status: 'invalid',
    code: diagnosticCodes.initRuntimeSourceRequired,
    message,
    diagnostics: [],
    nextAction,
  };
}

async function installAndRecordRuntime(
  root: string,
  targetVersion: string,
  options: InitCommandOptions,
): Promise<RuntimeFlowResult> {
  const tarball = options.runtimeTarball ?? null;
  const requestedVersion = options.runtimeVersion ?? null;
  if (tarball !== null && requestedVersion !== null) {
    return {
      ok: false,
      completion: false,
      runtime: null,
      diagnostics: [
        {
          code: diagnosticCodes.initRuntimeSourceRequired,
          severity: 'error',
          message:
            'Use either --runtime-tarball or --runtime-version, not both.',
          source: 'init runtime',
          pointer: null,
          hint: 'Choose one explicit runtime source.',
        },
      ],
    };
  }
  if (tarball === null && requestedVersion === null) {
    return {
      ok: false,
      completion: false,
      runtime: null,
      diagnostics: [
        {
          code: diagnosticCodes.initRuntimeSourceRequired,
          severity: 'error',
          message: 'Installing the runtime requires an explicit source.',
          source: 'init runtime',
          pointer: null,
          hint: 'Pass --runtime-tarball <path> or --runtime-version <exact-version>; Pappra does not assume the package is published.',
        },
      ],
    };
  }
  const version = requestedVersion ?? targetVersion;
  if (version !== targetVersion) {
    return {
      ok: false,
      completion: false,
      runtime: null,
      diagnostics: [
        {
          code: diagnosticCodes.initRuntimeSourceRequired,
          severity: 'error',
          message: `Runtime version ${version} does not match workspace target ${targetVersion}.`,
          source: 'init runtime',
          pointer: null,
          hint: 'Use the exact runtimeVersion recorded in the workspace config.',
        },
      ],
    };
  }
  const source =
    tarball === null
      ? ({ kind: 'version' } as const)
      : ({ kind: 'tarball', path: resolve(options.cwd, tarball) } as const);
  const installed = await installRuntime({
    version,
    source,
    packageName: getPackageInfo().name,
    ...(tarball === null ? {} : { offline: false }),
  });
  if (!installed.ok || installed.manifest === null) {
    return {
      ok: false,
      completion: false,
      runtime: installed,
      diagnostics: installed.diagnostics,
    };
  }
  return bindAndRecordRuntime(root, installed);
}

export interface InitCommandDeps {
  readonly ui?: WizardUi;
  readonly progress?: ProgressUi;
  readonly interactive?: boolean;
  /** The caller already printed its own intro for this guided run. */
  readonly introShown?: boolean;
}

function formatFailure(failure: InitFailure): number {
  switch (failure.status) {
    case 'invalid':
      return 2;
    case 'unavailable':
      return 3;
    case 'needs_input':
    case 'conflict':
      return 1;
  }
}

function writeFailure(
  output: CliOutput,
  options: InitCommandOptions,
  failure: InitFailure,
): number {
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        ok: false,
        command: 'init',
        status: failure.status,
        code: failure.code,
        message: failure.message,
        nextAction: failure.nextAction,
        diagnostics: failure.diagnostics,
        ...(failure.details ?? {}),
      })}\n`,
    );
  } else {
    output.stderr(`pappra init: ${failure.message}\n`);
    for (const diagnostic of failure.diagnostics) {
      output.stderr(
        `  ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`,
      );
    }
    if (failure.nextAction !== null) {
      output.stderr(`  next: ${failure.nextAction}\n`);
    }
  }
  return formatFailure(failure);
}

async function loadChoices(
  configPath: string,
): Promise<
  | { readonly ok: true; readonly choices: InitChoices }
  | { readonly ok: false; readonly failure: InitFailure }
> {
  const read = await readTextFileBounded(configPath);
  if (!read.ok) {
    return {
      ok: false,
      failure: {
        ok: false,
        status: 'unavailable',
        code: read.code,
        message: read.message,
        diagnostics: [],
        nextAction: read.nextAction,
      },
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.value.text);
  } catch (error) {
    return {
      ok: false,
      failure: {
        ok: false,
        status: 'invalid',
        code: diagnosticCodes.initInvalidInput,
        message: `Invalid init config JSON: ${error instanceof Error ? error.message : String(error)}`,
        diagnostics: [],
        nextAction: 'Fix the JSON and retry; no target files were written.',
      },
    };
  }
  const parsed = parseInitChoices(raw, configPath);
  if (parsed.value === null) {
    return {
      ok: false,
      failure: {
        ok: false,
        status: 'invalid',
        code: parsed.diagnostics[0]?.code ?? diagnosticCodes.initInvalidInput,
        message:
          parsed.diagnostics[0]?.message ??
          'Init config does not match pappra/init-choices/1.',
        diagnostics: parsed.diagnostics,
        nextAction:
          'Correct the init selections; no target files were written.',
      },
    };
  }
  return { ok: true, choices: parsed.value };
}

function diagnosticLines(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map(
      (entry) =>
        `  ${entry.severity} ${entry.code}: ${entry.message}${entry.hint === null ? '' : ` (${entry.hint})`}`,
    )
    .join('\n');
}

function deferredInitWork(bundle: InitPlanBundle): readonly string[] {
  const knowledge =
    bundle.scope.knowledge.sources.length === 0
      ? 'No knowledge documents are registered by init.'
      : 'Knowledge sources are recorded in workspace settings only; init does not scan or register catalog entries.';
  const code = `Code preferences (graph=${bundle.scope.code.graph}, symbols=${bundle.scope.code.symbols}, prepare=${bundle.scope.code.prepare}) are declarations only; init does not install, index or prepare tools.`;
  const validation =
    bundle.scope.validation.length === 0
      ? 'No validation command is executed by init.'
      : 'Selected validation commands are recorded only; init does not execute them.';
  const hosts =
    bundle.scope.hosts.length === 0
      ? 'No host is declared; init does not detect, install or wire hosts.'
      : `Host declarations (${bundle.scope.hosts.join(', ')}) are not probed, installed or wired by init.`;
  return [
    knowledge,
    'The new-document destination is for future authored documents and is not created by init.',
    code,
    validation,
    hosts,
  ];
}

function printPlan(
  output: CliOutput,
  bundle: InitPlanBundle,
  runtimeOperation: InitRuntimeOperationDescription,
  followUps: boolean,
): void {
  output.stdout(`Pappra init plan ${bundle.plan.planId}\n`);
  output.stdout(`Workspace: ${bundle.plan.workspaceRoot}\n`);
  output.stdout(`Config source: ${bundle.scope.configSource}\n`);
  output.stdout(
    `Repositories: ${bundle.scope.repositories.length === 0 ? '(none)' : bundle.scope.repositories.map((repository) => `${repository.id}:${repository.path}:${repository.access}`).join(', ')}\n`,
  );
  output.stdout(
    `Knowledge sources: ${bundle.scope.knowledge.sources.length === 0 ? '(none)' : bundle.scope.knowledge.sources.join(', ')}\n`,
  );
  output.stdout(
    `Validation candidates: ${bundle.scope.validation.length === 0 ? '(none)' : bundle.scope.validation.map((entry) => entry.id).join(', ')}\n`,
  );
  output.stdout(
    `Hosts: ${bundle.scope.hosts.length === 0 ? '(none)' : bundle.scope.hosts.join(', ')}\n`,
  );
  output.stdout('Files:\n');
  for (const file of bundle.plan.files) {
    output.stdout(
      `  ${file.operation} ${file.path} before=${file.expectedBeforeDigest ?? 'absent'} after=${file.nextDigest}\n`,
    );
  }
  const externalActions =
    runtimeOperation.mode === 'disabled'
      ? bundle.plan.externalActions.filter(
          (action) => action.kind !== 'install-runtime',
        )
      : bundle.plan.externalActions;
  output.stdout('Plan external actions (not executed during planning):\n');
  if (externalActions.length === 0) {
    output.stdout('  (none)\n');
  } else {
    for (const action of externalActions) {
      output.stdout(
        `  ${action.kind} ${action.target}${action.version === null ? '' : `@${action.version}`}\n`,
      );
    }
  }
  if (
    runtimeOperation.mode === 'disabled' &&
    bundle.plan.externalActions.some(
      (action) => action.kind === 'install-runtime',
    )
  ) {
    output.stdout(
      '  install-runtime is suppressed by --no-runtime for this invocation.\n',
    );
  }
  output.stdout('\nRuntime operation:\n');
  for (const line of runtimeOperation.previewLines) {
    output.stdout(`  ${line}\n`);
  }
  if (followUps) {
    output.stdout(
      'After applying, Pappra offers the optional setup steps (code index, documents, coding agents, health check).\n',
    );
  } else {
    output.stdout('Deferred init work:\n');
    for (const line of deferredInitWork(bundle)) {
      output.stdout(`  ${line}\n`);
    }
  }
  if (bundle.diagnostics.length > 0) {
    output.stderr(`${diagnosticLines(bundle.diagnostics)}\n`);
  }
  if (bundle.plan.files.length > 0) {
    output.stdout('\nDiff:\n');
    for (const write of bundle.writes) output.stdout(write.diff);
  } else {
    output.stdout('No file changes are planned.\n');
  }
}

function printApply(
  output: CliOutput,
  result: InitApplyResult,
  runtimeOperation: InitRuntimeOperationDescription,
): void {
  if (!result.ok) {
    output.stderr(`pappra init apply: ${result.status}\n`);
    output.stderr(`${diagnosticLines(result.diagnostics)}\n`);
    return;
  }
  output.stdout(
    `Applied files: ${result.appliedFiles.length === 0 ? '(none)' : result.appliedFiles.join(', ')}\n`,
  );
  output.stdout(`Status: ${result.status}\n`);
  if (result.residualPaths.length > 0) {
    output.stderr(
      `Residual planned files require manual inspection: ${result.residualPaths.join(', ')}\n`,
    );
  }
  if (result.pendingExternalActions.length > 0) {
    output.stderr('Pending plan actions after the file-apply phase:\n');
    for (const action of result.pendingExternalActions) {
      output.stderr(
        `  ${action.kind} ${action.target}${action.version === null ? '' : `@${action.version}`}\n`,
      );
    }
  }
  output.stdout(
    runtimeOperation.mode === 'disabled'
      ? 'Runtime operation: intentionally deferred by --no-runtime; none was run.\n'
      : 'Runtime operation: scheduled after file application for verification/reuse or installation and machine binding.\n',
  );
}

function workspaceApplySummary(
  bundle: InitPlanBundle,
  result: InitApplyResult,
): string {
  if (result.appliedFiles.includes('.pappra/workspace.json')) {
    return 'Workspace configuration applied.';
  }
  return bundle.scope.configSource === 'existing'
    ? 'Existing workspace configuration reused.'
    : 'Workspace configuration unchanged.';
}

function advisoryNextActions(bundle: InitPlanBundle): readonly string[] {
  const actions: string[] = [];
  const repositoryId = bundle.scope.repositories[0]?.id;
  if (
    bundle.scope.code.graph !== 'none' &&
    bundle.scope.repositories.length > 0 &&
    repositoryId !== undefined
  ) {
    actions.push(
      `pappra code prepare --repo ${repositoryId} --apply   # register the ${bundle.scope.code.graph} index for this checkout`,
    );
  }
  if (bundle.scope.knowledge.sources.length > 0) {
    actions.push(
      'pappra docs scan --apply   # register discovered knowledge documents in the catalog',
    );
  }
  return actions;
}

function initNextActions(
  bundle: InitPlanBundle,
  runtimeOperation: InitRuntimeOperationDescription,
): readonly string[] {
  const actions = [...advisoryNextActions(bundle)];
  if (runtimeOperation.mode === 'disabled') {
    actions.unshift(
      'Runtime operation was intentionally deferred by --no-runtime; rerun init --apply without --no-runtime to verify/reuse or install and bind the runtime.',
    );
  }
  return actions;
}

function planJson(
  bundle: InitPlanBundle,
  runtimeOperation: InitRuntimeOperationDescription,
): Record<string, unknown> {
  return {
    command: 'init',
    mode: 'plan',
    plan: bundle.plan,
    scope: bundle.scope,
    nextActions: initNextActions(bundle, runtimeOperation),
    diagnostics: bundle.diagnostics,
  };
}

/**
 * CLI command entry. In JSON mode no prompt is ever opened and stdout contains
 * exactly one JSON document. Interactive selection is injected for tests.
 */
export async function runInitCommand(
  options: InitCommandOptions,
  output: CliOutput,
  deps: InitCommandDeps = {},
): Promise<number> {
  const ui = deps.ui ?? clackWizardUi;
  const progress = deps.progress ?? clackProgress();
  const yes = options.yes === true;
  const printChoices = options.printChoices === true;
  const interactive =
    !options.json &&
    !yes &&
    !printChoices &&
    options.configPath === null &&
    (deps.interactive ??
      (process.stdin.isTTY === true && process.stdout.isTTY === true));
  const wantsRuntime = options.installRuntime === true;
  const hasRuntimeSource =
    (options.runtimeTarball !== null && options.runtimeTarball !== undefined) ||
    (options.runtimeVersion !== null && options.runtimeVersion !== undefined);
  if (!wantsRuntime && hasRuntimeSource) {
    return writeFailure(
      output,
      options,
      runtimeOptionsFailure(
        '--runtime-tarball/--runtime-version require --install-runtime.',
        'Remove the runtime source flags or add --install-runtime (and --apply).',
      ),
    );
  }
  if (wantsRuntime && !options.apply) {
    return writeFailure(
      output,
      options,
      runtimeOptionsFailure(
        '--install-runtime requires --apply.',
        'Plan and preview first, then rerun with --apply and an explicit runtime source.',
      ),
    );
  }
  if (wantsRuntime && !hasRuntimeSource) {
    return writeFailure(
      output,
      options,
      runtimeOptionsFailure(
        'Installing the runtime requires an explicit source.',
        'Pass --runtime-tarball <path> or --runtime-version <exact-version>; Pappra does not assume the package is published.',
      ),
    );
  }
  if (
    options.runtimeTarball !== null &&
    options.runtimeTarball !== undefined &&
    options.runtimeVersion !== null &&
    options.runtimeVersion !== undefined
  ) {
    return writeFailure(
      output,
      options,
      runtimeOptionsFailure(
        'Use either --runtime-tarball or --runtime-version, not both.',
        'Choose one explicit runtime source.',
      ),
    );
  }
  if (
    printChoices &&
    (options.configPath !== null ||
      options.apply ||
      wantsRuntime ||
      hasRuntimeSource)
  ) {
    return writeFailure(output, options, {
      ok: false,
      status: 'invalid',
      code: diagnosticCodes.initInvalidInput,
      message:
        '--print-choices cannot be combined with --config, --apply, or runtime flags.',
      diagnostics: [],
      nextAction:
        'Run pappra init --print-choices on its own to print the derived selections.',
    });
  }
  if (yes && options.configPath !== null) {
    return writeFailure(output, options, {
      ok: false,
      status: 'invalid',
      code: diagnosticCodes.initInvalidInput,
      message: 'Use either --config or --yes, not both.',
      diagnostics: [],
      nextAction:
        'Pass explicit selections with --config, or derive them with --yes.',
    });
  }
  const contextResult = await inspectInitContext(options.cwd);
  if (!contextResult.ok) {
    return writeFailure(output, options, contextResult);
  }
  const context = contextResult.context;
  const recoverablePlanCodes = new Set<string>([
    diagnosticCodes.initValidationUnbound,
    diagnosticCodes.initValidationUnknown,
    diagnosticCodes.initKnowledgeUnknown,
    diagnosticCodes.initRepositoryUnknown,
    diagnosticCodes.initRepositoryDuplicate,
  ]);
  let choices: InitChoices | null = null;

  if (printChoices) {
    const existingConfig = context.workspaceInspection.value;
    if (options.reconfigure === true && existingConfig === null) {
      return writeFailure(output, options, {
        ok: false,
        status: 'needs_input',
        code: diagnosticCodes.initInputRequired,
        message:
          'Reconfiguration requires an existing valid workspace configuration.',
        diagnostics: context.diagnostics,
        nextAction:
          'Run pappra init without --reconfigure to create a workspace, or repair the existing workspace configuration first.',
      });
    }
    if (options.reconfigure === true && existingConfig !== null) {
      const existing = existingInitChoices(
        existingConfig,
        context.machineInspection.value,
      );
      const rules = [
        {
          field: 'source',
          value: 'existing workspace.json/machine.json',
          reason:
            'reconfiguration edits current represented selections; extensions and continuity are preserved by planning',
        },
      ];
      const candidates = {
        repositories: listRepositoryCandidates(context.discovery).map(
          (candidate) => candidate.key,
        ),
        knowledge: listKnowledgeCandidates(context.discovery).map(
          (candidate) => candidate.path,
        ),
        validation: context.discovery.validationCandidates.map(
          (candidate) => candidate.id,
        ),
        hosts: existing.hosts,
      };
      if (options.json) {
        output.stdout(
          `${JSON.stringify({
            ok: true,
            command: 'init',
            mode: 'choices',
            choices: existing,
            rules,
            candidates,
          })}\n`,
        );
      } else {
        output.stdout(`${JSON.stringify(existing, null, 2)}\n`);
        for (const rule of rules) {
          output.stderr(`  ${rule.field} = ${rule.value} (${rule.reason})\n`);
        }
      }
      return 0;
    }
    const derived = await deriveInitChoices(context.discovery);
    if (options.json) {
      output.stdout(
        `${JSON.stringify({
          ok: true,
          command: 'init',
          mode: 'choices',
          choices: derived.choices,
          rules: derived.rules,
          candidates: derived.candidates,
        })}\n`,
      );
    } else {
      output.stdout(`${JSON.stringify(derived.choices, null, 2)}\n`);
      for (const rule of derived.rules) {
        output.stderr(`  ${rule.field} = ${rule.value} (${rule.reason})\n`);
      }
    }
    return 0;
  }

  if (options.configPath !== null) {
    const loaded = await loadChoices(options.configPath);
    if (!loaded.ok) return writeFailure(output, options, loaded.failure);
    choices = loaded.choices;
  } else if (yes) {
    if (options.reconfigure === true) {
      const existingConfig = context.workspaceInspection.value;
      if (existingConfig === null) {
        return writeFailure(output, options, {
          ok: false,
          status: 'needs_input',
          code: diagnosticCodes.initInputRequired,
          message:
            'Reconfiguration requires an existing valid workspace configuration.',
          diagnostics: context.diagnostics,
          nextAction:
            'Run pappra init without --reconfigure to create a workspace, or repair the existing workspace configuration first.',
        });
      }
      choices = existingInitChoices(
        existingConfig,
        context.machineInspection.value,
      );
    } else {
      choices = (await deriveInitChoices(context.discovery)).choices;
    }
  } else {
    const needsChoices =
      options.reconfigure === true ||
      context.discovery.configState !== 'valid' ||
      context.discovery.machineState !== 'valid';
    if (needsChoices && !interactive) {
      const existingConfig = context.workspaceInspection.value;
      const suggested =
        options.reconfigure === true && existingConfig !== null
          ? existingInitChoices(existingConfig, context.machineInspection.value)
          : (await deriveInitChoices(context.discovery)).choices;
      const candidates = {
        repositories: listRepositoryCandidates(context.discovery).map(
          (candidate) => candidate.key,
        ),
        knowledge: listKnowledgeCandidates(context.discovery).map(
          (candidate) => candidate.path,
        ),
        validation: context.discovery.validationCandidates.map(
          (candidate) => candidate.id,
        ),
        hosts: suggested.hosts,
      };
      return writeFailure(output, options, {
        ok: false,
        status: 'needs_input',
        code: diagnosticCodes.initNoTty,
        message:
          options.reconfigure === true
            ? 'Reconfiguration requires editing existing selections in a non-interactive session.'
            : 'Missing init selections in a non-interactive session.',
        diagnostics: context.diagnostics,
        nextAction:
          options.reconfigure === true
            ? 'Rerun with --print-choices --reconfigure to inspect current selections, --yes --reconfigure --apply to keep them, --config with pappra/init-choices/1 and --reconfigure for explicit edits, or use a TTY for the wizard.'
            : 'Rerun with --print-choices to inspect derived selections, --yes --apply to write them, --config with pappra/init-choices/1, or use a TTY for the wizard.',
        details: {
          candidates,
          suggestedChoices: suggested,
          rules: [],
        },
      });
    }
    if (needsChoices && interactive) {
      choices = await collectInitChoices(context, deps.ui ?? clackWizardUi, {
        ...(options.reconfigure === true ? { reconfigure: true } : {}),
        introShown: deps.introShown === true,
      });
      if (choices === null) {
        output.stderr('Init cancelled; no files were written.\n');
        return 130;
      }
    }
  }

  let prepared = await planWorkspaceInit({
    root: context.root,
    choices,
    context,
    pathObservations:
      choices === null ? [] : (collectedPathObservations.get(choices) ?? []),
    ...(options.reconfigure === true ? { reconfigure: true } : {}),
  });
  const recoverableChoiceError =
    !prepared.ok &&
    interactive &&
    choices !== null &&
    prepared.diagnostics.some(
      (entry) =>
        entry.severity === 'error' && recoverablePlanCodes.has(entry.code),
    );
  if (recoverableChoiceError && prepared.ok === false) {
    const recoverable = prepared;
    const retained = choices;
    output.stderr(
      `pappra init: ${recoverable.message}\n${diagnosticLines(recoverable.diagnostics)}\n`,
    );
    output.stderr(
      '  next: Return to the editor to correct the reported selections, or cancel; no files were written.\n',
    );
    const correction = await collectInitChoices(
      context,
      deps.ui ?? clackWizardUi,
      {
        ...(options.reconfigure === true ? { reconfigure: true } : {}),
        ...(retained === null ? {} : { draft: retained }),
        reviewOnly: true,
        pathObservations:
          retained === null
            ? []
            : (collectedPathObservations.get(retained) ?? []),
        introShown: deps.introShown === true,
      },
    );
    if (correction === null) {
      output.stderr('Init cancelled; no files were written.\n');
      return 130;
    }
    if (
      retained !== null &&
      JSON.stringify(correction) === JSON.stringify(retained)
    ) {
      return formatFailure(recoverable);
    }
    choices = correction;
    prepared = await planWorkspaceInit({
      root: context.root,
      choices,
      context,
      pathObservations: collectedPathObservations.get(correction) ?? [],
      ...(options.reconfigure === true ? { reconfigure: true } : {}),
    });
    if (!prepared.ok) return writeFailure(output, options, prepared);
  }
  if (!prepared.ok) return writeFailure(output, options, prepared);
  const bundle = prepared.bundle;
  const runtimeOperation = describeInitRuntimeOperation(options, bundle);

  if (options.json) {
    if (!options.apply) {
      output.stdout(
        `${JSON.stringify({
          ok: true,
          ...planJson(bundle, runtimeOperation),
        })}\n`,
      );
      return 0;
    }
    const applied = await applyInitPlan(bundle);
    const runtimeRequested = runtimeOperation.runtimeRequested;
    const runtimeFlow =
      runtimeRequested && applied.ok && applied.residualPaths.length === 0
        ? wantsRuntime
          ? await installAndRecordRuntime(
              bundle.scope.workspaceRoot,
              bundle.scope.runtimeVersion,
              options,
            )
          : await ensureDefaultRuntime(
              bundle.scope.workspaceRoot,
              bundle.scope.runtimeVersion,
            )
        : null;
    const initComplete = runtimeFlow?.completion === true;
    const ok =
      applied.ok &&
      applied.residualPaths.length === 0 &&
      (!runtimeRequested || (runtimeFlow?.ok === true && initComplete));
    output.stdout(
      `${JSON.stringify({
        ok,
        command: 'init',
        mode: 'apply',
        plan: bundle.plan,
        scope: bundle.scope,
        apply: applied,
        runtime: runtimeFlow?.runtime ?? null,
        initComplete,
        nextActions: initNextActions(bundle, runtimeOperation),
        diagnostics: [
          ...bundle.diagnostics,
          ...(runtimeFlow?.diagnostics ?? []),
        ],
      })}\n`,
    );
    if (!applied.ok) return applied.status === 'failed' ? 3 : 1;
    if (applied.residualPaths.length > 0) return 1;
    if (runtimeRequested) return ok ? 0 : 1;
    return 0;
  }

  printPlan(output, bundle, runtimeOperation, interactive && !options.apply);
  if (!options.apply) {
    if (!interactive || bundle.plan.files.length === 0) {
      output.stdout(
        runtimeOperation.runtimeRequested
          ? 'Plan only; no files or runtime operations were performed. Re-run with --apply to apply files and attempt the described runtime operation, even if no files change.\n'
          : 'Plan only; no files or runtime operations were performed. Re-run with --apply to apply files; --no-runtime will continue to suppress runtime work.\n',
      );
      return 0;
    }
    if (!(await confirmApply(ui, 'Apply these workspace changes?', true))) {
      output.stdout('Nothing was applied.\n');
      return 0;
    }
  }
  const applied = await applyInitPlan(bundle);
  printApply(output, applied, runtimeOperation);
  if (!applied.ok) {
    return applied.status === 'failed' ? 3 : 1;
  }
  if (applied.residualPaths.length > 0) {
    output.stderr(
      'Managed apply state is not final; runtime actions will not be attempted.\n',
    );
    return 1;
  }
  output.stdout(`${workspaceApplySummary(bundle, applied)}\n`);
  if (!runtimeOperation.runtimeRequested) {
    if (interactive && !options.apply) {
      return await runSetupFollowUps(
        bundle.scope.workspaceRoot,
        ui,
        progress,
        output,
      );
    }
    for (const line of deferredInitWork(bundle)) output.stdout(`  ${line}\n`);
    for (const action of initNextActions(bundle, runtimeOperation)) {
      output.stdout(`  next: ${action}\n`);
    }
    return 0;
  }

  const runtimeFlow = wantsRuntime
    ? await installAndRecordRuntime(
        bundle.scope.workspaceRoot,
        bundle.scope.runtimeVersion,
        options,
      )
    : await ensureDefaultRuntime(
        bundle.scope.workspaceRoot,
        bundle.scope.runtimeVersion,
      );
  const runtime = runtimeFlow.runtime;
  if (runtime !== null) {
    output.stdout(
      `Runtime operation result: ${runtime.status} ${runtime.version}${
        runtime.runtimeRoot === null ? '' : ` at ${runtime.runtimeRoot}`
      }\n`,
    );
    if (runtime.residualPaths.length > 0) {
      output.stderr(
        `Runtime residual paths: ${runtime.residualPaths.join(', ')}\n`,
      );
    }
  }
  if (!runtimeFlow.ok || !runtimeFlow.completion) {
    if (runtimeFlow.diagnostics.length > 0) {
      output.stderr(`${diagnosticLines(runtimeFlow.diagnostics)}\n`);
    }
    output.stderr(
      'Runtime verification/installation or machine binding did not complete. The workspace configuration state reported above remains in place; initialization is incomplete and no rollback was attempted.\n',
    );
    for (const line of deferredInitWork(bundle)) output.stdout(`  ${line}\n`);
    return 1;
  }
  output.stdout(
    runtime?.status === 'reused'
      ? 'Existing runtime was verified, reused and bound. Initialization complete.\n'
      : 'Runtime was installed, verified and bound. Initialization complete.\n',
  );
  if (interactive && !options.apply) {
    return await runSetupFollowUps(
      bundle.scope.workspaceRoot,
      ui,
      progress,
      output,
    );
  }
  for (const line of deferredInitWork(bundle)) output.stdout(`  ${line}\n`);
  for (const action of initNextActions(bundle, runtimeOperation)) {
    output.stdout(`  next: ${action}\n`);
  }
  return 0;
}

export const initUsage =
  'pappra init [--config <file> | --yes | --no-interactive] [--print-choices]\n' +
  '             [--apply] [--json] [--reconfigure] [--no-runtime]\n' +
  '             [--install-runtime (--runtime-tarball <file> | --runtime-version <version>)]\n\n' +
  'Without --config or --yes, a TTY opens the wizard when selections are still needed: a valid\n' +
  'existing configuration is reused (only missing local state is requested) and --reconfigure\n' +
  'opens the editor. --config reads a pappra/init-choices/1 document and stays preview-only\n' +
  'without --apply, even on a TTY. --yes and --no-interactive derive selections from discovery.\n' +
  'Planning and preview never write. --apply creates planned files through a managed journal.\n' +
  '--print-choices prints the selections and writes nothing; with --reconfigure it prints the\n' +
  'current represented choices instead of newly derived ones, and --yes --reconfigure keeps\n' +
  'those current choices rather than deriving them again.\n' +
  '--reconfigure is the explicit opt-in that rewrites an existing valid workspace.json from the\n' +
  'current selections (identity, extensions, continuity and custom validation bindings are kept).\n' +
  'Without --reconfigure an existing valid configuration is reused and never overwritten.\n' +
  '--install-runtime installs one explicit exact version or local tarball; provider/index/global\n' +
  'wiring remain separate pending actions.\n' +
  '--no-runtime suppresses runtime verification, installation and binding for this invocation.\n' +
  'When a runtime action is still required the result is ok:true with status\n' +
  'external-actions-pending and exit 0 for the requested configuration-only work; when the workspace already has a bound matching\n' +
  'runtime and no file changes are needed the result is ok:true, apply status no-changes and\n' +
  'exit 0, while initComplete stays false because this invocation verified no runtime.\n' +
  'A TTY run that collected selections without --apply prints the plan and asks one confirmation\n' +
  'when config writes are planned; declining writes nothing. --config previews and empty plans\n' +
  'do not prompt, and --apply never prompts.\n';
