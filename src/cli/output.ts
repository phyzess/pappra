export interface CliOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}
