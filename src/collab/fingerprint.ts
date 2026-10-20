import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha256 = (value: string | Uint8Array) =>
  `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;

/** Fingerprint one explicitly selected skill, including its supporting files. */
export function fingerprintSkill(input: string) {
  if (!path.isAbsolute(input)) throw new Error('Skill path must be absolute');
  const resolved = fs.realpathSync(input);
  const root = fs.statSync(resolved).isDirectory()
    ? resolved
    : path.dirname(resolved);
  if (
    !fs.statSync(resolved).isDirectory() &&
    path.basename(resolved) !== 'SKILL.md'
  ) {
    throw new Error('Select a skill directory or SKILL.md');
  }
  const entry = path.join(root, 'SKILL.md');
  const files: [string, string][] = [];
  let totalBytes = 0;
  let directoryCount = 0;
  function visit(directory: string) {
    if (++directoryCount > 1000)
      throw new Error('Skill exceeds the directory limit');
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink())
        throw new Error(
          'Supporting symlinks require an explicitly packaged skill',
        );
      if (stat.isDirectory()) {
        visit(file);
      } else if (stat.isFile()) {
        totalBytes += stat.size;
        if (files.length >= 1000 || totalBytes > 16 * 1024 * 1024) {
          throw new Error('Skill exceeds the fingerprint size limit');
        }
        files.push([
          path.relative(root, file).split(path.sep).join('/'),
          sha256(fs.readFileSync(file)),
        ]);
      } else {
        throw new Error('Skill contains an unsupported file type');
      }
    }
  }
  visit(root);
  files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const entryRow = files.find(([name]) => name === 'SKILL.md');
  if (!entryRow) throw new Error('Skill entry is missing');
  return {
    path: entry,
    entry_digest: entryRow[1],
    bundle_digest: sha256(JSON.stringify(files)),
    file_count: files.length,
  };
}
