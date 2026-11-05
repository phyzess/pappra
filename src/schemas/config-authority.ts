import { z } from 'zod';
import { MACHINE_SCHEMA, machineConfigSchema } from './machine.js';
import { WORKSPACE_SCHEMA, workspaceConfigSchema } from './workspace.js';

/**
 * Field-level authority classification for the two configuration layers.
 *
 * The committed layer (`.pappra/workspace.json`) is shared through version
 * control: every agent or contributor that can edit a file can propose a value
 * there. The private layer (`.pappra/local/machine.json`) is written per
 * checkout and is not shared. This table records, per schema field, what the
 * value *is* and what must still be true before it can have an effect, so that
 * a shared declaration is never mistaken for an authorization.
 *
 * The table is pinned to the actual schemas: `inspectConfigAuthority()` walks
 * the zod shapes and reports any field without a classification. Adding a
 * field to either schema therefore fails `tests/workspace/config-authority`
 * until it is classified here.
 */

export type ConfigLayer = 'shared' | 'private';

/**
 * What the value names. `descriptive` and `open-container` carry no authority;
 * the other four kinds are authority-bearing.
 */
export type ConfigFieldKind =
  /** A label, identity marker, format literal or recorded preference. */
  | 'descriptive'
  /** Names something Pappra may read or write, or a policy ceiling for it. */
  | 'access-candidate'
  /** Names something that may be executed. */
  | 'execution-candidate'
  /** Chooses an engine, host or document visibility policy. */
  | 'selection'
  /** Binds this checkout to a local identity, path or verified artifact. */
  | 'local-binding'
  /** Open container whose interior is not part of the schema contract. */
  | 'open-container';

/**
 * What the value cannot do on its own. `none` for descriptive fields.
 * The vocabulary deliberately has no "already effective because it is
 * committed" value: a shared declaration always needs one of the conditions
 * below before it has an effect.
 */
export type ConfigFieldGate =
  | 'none'
  /** Consumed only when an explicit Pappra command runs. */
  | 'explicit-command'
  /** Inert until a value from this checkout's private layer binds it. */
  | 'local-binding'
  /** Nothing consumes it today; a future consumer needs an explicit decision. */
  | 'no-consumer';

export const authorityBearingKinds: readonly ConfigFieldKind[] = [
  'access-candidate',
  'execution-candidate',
  'selection',
  'local-binding',
];

export interface ConfigFieldAuthority {
  /** Canonical field path; `[]` marks an array element. */
  readonly path: string;
  readonly layer: ConfigLayer;
  readonly kind: ConfigFieldKind;
  readonly gate: ConfigFieldGate;
  readonly note: string;
}

