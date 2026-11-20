import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import {
  OTHER_GROUP_KEY,
  type FieldMeta,
  type GroupKey,
  type Tile,
  type DashboardSlice,
  type DashboardFilters,
  type PivotAggregate,
} from '@riosoma/contracts';
import { Dialog, DialogBody, DialogFooter, DialogTitle, Drawer } from '@riosoma/ui';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import type { FormatContext } from '../../../grid/format';
import { serverMessage } from '../../../messages/useServerMessage';
import { databaseHref } from '../screen/routes';
import { navigateOnPlainClick } from '../shell/navigation';
import { RecordsList, RecordsRefusal, useRecordPages, type RecordsCopy } from '../views/summary/RecordsPanel';
import type { ChartData } from './chart-option';
import { personTimeZone } from './data';
import { EMPTY, OTHER } from './messages';

type DrillTile = Extract<Tile, { kind: 'chart' | 'pivot' }>;

export interface DrillDrawerProps {
  session: DatabaseSession;
  schema: SchemaState;
  dashboardId: string;
  tile: DrillTile;
  slice: DashboardSlice;
  filters?: DashboardFilters;
  /** The tile's data while it's loaded, which names the part and reloads the list when it changes */
  data: ChartData | PivotAggregate | undefined;
  format: FormatContext;
  onOpenRecord(tableId: string, recordId: string): void;
  /** Opens a grid view narrowed by a `where` token.  Without it, the link is followed as usual. */
  onOpenView?(tableId: string, viewId: string, where: string): void;
  onClose(): void;
}

/** The server's reason a part can't list, kept apart from a passing failure that's worth retrying. */
const PASSING = new Set(['errors.unavailable']);

/** How many times a value was replaced by a fresh one, not counting when it first arrives. */
function useChangeCount(value: unknown): number {
  const last = useRef(value);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (value === last.current) return;
    const replaced = last.current !== undefined;
    last.current = value;
    if (replaced) setCount((previous) => previous + 1);
  }, [value]);
  return count;
}

/** A group's name, from the chart when it has loaded, or from the field's own choices and people. */
function groupName(
  key: GroupKey,
  field: FieldMeta | undefined,
  known: ReadonlyArray<{ key: GroupKey; label: string }> | undefined,
  words: { empty: string; other: string },
  schema: SchemaState,
): string {
  if (key === OTHER_GROUP_KEY) return words.other;
  if (key === null) return words.empty;
  const label = known?.find((item) => item.key === key)?.label;
  if (label) return label;
  if (field && (field.type === 'singleSelect' || field.type === 'multipleSelect'))
    return field.options.choices.find((choice) => choice.id === key)?.name ?? String(key);
  if (field && (field.type === 'user' || field.type === 'createdBy' || field.type === 'lastModifiedBy'))
    return schema.collaborators.get(String(key))?.name ?? String(key);
  return String(key);
}

/**
 * The records behind a chart part or pivot cell, in a sheet over the dashboard: the
 * same list the chart and pivot views use, a page at a time, with a link that opens the records in
 * a grid view filtered the same way.  Escape or the close button puts it away.
 */
