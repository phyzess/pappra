import * as prompts from '@clack/prompts';

/**
 * Shared terminal interaction surface. Interactive behaviour is a convenience for
 * a person at a TTY only: JSON output, non-TTY streams, CI and --no-interactive
 * keep the explicit, scriptable flag contract unchanged. A prompt answer is the
 * person's own decision for that invocation; nothing here answers on their behalf.
 */

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface WizardUi {
  intro(message: string): void;
  outro(message: string): void;
  note(message: string, title: string): void;
  text(
    message: string,
    initialValue?: string,
    validate?: (value: string) => string | undefined,
  ): Promise<string | symbol>;
  select(
    message: string,
    options: readonly SelectOption[],
    initialValue?: string,
  ): Promise<string | symbol>;
  multiselect(
    message: string,
    options: readonly SelectOption[],
    initialValues?: readonly string[],
  ): Promise<readonly string[] | symbol>;
  confirm(message: string, initialValue?: boolean): Promise<boolean | symbol>;
  cancel(message: string): void;
}

export const clackWizardUi: WizardUi = {
  intro: (message) => prompts.intro(message),
  outro: (message) => prompts.outro(message),
  note: (message, title) => prompts.note(message, title),
  text: async (message, initialValue, validate) =>
    prompts.text({
      message,
      ...(initialValue === undefined ? {} : { initialValue }),
      ...(validate === undefined
        ? {}
        : {
            validate: (value: string | undefined) =>
              value === undefined ? undefined : validate(value),
          }),
    }),
  select: async (message, options, initialValue) =>
    prompts.select<string>({
      message,
      options: options.map((option) => ({ ...option })),
      ...(initialValue === undefined ? {} : { initialValue }),
    }),
  multiselect: async (message, options, initialValues) =>
    prompts.multiselect<string>({
      message,
      options: options.map((option) => ({ ...option })),
      required: false,
      ...(initialValues === undefined
        ? {}
        : { initialValues: [...initialValues] }),
    }),
  confirm: async (message, initialValue) =>
    prompts.confirm({
      message,
      ...(initialValue === undefined ? {} : { initialValue }),
    }),
  cancel: (message) => prompts.cancel(message),
};

/** Progress feedback for a long step; a no-op implementation is used in tests. */
export interface ProgressUi {
  start(message: string): void;
  stop(message: string): void;
}

export function clackProgress(): ProgressUi {
  const spinner = prompts.spinner();
  return {
    start: (message) => spinner.start(message),
    stop: (message) => spinner.stop(message),
  };
}

export const silentProgress: ProgressUi = {
  start: () => undefined,
  stop: () => undefined,
};

/**
 * True only for a person at a terminal: both streams are TTYs, no JSON output was
 * requested, the caller did not opt out, and the process is not running under CI.
 */
export function isInteractiveTerminal(options: {
  readonly json: boolean;
  readonly noInteractive?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdinIsTty?: boolean;
  readonly stdoutIsTty?: boolean;
}): boolean {
  const env = options.env ?? process.env;
  const ci = env['CI'];
  return (
    !options.json &&
    options.noInteractive !== true &&
    (ci === undefined || ci === '' || ci === '0' || ci === 'false') &&
    (options.stdinIsTty ?? process.stdin.isTTY === true) &&
    (options.stdoutIsTty ?? process.stdout.isTTY === true)
  );
}

/** Resolves a prompt result; a cancelled prompt (Ctrl+C / Esc) becomes null. */
export async function answer<T>(
  promise: Promise<T | symbol>,
): Promise<T | null> {
  const value = await promise;
  return typeof value === 'symbol' ? null : value;
}

/**
 * Asks once whether to apply a plan that was just printed. Cancelling counts as
 * declining. Destructive operations pass `initialValue: false`.
 */
export async function confirmApply(
  ui: WizardUi,
  message: string,
  initialValue = true,
): Promise<boolean> {
  return (await answer(ui.confirm(message, initialValue))) === true;
}

/** Picks one value from a non-empty list; a single option is returned without asking. */
export async function pickOne(
  ui: WizardUi,
  message: string,
  options: readonly SelectOption[],
): Promise<string | null> {
  if (options.length === 0) return null;
  if (options.length === 1) return options[0]!.value;
  return answer(ui.select(message, options));
}