/** `workspace.json` is shared and committed. */
export const WORKSPACE_CONFIG_AUTHORITY: readonly ConfigFieldAuthority[] = [
  {
    path: 'schema',
    layer: 'shared',
    kind: 'descriptive',
    gate: 'none',
    note: 'Format literal pappra/workspace/1. An unsupported value is rejected, never migrated or partially read.',
  },
  {
    path: 'workspaceId',
    layer: 'shared',
    kind: 'descriptive',
    gate: 'none',
    note: 'Stable identity used to correlate continuity, pin and task records. It grants nothing.',
  },
  {
    path: 'name',
    layer: 'shared',
    kind: 'descriptive',
    gate: 'none',
    note: 'Human-readable workspace label.',
  },
  {
    path: 'runtimeVersion',
    layer: 'shared',
    kind: 'selection',
    gate: 'explicit-command',
    note: 'Names the runtime version this workspace targets. Verifying, installing or binding it needs an explicit runtime or init command; the verified executable lives in machine.json.',
  },
  {
    path: 'repositories[].id',
    layer: 'shared',
    kind: 'descriptive',
    gate: 'none',
    note: 'Logical repository id referenced by validation entries and named in diagnostics and reports.',
  },
  {
    path: 'repositories[].path',
    layer: 'shared',
    kind: 'access-candidate',
    gate: 'explicit-command',
    note: 'Names a checkout Pappra may read or write under its access entry. A relative path is resolved inside the root; external:<id> is usable only with a matching machine.json mapping.',
  },
  {
    path: 'repositories[].access',
    layer: 'shared',
    kind: 'access-candidate',
    gate: 'explicit-command',
    note: 'Policy ceiling (read or write) for what Pappra offers for that checkout. It is not operating-system isolation and grants no filesystem permission.',
  },
  {
    path: 'knowledge.sources[]',
    layer: 'shared',
    kind: 'access-candidate',
    gate: 'explicit-command',
    note: 'Workspace-relative read candidates for document discovery. Content is not copied, external references are rejected, and a command must run for anything to be read.',
  },
  {
    path: 'knowledge.newDocuments',
    layer: 'shared',
    kind: 'access-candidate',
    gate: 'explicit-command',
    note: 'Workspace-relative write target for newly authored documents. Absolute paths and escapes are rejected.',
  },
  {
    path: 'knowledge.taskVisibility',
    layer: 'shared',
    kind: 'selection',
    gate: 'explicit-command',
    note: 'Sharing policy for task-authored documents. Raw evidence and checkpoints stay private regardless of this value.',
  },
  {
    path: 'code.graph',
    layer: 'shared',
    kind: 'selection',
    gate: 'explicit-command',
    note: 'Declares the intended graph engine. doctor probes PATH presence only; prepare and query stay explicit commands.',
  },
  {
    path: 'code.symbols',
    layer: 'shared',
    kind: 'selection',
    gate: 'explicit-command',
    note: 'Declares the intended symbol provider. No provider is started by the declaration, and auto proves nothing.',
  },
  {
    path: 'code.prepare',
    layer: 'shared',
    kind: 'selection',
    gate: 'no-consumer',
    note: 'Recorded preparation preference. No current consumer schedules or triggers index preparation from it.',
  },
  {
    path: 'validation[].id',
    layer: 'shared',
    kind: 'descriptive',
    gate: 'none',
    note: 'Logical id for a validation candidate.',
  },
  {
    path: 'validation[].repositoryId',
    layer: 'shared',
    kind: 'descriptive',
    gate: 'none',
    note: 'Binds a candidate to a declared repository id. An unknown id is a diagnostic, never a guess.',
  },
  {
    path: 'validation[].executable',
    layer: 'shared',
    kind: 'execution-candidate',
    gate: 'explicit-command',
    note: 'A candidate executable kept as an exact string. No current entrypoint resolves it on PATH or executes it.',
  },
  {
    path: 'validation[].args[]',
    layer: 'shared',
    kind: 'execution-candidate',
    gate: 'explicit-command',
    note: 'Candidate arguments recorded with the executable. No current entrypoint runs them.',
  },
  {
    path: 'excludes[]',
    layer: 'shared',
    kind: 'descriptive',
    gate: 'none',
    note: 'Literal workspace-relative prefixes removed from discovery. It narrows reads, and glob metacharacters are rejected.',
  },
  {
    path: 'extensions',
    layer: 'shared',
    kind: 'open-container',
    gate: 'none',
    note: 'Open key/value container. Classification stops at this boundary: interior keys are not part of the schema contract, nothing in Pappra reads them as authority today, and a future consumer must classify its own keys before acting on them.',
  },
  {
    path: 'continuity.autoResume',
    layer: 'shared',
    kind: 'selection',
    gate: 'no-consumer',
    note: 'Declared continuity preference that no consumer honours today: only init and reconfigure preserve it, while resume decisions read the checkout-private task pin. Honouring it needs a decision in the private layer.',
  },
];