export function DrillDrawer({
  session,
  schema,
  dashboardId,
  tile,
  slice,
  filters,
  data,
  format,
  onOpenRecord,
  onOpenView,
  onClose,
}: DrillDrawerProps) {
  const { t, i18n } = useLingui();
  const tableId = tile.source.tableId;
  const table = schema.tableById.get(tableId);
  const fields = schema.fields.get(tableId) ?? [];
  const field = (id: string | null | undefined) => fields.find((item) => item.id === id);
  const [open, setOpen] = useState<{ viewId: string; where: string } | null | undefined>(undefined);
  const place = JSON.stringify([tile.id, slice, filters]);
  const version = useChangeCount(data);
  const pages = useRecordPages(place, version, async (offset, limit, signal) => {
    const answer = await session.dashboardTileRecords(
      dashboardId,
      tile.id,
      { timeZone: personTimeZone(), slice, offset, limit, ...(filters ? { filters } : {}) },
      signal,
    );
    if (answer.kind === 'error') {
      const words = serverMessage(i18n, answer.messageKey, answer.params);
      throw PASSING.has(answer.messageKey) ? new Error(answer.messageKey) : new RecordsRefusal(words);
    }
    if (offset === 0) setOpen(answer.open);
    return answer;
  });

  const words = { empty: i18n._(EMPTY), other: i18n._(OTHER) };
  const groupField = field(tile.kind === 'chart' ? tile.groupBy.fieldId : null);
  const seriesField = field(tile.kind === 'chart' ? tile.seriesBy : null);
  const part = (
    target: FieldMeta | undefined,
    key: GroupKey,
    known?: Array<{ key: GroupKey; label: string }>,
  ) => {
    const name = target?.name ?? '';
    if (key === null) return t({ id: 'dashboards.drill.isEmpty', message: `${name} is empty` });
    const value = groupName(key, target, known, words, schema);
    return t({ id: 'dashboards.drill.is', message: `${name} is ${value}` });
  };
  const categoryPart =
    'category' in slice
      ? part(groupField, slice.category, data?.kind === 'chart' ? data.categories : undefined)
      : '';
  const pivotParts =
    tile.kind === 'pivot' && 'row' in slice
      ? [
          ...slice.row.map((key, index) => {
            const row =
              data?.kind === 'pivot'
                ? data.rows.find(
                    (row) =>
                      row.keys.length === index + 1 && row.keys.every((part, at) => part === slice.row[at]),
                  )
                : undefined;
            return part(
              field(tile.pivot.rows[index]?.fieldId),
              key,
              row ? [{ key, label: row.label }] : undefined,
            );
          }),
          ...(slice.column === undefined
            ? []
            : [
                part(
                  field(tile.pivot.column?.fieldId),
                  slice.column,
                  data?.kind === 'pivot' ? data.columns : undefined,
                ),
              ]),
        ]
      : [];
  const sliceName =
    'row' in slice
      ? pivotParts.length
        ? pivotParts.reduce((left, right) =>
            t({ id: 'dashboards.drill.pivotAnd', message: `${left} and ${right}` }),
          )
        : t({ id: 'views.pivot.everything', message: 'Every record' })
      : slice.series === undefined
        ? categoryPart
        : t({
            id: 'dashboards.drill.and',
            message: `${categoryPart} and ${part(seriesField, slice.series, data?.kind === 'chart' ? data.series : undefined)}`,
          });
  const current = pages.current && !('failed' in pages.current) ? pages.current : null;
  const total = current?.total;
  const title =
    total === undefined
      ? sliceName
      : t({
          id: 'dashboards.drill.title',
          message: plural(total, { one: `${sliceName}, # record`, other: `${sliceName}, # records` }),
        });

  const copy: RecordsCopy = useMemo(
    () => ({
      count: (count) =>
        t({ id: 'dashboards.drill.count', message: plural(count, { one: '# record', other: '# records' }) }),
      // The sheet's own close button carries this word.
      close: t({ id: 'ui.dialog.close', message: 'Close' }),
      more: t({ id: 'dashboards.drill.more', message: 'Show more records' }),
      untitled: t({ id: 'record.untitled', message: 'Untitled record' }),
      none: t({ id: 'dashboards.drill.none', message: 'No records are in this part of the chart now.' }),
      failed: t({ id: 'dashboards.drill.failed', message: 'These records couldn’t load.' }),
      retry: t({ id: 'dashboards.tile.retry', message: 'Try again' }),
    }),
    [t],
  );
  // The values the tile reads, beside each record's name.  Links and files have no short form.
  const shown = (
    tile.kind === 'chart'
      ? [tile.groupBy.fieldId, tile.seriesBy, tile.value.fieldId]
      : [
          ...tile.pivot.rows.map((group) => group.fieldId),
          tile.pivot.column?.fieldId,
          ...tile.pivot.values.map((value) => value.fieldId),
        ]
  )
    .filter((id, index, ids): id is string => Boolean(id) && ids.indexOf(id) === index)
    .flatMap((id) => {
      const item = field(id);
      return item && item.id !== table?.primaryFieldId && item.type !== 'link' && item.type !== 'attachment'
        ? [item]
        : [];
    });
  const view = open ? schema.viewById.get(open.viewId) : undefined;
  const openHref =
    open && view
      ? `${databaseHref(session.databaseId, tableId, open.viewId)}?${new URLSearchParams({ where: open.where }).toString()}`
      : null;
  const viewName = view?.name ?? '';

  return (
    <Drawer
      isOpen
      isDismissable
      className="rio-dashboard-drill"
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <Dialog className="rio-dashboard-drill__dialog" aria-busy={!pages.loaded || undefined}>
        <DialogTitle>{title}</DialogTitle>
        <DialogBody className="rio-dashboard-drill__body">
          {table ? (
            <RecordsList
              prefix="rio-dashboard-drill"
              pages={pages}
              table={table}
              fields={fields}
              shown={shown}
              format={format}
              copy={copy}
              count={false}
              hrefFor={(recordId) =>
                databaseHref(session.databaseId, tableId, schema.views.get(tableId)?.[0]?.id, recordId)
              }
              onOpen={(recordId) => onOpenRecord(tableId, recordId)}
            />
          ) : null}
        </DialogBody>
        {open !== undefined && current ? (
          <DialogFooter className="rio-dashboard-drill__footer">
            {openHref ? (
              <a
                className="rio-dashboard-drill__open"
                href={openHref}
                onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                  if (onOpenView && open)
                    navigateOnPlainClick(event, () => onOpenView(tableId, open.viewId, open.where));
                }}
              >
                {t({ id: 'dashboards.drill.open', message: `Open in ${viewName}` })}
              </a>
            ) : (
              <p className="rio-dashboard-drill__note">
                {t({
                  id: 'dashboards.drill.noView',
                  message:
                    'No grid view of this table can show exactly these records, so they’re listed only here.',
                })}
              </p>
            )}
          </DialogFooter>
        ) : null}
      </Dialog>
    </Drawer>
  );
}
