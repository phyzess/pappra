import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PackageInfo {
  readonly name: string;
  readonly version: string;
  readonly description: string;
}

export function getPackageInfo(): PackageInfo {
  const value: unknown = JSON.parse(
    readFileSync(
      new URL(import.meta.resolve('@phyzess/pappra/package.json')),
      'utf8',
    ),
  );
  if (
    typeof value !== 'object' ||
    value === null ||
    !('name' in value) ||
    typeof value.name !== 'string' ||
    !('version' in value) ||
    typeof value.version !== 'string' ||
    !('description' in value) ||
    typeof value.description !== 'string'
  ) {
    throw new Error('The installed Pappra package metadata is invalid.');
  }
  return {
    name: value.name,
    version: value.version,
    description: value.description,
  };
}

/** Absolute root of the package that is currently executing. */
export function getPackageRoot(): string {
  return dirname(
    fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json')),
  );
}
