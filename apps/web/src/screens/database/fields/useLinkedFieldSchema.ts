import { useEffect, useState } from 'react';
import type { DatabaseSchema, FieldSpec, LinkTarget } from '@riosoma/contracts';
import { api, ApiError } from '../../../api';
import type { SchemaState } from '../../../data';

/** Destination metadata belongs to this editing session and follows the reader's own permissions. */
export function useLinkedFieldSchema(source: SchemaState | undefined, spec: FieldSpec) {
  const link =
    spec.type === 'lookup' || spec.type === 'rollup' || spec.type === 'count'
      ? source?.fieldById.get(spec.options.linkFieldId)
      : spec;
  const tableId =
    link?.type === 'link' || link?.type === 'lineItems' ? link.options.linkedTableId : undefined;
  const externalId = tableId && !source?.tableById.has(tableId) ? tableId : undefined;
  const [loaded, setLoaded] = useState<{ tableId: string; schema?: DatabaseSchema; error?: string }>();
  useEffect(() => {
    if (!externalId) return;
    const controller = new AbortController();
    void api<LinkTarget>(`/api/tables/${externalId}/link-target`, { signal: controller.signal })
      .then((target) =>
        api<DatabaseSchema>(`/api/databases/${target.database.id}/schema`, { signal: controller.signal }),
      )
      .then((schema) => {
        if (!controller.signal.aborted) setLoaded({ tableId: externalId, schema });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoaded({
            tableId: externalId,
            error: error instanceof ApiError ? error.info.messageKey : 'errors.offline',
          });
      });
    return () => controller.abort();
  }, [externalId]);
  const current = loaded?.tableId === externalId ? loaded : undefined;
  if (!source || !externalId || !current?.schema) return { schema: source, error: current?.error };
  const target = current.schema.tables.find((table) => table.id === externalId);
  if (!target) return { schema: source, error: 'errors.notFound' };
  const targetFields = current.schema.fields.filter((field) => field.tableId === externalId);
  const targetViews = current.schema.views.filter((view) => view.tableId === externalId);
  return {
    schema: {
      ...source,
      tableById: new Map([...source.tableById, [externalId, target]]),
      fields: new Map([...source.fields, [externalId, targetFields]]),
      fieldById: new Map([...source.fieldById, ...targetFields.map((field) => [field.id, field] as const)]),
      views: new Map([...source.views, [externalId, targetViews]]),
      viewById: new Map([...source.viewById, ...targetViews.map((view) => [view.id, view] as const)]),
    },
  };
}
