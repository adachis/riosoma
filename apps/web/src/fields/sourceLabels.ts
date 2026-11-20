import type { Choice, FieldMeta } from '@riosoma/contracts';
import { api } from '../api';

/** Resolve only the names this paste or import needs, including names outside the picker page. */
export async function withSourceLabels(
  field: FieldMeta,
  texts: readonly string[],
  signal?: AbortSignal,
  checked: Set<string> = new Set(),
): Promise<FieldMeta> {
  if ((field.type !== 'singleSelect' && field.type !== 'multipleSelect') || !field.options.source)
    return field;
  const known = new Set(field.options.choices.map((choice) => choice.name.trim().toLowerCase()));
  const names = [
    ...new Set(
      texts
        .flatMap((text) => (field.type === 'multipleSelect' ? text.split(/[\r\n,]+/) : [text]))
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name && !known.has(name.toLowerCase()) && !checked.has(name.toLowerCase())),
    ),
  ];
  if (!names.length) return field;
  const choices = new Map(field.options.choices.map((choice) => [choice.id, choice]));
  for (let start = 0; start < names.length; start += 50) {
    const query = new URLSearchParams({ names: JSON.stringify(names.slice(start, start + 50)) });
    const page = await api<{ choices: Choice[] }>(`/api/fields/${field.id}/select-options?${query}`, {
      signal,
    });
    for (const choice of page.choices) choices.set(choice.id, choice);
    for (const name of names.slice(start, start + 50)) checked.add(name);
  }
  return { ...field, options: { ...field.options, choices: [...choices.values()] } };
}

/** Buffer a bounded page so imports resolve each distinct name once, including unavailable names. */
export async function* sourceLabelRows<T>(
  rows: AsyncIterable<T>,
  columns: Array<{ include: boolean; field: FieldMeta; sourceNames?: { key: string; names: Set<string> } }>,
  texts: (row: T, index: number) => string,
  header: boolean,
): AsyncGenerator<T> {
  const sources = columns
    .map((column, index) => ({ column, index }))
    .filter(
      ({ column }) =>
        column.include &&
        (column.field.type === 'singleSelect' || column.field.type === 'multipleSelect') &&
        column.field.options.source,
    );
  if (!sources.length) {
    yield* rows;
    return;
  }
  const resolve = async (page: T[]) => {
    for (const { column, index } of sources) {
      const key = JSON.stringify([
        column.field.id,
        'source' in column.field.options ? column.field.options.source : null,
      ]);
      if (column.sourceNames?.key !== key) column.sourceNames = { key, names: new Set() };
      column.field = await withSourceLabels(
        column.field,
        page.map((row) => texts(row, index)),
        undefined,
        column.sourceNames.names,
      );
    }
  };
  let page: T[] = [];
  let first = true;
  for await (const row of rows) {
    if (first) {
      first = false;
      if (header) {
        yield row;
        continue;
      }
    }
    page.push(row);
    if (page.length < 500) continue;
    await resolve(page);
    yield* page;
    page = [];
  }
  if (page.length) {
    await resolve(page);
    yield* page;
  }
}