/** `machine.json` is checkout-local and never shared. */
export const MACHINE_CONFIG_AUTHORITY: readonly ConfigFieldAuthority[] = [
  {
    path: 'schema',
    layer: 'private',
    kind: 'descriptive',
    gate: 'none',
    note: 'Format literal pappra/machine/1.',
  },
  {
    path: 'workspaceRealpath',
    layer: 'private',
    kind: 'local-binding',
    gate: 'local-binding',
    note: 'Binds this file to one checkout real path. A mismatch fails closed instead of reusing another checkout.',
  },
  {
    path: 'checkoutId',
    layer: 'private',
    kind: 'local-binding',
    gate: 'local-binding',
    note: 'Checkout-local identity for continuity records. When it is absent, continuity derives a digest of the repository root instead.',
  },
  {
    path: 'externalRepositories[].id',
    layer: 'private',
    kind: 'descriptive',
    gate: 'none',
    note: 'Logical id matched against the external:<id> references in the shared file.',
  },
  {
    path: 'externalRepositories[].path',
    layer: 'private',
    kind: 'local-binding',
    gate: 'local-binding',
    note: 'Absolute host path that actually locates an external checkout. Only this private layer may name it; the shared layer can name the logical id alone.',
  },
  {
    path: 'selectedHosts[]',
    layer: 'private',
    kind: 'selection',
    gate: 'local-binding',
    note: 'Hosts this person selected for integration. Wiring still needs an explicit host install command, and native trust, reload and callability stay unverified.',
  },
  {
    path: 'runtime.version',
    layer: 'private',
    kind: 'local-binding',
    gate: 'local-binding',
    note: 'Version of the verified runtime copy bound to this checkout.',
  },
  {
    path: 'runtime.executable',
    layer: 'private',
    kind: 'local-binding',
    gate: 'local-binding',
    note: 'Absolute path of the verified runtime executable used by runtime commands. doctor inspects it and never runs it.',
  },
  {
    path: 'runtime.verifiedAt',
    layer: 'private',
    kind: 'descriptive',
    gate: 'none',
    note: 'Timestamp of the last verification: evidence, not authority.',
  },
];

export interface ConfigAuthoritySource {
  readonly layer: ConfigLayer;
  readonly file: string;
  readonly schemaName: string;
  readonly schema: z.core.$ZodType;
  readonly fields: readonly ConfigFieldAuthority[];
}

export const CONFIG_AUTHORITY_SOURCES: readonly ConfigAuthoritySource[] = [
  {
    layer: 'shared',
    file: '.pappra/workspace.json',
    schemaName: WORKSPACE_SCHEMA,
    schema: workspaceConfigSchema,
    fields: WORKSPACE_CONFIG_AUTHORITY,
  },
  {
    layer: 'private',
    file: '.pappra/local/machine.json',
    schemaName: MACHINE_SCHEMA,
    schema: machineConfigSchema,
    fields: MACHINE_CONFIG_AUTHORITY,
  },
];

/**
 * A value built from more than one layer at read time. Every current
 * composition is listed here so a status or diagnostic surface can name the
 * layer that actually supplied the value.
 */
export interface ConfigValueComposition {
  readonly id: string;
  readonly effective: string;
  readonly shared: readonly string[];
  readonly private: readonly string[];
  readonly note: string;
}

export const CROSS_LAYER_VALUE_COMPOSITIONS: readonly ConfigValueComposition[] =
  [
    {
      id: 'external-repository-location',
      effective: 'repository checkout root',
      shared: ['repositories[].path'],
      private: ['externalRepositories[].id', 'externalRepositories[].path'],
      note: 'The shared layer names only external:<id>; absolute paths and root escapes are rejected there. The absolute location comes from the private layer, and an unmapped id fails closed.',
    },
    {
      id: 'continuity-checkout-identity',
      effective: 'checkout id stored in continuity records',
      shared: [],
      private: ['checkoutId'],
      note: 'The private binding is used when present; otherwise Pappra derives a digest of the repository root. The derived value is not a stored setting and is never written back.',
    },
    {
      id: 'runtime-archive-inspection-version',
      effective: 'version whose retained runtime state doctor inspects',
      shared: ['runtimeVersion'],
      private: ['runtime.version'],
      note: 'doctor inspects the state of the shared target version, falling back to the private binding only to look for retained state. The install target stays the shared runtimeVersion.',
    },
  ];

