/** Replace one top-level JSON property while retaining unrelated bytes and style. */
export function updateJsonProperty(
  existing: Buffer | null,
  key: string,
  value: unknown,
): Buffer {
  if (existing === null)
    return Buffer.from(`${JSON.stringify({ [key]: value }, null, 2)}\n`);
  const text = existing.toString('utf8');
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('json_object_required');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let indent = '';
  const skipSpace = (at: number) => {
    while (/\s/.test(text[at] ?? '') && at < text.length) at += 1;
    return at;
  };
  const stringEnd = (start: number) => {
    let at = start + 1;
    while (at < text.length) {
      if (text[at] === '\\') at += 2;
      else if (text[at++] === '"') return at;
    }
    throw new Error('json_string_unterminated');
  };
  const render = (prefix: string) => {
    const unit = indent || (text.includes('\n') ? '  ' : undefined);
    return (
      JSON.stringify(value, null, unit)?.replaceAll(
        '\n',
        `${newline}${prefix}`,
      ) ?? 'null'
    );
  };
  let at = skipSpace(text.indexOf('{') + 1);
  while (text[at] !== '}') {
    const endKey = stringEnd(at);
    const property: unknown = JSON.parse(text.slice(at, endKey));
    const line = text.slice(text.lastIndexOf('\n', at) + 1, at);
    if (/^[ \t]+$/.test(line) && (!indent || line.length < indent.length))
      indent = line;
    const startValue = skipSpace(skipSpace(endKey) + 1);
    let endValue = startValue;
    let depth = 0;
    while (endValue < text.length) {
      const character = text[endValue];
      if (character === '"') {
        endValue = stringEnd(endValue);
        continue;
      }
      if (depth === 0 && (character === ',' || character === '}')) break;
      if (character === '[' || character === '{') depth += 1;
      if (character === ']' || character === '}') depth -= 1;
      endValue += 1;
    }
    let contentEnd = endValue;
    while (/\s/.test(text[contentEnd - 1] ?? '') && contentEnd > startValue)
      contentEnd -= 1;
    if (property === key)
      return Buffer.from(
        text.slice(0, startValue) +
          render(/^[ \t]*$/.test(line) ? line : '') +
          text.slice(contentEnd),
      );
    at = skipSpace(endValue + (text[endValue] === ',' ? 1 : 0));
  }
  const prefix = text.slice(0, at).trimEnd();
  const separator = Object.keys(parsed).length > 0 ? ',' : '';
  const insertion = text.includes('\n')
    ? `${separator}${newline}${indent || '  '}${JSON.stringify(key)}: ${render(indent || '  ')}${newline}`
    : `${separator}${JSON.stringify(key)}:${JSON.stringify(value)}`;
  return Buffer.from(prefix + insertion + text.slice(at));
}
