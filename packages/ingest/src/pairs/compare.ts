import type { DifferenceKind, ExampleDifference, ExampleResult, ExampleRows } from '../storage.js';
import {
  normalizePairValue,
  pairFieldValue,
  pairValueKey,
  pairValuesEqual,
  serializableValue,
  type PairFieldType,
} from './values.js';

/** Structurally accepts table settings without bringing a runtime contract into the sandbox. */
export interface PairOutputFormat {
  identity: readonly string[] | null;
  /** A field with no declared type is compared as text, so nothing passes by a lucky reading. */
  fields: readonly { key: string; meaning: string; required: boolean; type?: PairFieldType }[];
  rowMeaning: string;
}
export const PAIR_PROCESS_KEYS = ['needsReview', 'reviewNote', 'readByAi', 'source', 'received'] as const;
export function pairDataFields(format: PairOutputFormat): PairOutputFormat['fields'] {
  return format.fields.filter((field) => !PAIR_PROCESS_KEYS.some((key) => key === field.key));
}
const DIFFERENCE_MESSAGES: Record<DifferenceKind, string> = {
  cell: 'ingest.pairs.cell',
  'missing-row': 'ingest.pairs.missingRow',
  'extra-row': 'ingest.pairs.extraRow',
  'duplicate-expected-identity': 'ingest.pairs.duplicateExpectedIdentity',
  'duplicate-actual-identity': 'ingest.pairs.duplicateActualIdentity',
};
const lexical = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
/** Code point sorting stays identical across locales and does not depend on discovery order. */
export function sortPairDifferences(differences: readonly ExampleDifference[]): ExampleDifference[] {
  return [...differences].sort((left, right) =>
    lexical(
      JSON.stringify([
        left.run ?? 0,
        left.identity,
        left.kind,
        left.expectedPosition,
        left.actualPosition,
        left.key,
        serializableValue(left.expected),
        serializableValue(left.actual),
      ]),
      JSON.stringify([
        right.run ?? 0,
        right.identity,
        right.kind,
        right.expectedPosition,
        right.actualPosition,
        right.key,
        serializableValue(right.expected),
        serializableValue(right.actual),
      ]),
    ),
  );
}

export function comparePairRows(
  actual: readonly ExampleRows[number][],
  expected: readonly ExampleRows[number][],
  format: PairOutputFormat,
): ExampleResult {
  const fields = [...pairDataFields(format)].sort((left, right) => lexical(left.key, right.key));
  const identities = [...(format.identity ?? [])]
    .filter((key) => fields.some((field) => field.key === key))
    .sort(lexical);
  const types = new Map<string, PairFieldType>(fields.map((field) => [field.key, field.type ?? 'text']));
  const differences: ExampleDifference[] = [];
  const values = (row: ExampleRows[number] | undefined) =>
    row
      ? Object.fromEntries(fields.map(({ key }) => [key, serializableValue(pairFieldValue(row.values, key))]))
      : null;
  const identity = (row: ExampleRows[number] | undefined) =>
    identities.length && row
      ? Object.fromEntries(
          identities.map((key) => [
            key,
            normalizePairValue(pairFieldValue(row.values, key), types.get(key)).value,
          ]),
        )
      : null;
  const add = (
    kind: DifferenceKind,
    actualPosition: number | null,
    expectedPosition: number | null,
    key: string | null = null,
  ) => {
    const produced = actualPosition === null ? undefined : actual[actualPosition];
    const wanted = expectedPosition === null ? undefined : expected[expectedPosition];
    differences.push({
      kind,
      messageId: DIFFERENCE_MESSAGES[kind],
      row: expectedPosition ?? actualPosition ?? 0,
      identity: identity(wanted ?? produced),
      expectedPosition,
      actualPosition,
      key,
      expected:
        key === null
          ? values(wanted)
          : serializableValue(wanted ? pairFieldValue(wanted.values, key) : undefined),
      actual:
        key === null
          ? values(produced)
          : serializableValue(produced ? pairFieldValue(produced.values, key) : undefined),
    });
  };
  const compare = (produced: number | null, wanted: number | null) => {
    if (produced === null) add('missing-row', produced, wanted);
    else if (wanted === null) add('extra-row', produced, wanted);
    else
      for (const { key } of fields)
        if (
          !pairValuesEqual(
            pairFieldValue(actual[produced]!.values, key),
            pairFieldValue(expected[wanted]!.values, key),
            types.get(key),
          )
        )
          add('cell', produced, wanted, key);
  };
  if (!identities.length) {
    for (let index = 0; index < Math.max(actual.length, expected.length); index++)
      compare(index < actual.length ? index : null, index < expected.length ? index : null);
  } else {
    const group = (rows: readonly ExampleRows[number][], side: 'actual' | 'expected') => {
      const groups = new Map<string, number[]>();
      rows.forEach((row, index) => {
        const token = JSON.stringify(
          identities.map((key) => pairValueKey(pairFieldValue(row.values, key), types.get(key))),
        );
        const positions = groups.get(token) ?? [];
        if (positions.length)
          add(
            side === 'actual' ? 'duplicate-actual-identity' : 'duplicate-expected-identity',
            side === 'actual' ? index : null,
            side === 'expected' ? index : null,
          );
        positions.push(index);
        groups.set(token, positions);
      });
      return groups;
    };
    const produced = group(actual, 'actual');
    const wanted = group(expected, 'expected');
    for (const token of [...new Set([...produced.keys(), ...wanted.keys()])].sort(lexical)) {
      const a = produced.get(token) ?? [],
        b = wanted.get(token) ?? [];
      for (let index = 0; index < Math.max(a.length, b.length); index++)
        compare(a[index] ?? null, b[index] ?? null);
    }
  }
  return {
    passed: differences.length === 0,
    status: differences.length ? 'failed' : 'passed',
    differences: sortPairDifferences(differences),
  };
}