export interface ConfigSchemaField {
  /** Canonical path; `[]` marks an array element. */
  readonly path: string;
  /** True for an open container whose interior cannot be enumerated. */
  readonly open: boolean;
}

/** A schema construct this contract does not model, reported instead of guessed. */
export interface ConfigUnsupportedField {
  readonly path: string;
  /** The zod definition type, for example `union` or `pipe`. */
  readonly construct: string;
}

export interface ConfigSchemaScan {
  /** Paths whose interior and role this contract models. */
  readonly fields: readonly ConfigSchemaField[];
  /**
   * Paths reached through a construct this contract does not model. The walker
   * stops there and says so; it never flattens an unmodelled construct into a
   * leaf that would silently satisfy the coverage check.
   */
  readonly unsupported: readonly ConfigUnsupportedField[];
}

/**
 * Scalar definition types: no interior, and their whole meaning is the value.
 * `string` covers the format variants (`uuid`, `iso.datetime`, ...), which are
 * separate zod classes but the same definition type.
 */
const scalarDefinitionTypes: ReadonlySet<string> = new Set([
  'string',
  'number',
  'bigint',
  'boolean',
  'date',
  'literal',
  'enum',
  'null',
  'undefined',
  'void',
  'never',
]);

function definitionType(schema: z.core.$ZodType): string {
  const definition = (
    schema as unknown as { readonly def?: { readonly type?: unknown } }
  ).def;
  const type = definition?.type;
  return typeof type === 'string' && type.length > 0 ? type : 'unmodelled';
}

function fieldPath(path: string): string {
  return path === '' ? '(root)' : path;
}

/**
 * Enumerates the field paths of one schema and every construct it cannot model.
 *
 * Supported: `object` (descended), `array` (descended, elements marked `[]`),
 * `optional`/`nullable`/`default`/`readonly` (unwrapped, same path), `record` and
 * `unknown`/`any` (reported as one open boundary and not entered), and the scalar
 * definition types above. Every other construct — union, intersection, pipe,
 * lazy, tuple, set, map, promise, function, template literal, custom,
 * transforms — is reported as unsupported. That set is a closed allowlist on
 * purpose: a construct added to zod later is reported rather than silently
 * treated as a leaf.
 */
export function scanConfigSchema(schema: z.core.$ZodType): ConfigSchemaScan {
  const fields: ConfigSchemaField[] = [];
  const unsupported: ConfigUnsupportedField[] = [];
  const visit = (current: z.core.$ZodType, path: string): void => {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      visit(current.unwrap(), path);
      return;
    }
    if (current instanceof z.ZodDefault || current instanceof z.ZodReadonly) {
      visit(current.unwrap(), path);
      return;
    }
    if (current instanceof z.ZodArray) {
      visit(current.element, `${path}[]`);
      return;
    }
    if (current instanceof z.ZodObject) {
      const shape: z.ZodRawShape = current.shape;
      for (const [key, value] of Object.entries(shape)) {
        visit(value as z.core.$ZodType, path === '' ? key : `${path}.${key}`);
      }
      return;
    }
    if (
      current instanceof z.ZodRecord ||
      current instanceof z.ZodUnknown ||
      current instanceof z.ZodAny
    ) {
      fields.push({ path, open: true });
      return;
    }
    if (scalarDefinitionTypes.has(definitionType(current))) {
      fields.push({ path, open: false });
      return;
    }
    unsupported.push({ path, construct: definitionType(current) });
  };
  visit(schema, '');
  return { fields, unsupported };
}

