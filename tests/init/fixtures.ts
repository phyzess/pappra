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
}

export class FakeWizardUi implements WizardUi {
  readonly calls: FakeUiCall[] = [];
  readonly #text: (string | symbol)[];
  readonly #select: (string | symbol)[];
  readonly #multiselect: (readonly string[] | symbol)[];
  readonly #confirm: (boolean | symbol)[];
  readonly cancelled: string[] = [];
  readonly notes: string[] = [];

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

  async text(message: string): Promise<string | symbol> {
    this.calls.push({ kind: 'text', message, options: [] });
    const next = this.#text.shift();
    if (next === undefined)
      throw new Error(`No fake text answer for: ${message}`);
    return next;
  }

  async select(
    message: string,
    options: readonly SelectOption[],
  ): Promise<string | symbol> {
    this.calls.push({ kind: 'select', message, options });
    const next = this.#select.shift();
    if (next === undefined)
      throw new Error(`No fake select answer for: ${message}`);
    return next;
  }

  async multiselect(
    message: string,
    options: readonly SelectOption[],
  ): Promise<readonly string[] | symbol> {
    this.calls.push({ kind: 'multiselect', message, options });
    const next = this.#multiselect.shift();
    if (next === undefined) {
      throw new Error(`No fake multiselect answer for: ${message}`);
    }
    return next;
  }

  async confirm(message: string): Promise<boolean | symbol> {
    this.calls.push({ kind: 'confirm', message, options: [] });
    const next = this.#confirm.shift();
    if (next === undefined)
      throw new Error(`No fake confirm answer for: ${message}`);
    return next;
  }

  cancel(message: string): void {
    this.cancelled.push(message);
  }
}
