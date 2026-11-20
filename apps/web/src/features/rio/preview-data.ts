import {
  cellValue,
  filtersFor,
  type InterfaceRecordsRequest,
  type RioPlanPreview,
  type RowData,
  type TileData,
} from '@riosoma/contracts';
import { ApiError } from '../../api';
import type { Http } from '../../data/deps';

const unavailable = () =>
  new ApiError(404, { code: 'not_found', messageKey: 'errors.notFound', userFault: true });

/** Every preview read is answered from the access-scoped snapshot, with no network fallback. */
export function previewHttp(snapshot: RioPlanPreview): Http {
  const rowsOf = (data: TileData | undefined): RowData[] => {
    if (!data || data.kind !== 'records') throw unavailable();
    return data.rows;
  };
  const page = (rows: RowData[], offset: number, limit: number) => ({
    snapshot: 'preview',
    total: rows.length,
    offset,
    rows: rows.slice(offset, offset + limit),
    rebuilt: false,
    linked: {},
  });
  const read = (path: string, body: unknown): unknown => {
    const [pathname, search = ''] = path.split('?');
    const parts = pathname!.split('/');
    const query = new URLSearchParams(search);
    if (pathname === `/api/databases/${snapshot.schema.database.id}/schema`)
      return {
        ...structuredClone(snapshot.schema),
        database: { ...snapshot.schema.database, role: 'reader' },
      };
    if (parts[2] === 'databases' && parts[4] === 'views' && parts[6] === 'aggregate') {
      if (body && typeof body === 'object' && 'records' in body && body.records) throw unavailable();
      return snapshot.aggregates?.[parts[5]!] ?? { kind: 'error', messageKey: 'dashboards.tile.unavailable' };
    }
    if (parts[2] === 'dashboards' && parts[4] === 'data')
      return snapshot.dashboards[parts[3]!] ?? { tiles: {} };
    if (parts[2] === 'interfaces') {
      const input = body as InterfaceRecordsRequest;
      const key = `${parts[3]}/${input.pageId}`;
      if (parts[4] === 'data') return snapshot.interfaces[key] ?? { blocks: {} };
      if (parts[4] === 'records') {
        let rows = rowsOf(snapshot.records[`${key}/${input.blockId}`]);
        const interfacePage = snapshot.schema.interfaces
          ?.find((item) => item.id === parts[3])
          ?.pages.find((item) => item.id === input.pageId);
        const block = interfacePage?.blocks.find((item) => item.id === input.blockId);
        if (!interfacePage || block?.kind !== 'records') throw unavailable();
        for (const filter of filtersFor(interfacePage, block)) {
          const chosen = input.filters?.[filter.id];
          const field = snapshot.schema.fields.find((item) => item.id === filter.fieldId);
          if (!field || chosen === undefined || chosen === '') continue;
          rows = rows.filter((row) => {
            const value = cellValue(row, field);
            if (filter.control === 'search')
              return String(value ?? '')
                .toLocaleLowerCase()
                .includes(String(chosen).toLocaleLowerCase());
            return Array.isArray(value) ? value.includes(chosen as never) : value === chosen;
          });
        }
        return { ...page(rows, input.offset, input.limit), tableId: block.source.tableId };
      }
    }
    if (parts[2] === 'views' && parts[4] === 'rows') {
      const data = snapshot.views[parts[3]!];
      return {
        ...page(rowsOf(data), Number(query.get('offset') ?? 0), Number(query.get('limit') ?? 100)),
        groups: data?.groups,
        pinnedCount: data?.pinnedCount,
      };
    }
    if (parts[2] === 'tables' && parts[4] === 'records') {
      const views = snapshot.schema.views.filter((view) => view.tableId === parts[3]);
      const rows = views.flatMap((view) =>
        snapshot.views[view.id]?.kind === 'records' ? rowsOf(snapshot.views[view.id]) : [],
      );
      if (parts[5] === 'names') {
        const primary = snapshot.schema.fields.find(
          (field) =>
            field.id === snapshot.schema.tables.find((table) => table.id === parts[3])?.primaryFieldId,
        );
        return Object.fromEntries(
          rows.map((row) => [row.id, primary ? String(cellValue(row, primary) ?? '') : '']),
        );
      }
      const row = rows.find((item) => item.id === parts[5]);
      if (row) return row;
    }
    throw unavailable();
  };
  return async <T>(path: string, options = {}) =>
    structuredClone(read(path, 'body' in options ? options.body : undefined)) as T;
}
