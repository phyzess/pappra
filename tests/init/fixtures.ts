import type { SelectOption, WizardUi } from '../../src/cli/commands/init.js';
import {
  INIT_CHOICES_SCHEMA,
  type InitChoices,
} from '../../src/schemas/init.js';
import { workspaceId } from '../workspace/fixtures.js';

export interface InitChoicesOverrides {
  readonly [key: string]: unknown;
}

export function baseInitChoices(
  overrides: InitChoicesOverrides = {},
): InitChoices {
  return {
    schema: INIT_CHOICES_SCHEMA,
    name: 'fixture workspace',
    workspaceId,
    repositories: [],
    knowledge: {
      sources: [],
      newDocuments: '.pappra/knowledge',
      taskVisibility: 'private',
    },
    code: { graph: 'none', symbols: 'auto', prepare: 'on-demand' },
    validation: [],
    excludes: [],
    hosts: ['pi'],
    ...overrides,
  } as InitChoices;
}

export interface FakeUiQueues {
  readonly text?: readonly (string | symbol)[];
  readonly select?: readonly (string | symbol)[];
  readonly multiselect?: readonly (readonly string[] | symbol)[];
  readonly confirm?: readonly (boolean | symbol)[];
}

export interface FakeUiCall {
  readonly kind: 'text' | 'select' | 'multiselect' | 'confirm';
  readonly message: string;
  readonly options: readonly SelectOption[];
  readonly initialValue?: string | boolean;
  readonly initialValues?: readonly string[];
}

export class FakeWizardUi implements WizardUi {
  readonly calls: FakeUiCall[] = [];
  readonly #text: (string | symbol)[];
  readonly #select: (string | symbol)[];
  readonly #multiselect: (readonly string[] | symbol)[];
  readonly #confirm: (boolean | symbol)[];
  readonly cancelled: string[] = [];
  readonly notes: string[] = [];
  readonly validationErrors: {
    readonly message: string;
    readonly value: string;
    readonly error: string;
  }[] = [];

  constructor(queues: FakeUiQueues) {
    this.#text = [...(queues.text ?? [])];
    this.#select = [...(queues.select ?? [])];
    this.#multiselect = [...(queues.multiselect ?? [])];
    this.#confirm = [...(queues.confirm ?? [])];
  }

  intro(): void {}

  outro(): void {}

  note(message: string): void {
    this.notes.push(message);
  }

  async text(
    message: string,
    initialValue?: string,
    validate?: (value: string) => string | undefined,
  ): Promise<string | symbol> {
    this.calls.push({
      kind: 'text',
      message,
      options: [],
      ...(initialValue === undefined ? {} : { initialValue }),
    });
    let next = this.#text.shift();
    if (next === undefined)
      throw new Error(`No fake text answer for: ${message}`);
    if (typeof next === 'string' && validate !== undefined) {
      let error = validate(next);
      while (error !== undefined) {
        this.validationErrors.push({ message, value: next, error });
        next = this.#text.shift();
        if (next === undefined) {
          throw new Error(`No corrected fake text answer for: ${message}`);
        }
        if (typeof next === 'symbol') return next;
        error = validate(next);
      }
    }
    return next;
  }

  async select(
    message: string,
    options: readonly SelectOption[],
    initialValue?: string,
  ): Promise<string | symbol> {
    this.calls.push({
      kind: 'select',
      message,
      options,
      ...(initialValue === undefined ? {} : { initialValue }),
    });
    const next = this.#select.shift();
    if (next === undefined)
      throw new Error(`No fake select answer for: ${message}`);
    return next;
  }

  async multiselect(
    message: string,
    options: readonly SelectOption[],
    initialValues?: readonly string[],
  ): Promise<readonly string[] | symbol> {
    this.calls.push({
      kind: 'multiselect',
      message,
      options,
      ...(initialValues === undefined ? {} : { initialValues }),
    });
    const next = this.#multiselect.shift();
    if (next === undefined) {
      throw new Error(`No fake multiselect answer for: ${message}`);
    }
    return next;
  }

  async confirm(
    message: string,
    initialValue?: boolean,
  ): Promise<boolean | symbol> {
    this.calls.push({
      kind: 'confirm',
      message,
      options: [],
      ...(initialValue === undefined ? {} : { initialValue }),
    });
    const next = this.#confirm.shift();
    if (next === undefined)
      throw new Error(`No fake confirm answer for: ${message}`);
    return next;
  }

  cancel(message: string): void {
    this.cancelled.push(message);
  }
}