export interface ConfigAuthorityCoverage {
  readonly layer: ConfigLayer;
  readonly file: string;
  readonly fields: readonly ConfigSchemaField[];
  /** Constructs at a declared path that the classification cannot cover. */
  readonly unsupported: readonly ConfigUnsupportedField[];
  readonly classified: readonly ConfigFieldAuthority[];
  /** Schema paths that no classification covers. */
  readonly unclassified: readonly string[];
  /** Classification paths that no longer exist in the schema. */
  readonly stale: readonly string[];
}

export interface ConfigAuthorityInspection {
  readonly sources: readonly ConfigAuthorityCoverage[];
  /** Machine-checkable breaches of the classification contract. */
  readonly violations: readonly string[];
  /**
   * Field paths that occur in both layers. Reported, not treated as a conflict:
   * a repeated name is not by itself one effective value.
   */
  readonly duplicatePaths: readonly string[];
}

function authorityBearing(field: ConfigFieldAuthority): boolean {
  return authorityBearingKinds.includes(field.kind);
}

const allowedAuthorityGates: readonly ConfigFieldGate[] = [
  'explicit-command',
  'local-binding',
  'no-consumer',
];

/**
 * Compares one schema's enumerated fields with one classification table.
 * `unclassified` is the drift a new schema field introduces; `stale` is a table
 * entry the schema no longer has. Both empty means the table covers the schema.
 */
export function configAuthorityGaps(
  fields: readonly ConfigSchemaField[],
  classified: readonly ConfigFieldAuthority[],
): {
  readonly unclassified: readonly string[];
  readonly stale: readonly string[];
} {
  const schemaPaths = new Set(fields.map((field) => field.path));
  const classifiedPaths = new Set(classified.map((field) => field.path));
  return {
    unclassified: fields
      .filter((field) => !classifiedPaths.has(field.path))
      .map((field) => field.path),
    stale: classified
      .filter((field) => !schemaPaths.has(field.path))
      .map((field) => field.path),
  };
}

/**
 * Classifies schemas against their tables and reports contract breaches.
 *
 * The default is the current two-file contract. A caller may pass another
 * source list — a candidate schema, or a test fixture — and gets the same
 * machine-checkable verdict without touching the published contract.
 */
