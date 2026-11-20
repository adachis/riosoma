import type { IngestValueSource } from '@riosoma/contracts';
import type { FormatDefinition } from '@riosoma/ingest';

/** Only executable rules establish a value source.  Unbound reader fields have no reliable provenance. */
export function valueSources(
  format: FormatDefinition,
  fields: readonly string[],
): Record<string, IngestValueSource> {
  if (format.reading !== 'layout') {
    return Object.fromEntries(
      fields.flatMap((key): Array<[string, IngestValueSource]> =>
        format.reading === 'reader' && Object.hasOwn(format.rules.bindings ?? {}, key)
          ? [[key, format.rules.bindings![key]!]]
          : [],
      ),
    );
  }
  return Object.fromEntries(
    fields.flatMap((key): Array<[string, IngestValueSource]> => {
      const column = format.rules.columns[key];
      if (!column && Object.hasOwn(format.rules.constants ?? {}, key))
        return [[key, { kind: 'fixed', value: format.rules.constants![key]! }]];
      if (!column) return [[key, { kind: 'fixed', value: null }]];
      const lookup = column.cleaners.find((cleaner) => cleaner.kind === 'lookup');
      return [
        [
          key,
          lookup?.kind === 'lookup'
            ? { kind: 'lookup', aliases: column.aliases, entries: lookup.entries }
            : { kind: 'column', aliases: column.aliases },
        ],
      ];
    }),
  );
}
