import { isSparklineField, sparklineKey, type Sparkline } from '@riosoma/contracts';
import type { Queryable } from '@riosoma/db';
import type { AccessScope } from './access.js';
import type { DataSchemas } from './context.js';
import { loadFields } from './metadata.js';
import type { StoredField } from './types.js';

/** Resolve ordering once per page, under the same field and record scope as the cell itself. */
export async function sparklineFields(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  fields: readonly StoredField[],
  settings: readonly Sparkline[],
): Promise<StoredField[]> {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const tables = [
    ...new Set(
      settings.flatMap((setting) => {
        const field = byId.get(setting.fieldId);
        return setting.order && field?.relation ? [field.relation.linkedTableId] : [];
      }),
    ),
  ];
  const linked = await loadFields(db, schemas, tables);
  const dependencies = new Map(
    tables
      .flatMap((tableId) =>
        scope.visibleFields(
          tableId,
          linked.filter((field) => field.tableId === tableId),
        ),
      )
      .map((field) => [field.id, field]),
  );
  return fields.map((field) => {
    if (!isSparklineField(field) || !field.relation) return field;
    const unique = [...new Map(settings.map((setting) => [sparklineKey(setting), setting])).values()];
    const sources = unique
      .filter((setting) => setting.fieldId === field.id)
      .flatMap((setting) => {
        const order = setting.order ? dependencies.get(setting.order.fieldId) : undefined;
        if (setting.order && (!order || order.tableId !== field.relation!.linkedTableId)) return [];
        if (field.type !== 'lookup' && field.type !== 'rollup') return [];
        return [
          {
            key: sparklineKey(setting),
            field: {
              ...field,
              type: 'lookup' as const,
              options: {
                ...field.options,
                resultType: 'array' as const,
                sort: setting.order ? [setting.order] : [],
              },
              relation: {
                ...field.relation!,
                conditionFields: [...(field.relation!.conditionFields ?? []), ...(order ? [order] : [])],
              },
            },
          },
        ];
      });
    return sources.length ? { ...field, sparklineSources: sources } : field;
  });
}