export function inspectConfigAuthority(
  sources: readonly ConfigAuthoritySource[] = CONFIG_AUTHORITY_SOURCES,
): ConfigAuthorityInspection {
  const coverage: ConfigAuthorityCoverage[] = [];
  const violations: string[] = [];

  for (const source of sources) {
    const scan = scanConfigSchema(source.schema);
    const fields = scan.fields;
    const classified = source.fields;
    // The walker cannot establish absence or enumerability inside a construct
    // it did not enter. Match path boundaries, not similar textual prefixes.
    const isUninspectable = (path: string): boolean =>
      scan.unsupported.some(
        (entry) =>
          entry.path === '' ||
          (path.startsWith(entry.path) &&
            /^(?:\[\])*(?:\.|$)/.test(path.slice(entry.path.length))),
      );
    const gaps = configAuthorityGaps(fields, classified);
    const stale = gaps.stale.filter((path) => !isUninspectable(path));
    coverage.push({
      layer: source.layer,
      file: source.file,
      fields,
      unsupported: scan.unsupported,
      classified,
      unclassified: gaps.unclassified,
      stale,
    });

    for (const entry of scan.unsupported) {
      const declared = classified.find((field) => field.path === entry.path);
      violations.push(
        `${source.file}: ${fieldPath(entry.path)} uses the unmodelled schema construct "${entry.construct}"; ` +
          (declared === undefined
            ? 'no classification can cover its interior'
            : `the classification (${declared.kind}) cannot cover its interior`),
      );
    }
    for (const path of gaps.unclassified) {
      violations.push(
        `${source.file}: ${path} has no authority classification`,
      );
    }
    for (const path of stale) {
      violations.push(
        `${source.file}: ${path} is classified but absent from the schema`,
      );
    }
    for (const field of classified) {
      if (field.layer !== source.layer) {
        violations.push(
          `${source.file}: ${field.path} declares layer ${field.layer}, expected ${source.layer}`,
        );
      }
      if (field.kind === 'descriptive' || field.kind === 'open-container') {
        if (field.gate !== 'none') {
          violations.push(
            `${source.file}: ${field.path} is ${field.kind} but gate is ${field.gate}`,
          );
        }
      } else if (field.gate === 'none') {
        violations.push(
          `${source.file}: ${field.path} is ${field.kind} without an enabling condition`,
        );
      }
      if (
        authorityBearing(field) &&
        !allowedAuthorityGates.includes(field.gate)
      ) {
        violations.push(
          `${source.file}: ${field.path} is authority-bearing with gate ${field.gate}`,
        );
      }
      if (field.layer === 'shared' && authorityBearing(field)) {
        // The committed layer may propose; it may never activate on its own.
        violations.push(
          ...(allowedAuthorityGates.includes(field.gate)
            ? []
            : [
                `${source.file}: ${field.path} is activated by the committed layer`,
              ]),
        );
      }
      if (field.kind === 'open-container' && !isUninspectable(field.path)) {
        const declared = fields.find((entry) => entry.path === field.path);
        if (declared === undefined || !declared.open) {
          violations.push(
            `${source.file}: ${field.path} is classified as an open container but is enumerable`,
          );
        }
      }
    }
    const seen = new Set<string>();
    for (const field of classified) {
      if (seen.has(field.path)) {
        violations.push(`${source.file}: ${field.path} is classified twice`);
      }
      seen.add(field.path);
    }
  }

  const byPath = new Map<string, ConfigLayer[]>();
  for (const source of coverage) {
    for (const field of source.fields) {
      const layers = byPath.get(field.path) ?? [];
      layers.push(source.layer);
      byPath.set(field.path, layers);
    }
  }
  const duplicatePaths = [...byPath.entries()]
    .filter(([, layers]) => layers.length > 1)
    .map(([path]) => path);

  return { sources: coverage, violations, duplicatePaths };
}

export interface ConfigAuthoritySummary {
  readonly layer: ConfigLayer;
  readonly file: string;
  readonly total: number;
  readonly descriptive: number;
  readonly authorityBearing: number;
  readonly openContainers: number;
  readonly explicitCommand: number;
  readonly localBinding: number;
  readonly noConsumer: number;
  /** Authority-bearing fields, in schema order. */
  readonly authorityBearingPaths: readonly string[];
  /** Fields nothing consumes today, in schema order. */
  readonly inertPaths: readonly string[];
}

/** Counts of one layer's classification, for status and diagnostic surfaces. */
export function summarizeConfigAuthority(
  layer: ConfigLayer,
): ConfigAuthoritySummary {
  const source = CONFIG_AUTHORITY_SOURCES.find(
    (entry) => entry.layer === layer,
  );
  const fields = source === undefined ? [] : source.fields;
  const pick = (kind: ConfigFieldKind): ConfigFieldAuthority[] =>
    fields.filter((field) => field.kind === kind);
  return {
    layer,
    file:
      source?.file ??
      (layer === 'shared'
        ? '.pappra/workspace.json'
        : '.pappra/local/machine.json'),
    total: fields.length,
    descriptive: pick('descriptive').length,
    authorityBearing: fields.filter(authorityBearing).length,
    openContainers: pick('open-container').length,
    explicitCommand: fields.filter((field) => field.gate === 'explicit-command')
      .length,
    localBinding: fields.filter((field) => field.gate === 'local-binding')
      .length,
    noConsumer: fields.filter((field) => field.gate === 'no-consumer').length,
    authorityBearingPaths: fields
      .filter(authorityBearing)
      .map((field) => field.path),
    inertPaths: fields
      .filter((field) => field.gate === 'no-consumer')
      .map((field) => field.path),
  };
}
