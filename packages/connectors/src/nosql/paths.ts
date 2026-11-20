import type { NoSqlConnection } from '@riosoma/contracts';
import { flatten } from '../rest/records.js';
import { ConnectorError } from '../types.js';

/** Literal dots and backslashes stay distinct from document path separators. */
export function fieldName(path: readonly string[]): string {
  return path.map((part) => part.replaceAll('\\', '\\\\').replaceAll('.', '\\.')).join('.');
}

export function fieldParts(name: string): string[] {
  const parts = [''];
  for (let i = 0; i < name.length; i++) {
    let char = name[i]!;
    if (char === '.') parts.push('');
    else {
      if (char === '\\') {
        char = name[++i]!;
        if (char !== '.' && char !== '\\') throw new ConnectorError('sources.live.unsupported');
      }
      parts[parts.length - 1] += char;
    }
  }
  if (parts.some((part) => !part)) throw new ConnectorError('sources.live.unsupported');
  return parts;
}

/** Old dotted mappings cannot establish which native field an access rule meant. */
export function assertUnambiguous(
  document: Record<string, unknown>,
  connection: NoSqlConnection,
  fields: ReadonlySet<string>,
): void {
  flatten(
    document,
    connection,
    () => {},
    (path) => {
      const name = fieldName(path);
      if (name !== path.join('.') && fields.has(path.join('.')))
        throw new ConnectorError('sources.live.unsupported');
      return name;
    },
  );
}
