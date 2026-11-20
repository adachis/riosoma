import { z } from 'zod';
import {
  cellText,
  date,
  DATE_FORMATS,
  lookup,
  normalizeMarker,
  type ExtractedSource,
  type IngestRow,
  type ReaderBinding,
} from '@riosoma/ingest';
import { READER_LIMITS, type ReaderFacts } from './types.js';
import { ScriptError } from '../../automations/script.js';

const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const aliases = z.array(z.string().min(1).max(10_000)).min(1).max(200);
export const ReaderBindings = z.record(
  z.string(),
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('column'),
      aliases,
      dateFormats: z.array(z.enum(DATE_FORMATS)).min(1).optional(),
    }),
    z.strictObject({ kind: z.literal('fixed'), value: scalar }),
    z.strictObject({ kind: z.literal('lookup'), aliases, entries: z.record(z.string(), scalar) }),
    z.strictObject({ kind: z.literal('emailSubject') }),
    z.strictObject({ kind: z.literal('fact'), key: z.string().min(1).max(200) }),
  ]),
);

/** Declarative bindings are executed, so their saved provenance cannot merely describe what code claims. */
export function bindReaderValues(
  source: ExtractedSource,
  rows: IngestRow[],
  bindings: Readonly<Record<string, ReaderBinding>>,
  facts: ReaderFacts,
) {
  let bytes = 0;
  const emailGrids = source.email?.tables.map((table) =>
    table.map((line) => line.map((v) => ({ v, t: 'text' as const }))),
  );
  const columns = new Map<string, number>();
  for (const row of rows) {
    if (Object.keys(row.values).some((key) => !Object.hasOwn(bindings, key)))
      throw new ScriptError('ingest.reader.invalidRow');
    // Evidence comes from the binding's source, so emitted text cannot hide an ambiguous value.
    row.raw = {};
    for (const [key, binding] of Object.entries(bindings)) {
      if (binding.kind === 'fixed') {
        row.values[key] = binding.value;
        row.raw[key] = String(binding.value ?? '');
        continue;
      }
      if (binding.kind === 'emailSubject') {
        row.values[key] = source.email?.subject ?? null;
        row.raw[key] = source.email?.subject ?? '';
        continue;
      }
      if (binding.kind === 'fact') {
        const value = Object.hasOwn(facts, binding.key) ? facts[binding.key] : null;
        const parsed = scalar.safeParse(value);
        if (!parsed.success) throw new ScriptError('ingest.reader.invalidRow');
        row.values[key] = parsed.data;
        row.raw[key] = String(parsed.data ?? '');
        continue;
      }
      const grid =
        source.sheets?.find((sheet) => sheet.name === row.at.sheet)?.rows ??
        emailGrids?.[row.at.table ? row.at.table - 1 : -1];
      const names = binding.aliases.map(normalizeMarker);
      const cacheKey = JSON.stringify([row.at.sheet, row.at.table, names]);
      let column = columns.get(cacheKey);
      if (column === undefined) {
        const header = grid
          ?.slice(0, 200)
          .find((line) => line.some((cell) => names.includes(normalizeMarker(cellText(cell)))));
        column = header?.findIndex((cell) => names.includes(normalizeMarker(cellText(cell)))) ?? -1;
        columns.set(cacheKey, column);
      }
      const value = grid?.[(row.at.row ?? 0) - 1]?.[column]?.v ?? null;
      row.raw[key] = String(value ?? '');
      row.values[key] = binding.kind === 'lookup' ? lookup(value, { entries: binding.entries }).value : value;
      if (binding.kind === 'column' && binding.dateFormats) {
        const cleaned = date(value, { formats: binding.dateFormats });
        // Invalid source values must reach the row writer so they retain their review reasons.
        row.values[key] = cleaned.certain ? cleaned.value : value;
      }
    }
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (bytes > READER_LIMITS.outputBytes) throw new ScriptError('ingest.reader.invalidRow');
  }
}
