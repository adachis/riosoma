import {
  sameValue,
  isOverrideType,
  type Override,
  type CellValue,
  type FieldMeta,
  type RowData,
  type TableSource,
  type TableSourceSettings,
} from '@riosoma/contracts';

export function queuedSource(settings: TableSourceSettings): TableSource {
  return {
    ...settings,
    sourceName: '',
    sourceKind: 'postgres',
    status: {
      state: 'queued',
      lastSyncAt: null,
      lastSuccessAt: null,
      nextSyncAt: null,
      error: null,
      stats: null,
      held: null,
    },
  };
}

/** Preserve the original source value across successive local edits. */
export function overrideValues(
  row: RowData,
  values: Record<string, CellValue>,
  fields: ReadonlyMap<string, FieldMeta>,
  by: string | null,
  at: string,
): RowData {
  const overrides = { ...row.overrides };
  for (const [id, value] of Object.entries(values)) {
    const field = fields.get(id);
    if (!field || (!field.source && !isOverrideType(field.type))) continue;
    const source = overrides[id] ? overrides[id].source : (row.values[id] ?? null);
    if (sameValue(source, value)) delete overrides[id];
    else overrides[id] = { source, by, at, ...(isOverrideType(field.type) ? { value } : {}) };
  }
  return { ...row, values: { ...row.values, ...values }, overrides, updatedBy: by, updatedAt: at };
}
export function clearOverrides(row: RowData, fieldIds: readonly string[]): RowData {
  const overrides = { ...row.overrides };
  const values = { ...row.values };
  for (const id of fieldIds) {
    if (!overrides[id]) continue;
    values[id] = overrides[id].source;
    delete overrides[id];
  }
  return { ...row, values, overrides };
}

export function patchOverrides(
  row: RowData,
  patch: Record<string, Override | null> | undefined,
): RowData['overrides'] {
  if (!patch) return row.overrides;
  const overrides = { ...row.overrides };
  for (const [id, value] of Object.entries(patch)) {
    if (value === null) delete overrides[id];
    else overrides[id] = value;
  }
  return overrides;
}

export function overridePatch(before: RowData, after: RowData): Record<string, Override | null> {
  return Object.fromEntries(
    [...new Set([...Object.keys(before.overrides ?? {}), ...Object.keys(after.overrides ?? {})])]
      .filter((id) => JSON.stringify(before.overrides?.[id]) !== JSON.stringify(after.overrides?.[id]))
      .map((id) => [id, after.overrides?.[id] ?? null]),
  );
}
