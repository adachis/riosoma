import { randomInt, randomUUID } from 'node:crypto';
import type { IngestDraftRow, IngestSpotCheck } from '@riosoma/contracts';
import {
  normalizePairValue,
  pairValuesEqual,
  type ExtractedSource,
  type PairFieldType,
  type RowLocation,
} from '@riosoma/ingest';

export interface DraftField {
  key: string;
  name: string;
  meaning: string;
  required: boolean;
  type: PairFieldType;
}

/** Distractors change only written values, without inferring anything about the file. */
export function nearMisses(value: unknown, type: PairFieldType): unknown[] {
  const normalized = normalizePairValue(value, type);
  if (normalized.kind === 'number') {
    const number = Number(normalized.value);
    const written = String(number);
    const digits = [...written.matchAll(/\d/g)].map((match) => match.index);
    const index = digits.findIndex(
      (position, i) => i + 1 < digits.length && written[position] !== written[digits[i + 1]!],
    );
    const transposed = [...written];
    if (index >= 0) {
      const left = digits[index]!;
      const right = digits[index + 1]!;
      [transposed[left], transposed[right]] = [transposed[right]!, transposed[left]!];
    }
    return [Number(transposed.join('')), number + 1, number * 10].filter(Number.isFinite);
  }
  if (normalized.kind === 'date' || normalized.kind === 'instant') {
    const date = new Date(String(normalized.value));
    return [-1, 1, 7].flatMap((days) => {
      const neighboring = new Date(date.getTime() + days * 86_400_000);
      if (!Number.isFinite(neighboring.getTime())) return [];
      const written = neighboring.toISOString();
      return [normalized.kind === 'date' ? written.slice(0, 10) : written];
    });
  }
  if (normalized.kind !== 'text') return [];
  const text = String(value);
  const units: Record<string, string> = {
    kg: 'lb',
    lb: 'kg',
    g: 'oz',
    oz: 'g',
    m: 'cm',
    cm: 'm',
    L: 'mL',
    mL: 'L',
    h: 'min',
    min: 'h',
  };
  const changedUnit = text.replace(/\b(kg|lb|oz|cm|mL|min|g|m|L|h)\b/u, (unit) => units[unit]!);
  const letters = [...text];
  const index = letters.findIndex((letter, i) => i + 1 < letters.length && letter !== letters[i + 1]);
  if (index >= 0) [letters[index], letters[index + 1]] = [letters[index + 1]!, letters[index]!];
  return [changedUnit, letters.join(''), `${text}0`];
}

export function checkChoices(
  value: unknown,
  nearby: unknown[],
  type: PairFieldType,
): IngestSpotCheck['choices'] {
  // Binary fields require a supplied value instead of a yes-or-no choice.
  if (type === 'boolean') return [];
  const unique: IngestSpotCheck['choices'] = [];
  for (const candidate of [value, nearby[0], ...nearMisses(value, type), ...nearby.slice(1)]) {
    if (candidate === undefined || unique.some((other) => pairValuesEqual(candidate, other, type))) continue;
    unique.push(candidate as IngestSpotCheck['choices'][number]);
    if (unique.length === 4) break;
  }
  for (let index = unique.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [unique[index], unique[other]] = [unique[other]!, unique[index]!];
  }
  return unique;
}

/** Surrounding content comes from extraction, never from a drafted row or its quoted model sources. */
export function surroundingContent(source: ExtractedSource, at: RowLocation): string {
  if (at.page !== undefined)
    return source.pages?.find((page) => page.number === at.page)?.text.slice(0, 16_000) ?? '';
  const rows =
    at.table !== undefined
      ? source.email?.tables[at.table - 1]?.map((row) => row.map((value) => ({ v: value })))
      : source.sheets?.find((sheet) => sheet.name === at.sheet)?.rows;
  const index = (at.row ?? 1) - 1;
  return (
    rows
      ?.slice(Math.max(0, index - 1), index + 2)
      .map((row) => row.map((cell) => cell.v ?? '').join('\t'))
      .join('\n')
      .slice(0, 16_000) ?? ''
  );
}

/** Existing checks retain their choices while structural corrections fill gaps with current cells. */
export function chooseChecks(
  rows: IngestDraftRow[],
  fields: DraftField[],
  covered: Set<string>,
  source: ExtractedSource,
  existing: IngestSpotCheck[] = [],
): IngestSpotCheck[] {
  const cells = rows.flatMap((row, index) => fields.map((field) => ({ row, index, field })));
  const missingRequired = new Set(
    fields.filter((field) => field.required && !covered.has(field.key)).map((field) => field.key),
  );
  const count = Math.min(5, cells.length);
  const checks = existing.filter((check) =>
    cells.some((cell) => cell.row.id === check.rowId && cell.field.key === check.field),
  );
  const chosen = cells.filter((cell) =>
    checks.some((check) => cell.row.id === check.rowId && cell.field.key === check.field),
  );
  const usedRows = new Map<string, number>();
  const usedFields = new Set(covered);
  for (const { row, field } of chosen) {
    usedFields.add(field.key);
    usedRows.set(row.id, (usedRows.get(row.id) ?? 0) + 1);
  }
  const retained = chosen.length;
  const priority = ({ row, field }: (typeof cells)[number]) =>
    row.doubts.includes(field.key)
      ? 0
      : field.required && !usedFields.has(field.key)
        ? 1
        : field.required
          ? 2
          : 3;
  const outstanding = () =>
    new Set([...missingRequired].filter((key) => !chosen.some((cell) => cell.field.key === key)));
  while (chosen.length < count || (cells.length > 0 && outstanding().size)) {
    const needed = outstanding();
    const coverageOnly = chosen.length >= count;
    const remaining = cells.filter(
      (cell) => !chosen.includes(cell) && (!coverageOnly || needed.has(cell.field.key)),
    );
    remaining.sort(
      (left, right) =>
        priority(left) - priority(right) ||
        (usedFields.has(left.field.key) ? 1 : 0) - (usedFields.has(right.field.key) ? 1 : 0) ||
        (usedRows.get(left.row.id) ?? 0) - (usedRows.get(right.row.id) ?? 0) ||
        left.index - right.index,
    );
    const next = remaining[0]!;
    chosen.push(next);
    usedFields.add(next.field.key);
    usedRows.set(next.row.id, (usedRows.get(next.row.id) ?? 0) + 1);
  }
  for (const { row, index, field } of chosen.slice(retained)) {
    const id = randomUUID();
    const nearby = rows
      .map((other, otherIndex) => ({ other, distance: Math.abs(otherIndex - index) }))
      .filter(({ other }) => other.id !== row.id)
      .sort((left, right) => left.distance - right.distance)
      .map(({ other }) => other.values[field.key]);
    const choices = checkChoices(row.values[field.key] ?? null, nearby, field.type);
    // Equivalent alternatives on adjacent questions must not repeat the same order.
    const previous = checks.at(-1)?.choices;
    if (
      previous?.length === choices.length &&
      choices.length > 1 &&
      choices.every((value, i) => pairValuesEqual(value, previous[i], field.type))
    )
      choices.push(choices.shift()!);
    checks.push({
      id,
      rowId: row.id,
      field: field.key,
      name: field.name,
      meaning: field.meaning,
      at: row.at,
      content: surroundingContent(source, row.at),
      choices,
      noneMessageId: 'ingest.drafts.none',
      passed: false,
    });
  }
  return checks;
}
