/**
 * POSIX single-quote a word so a shell passes it through verbatim. JSON.stringify is not a
 * substitute: double quotes still expand `$` and execute backticks.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
