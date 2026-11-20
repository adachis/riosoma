import { useId, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  faChartColumn,
  faEllipsis,
  faTable,
  faPen,
  faCopy,
  faTrashCan,
} from '@fortawesome/free-solid-svg-icons';
import type { Tile, DashboardSlice } from '@riosoma/contracts';
import { Button, LayoutDragItem, Menu, MenuItem, MenuTrigger, Spinner } from '@riosoma/ui';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import type { FormatContext } from '../../../grid/format';
import { SERVER_MESSAGES } from '../../../messages/server';
import { serverMessage } from '../../../messages/useServerMessage';
import type { TileState } from './data';
import { KIND_LABELS } from './messages';
import { PivotTable } from '../views/pivot/PivotTable';
import { NoteText } from './NoteText';
import { ChartBody, NumberBody, RecordsBody } from './TileBodies';

/** What every tile on a dashboard shares: where its data comes from and what it can do. */
export interface TileContext {
  session: DatabaseSession;
  schema: SchemaState;
  format: FormatContext;
  canEdit: boolean;
  /** False once the dashboard holds as many tiles as it can */
  canAdd: boolean;
  states: ReadonlyMap<string, TileState>;
  onEdit(tile: Tile): void;
  onDuplicate(tile: Tile): void;
  onDelete(tile: Tile): void;
  onRetry(tileId: string): void;
  onOpenRecord(tableId: string, recordId: string): void;
  /** Opens the records behind a chart part or pivot cell */
  onDrill?(tile: Extract<Tile, { kind: 'chart' | 'pivot' }>, slice: DashboardSlice): void;
  /** The record's own address, for opening it in a new tab */
  recordHref(tableId: string, viewId: string | null, recordId: string): string;
}

export interface DashboardTileProps {
  tile: Tile;
  context: TileContext;
  /** Laying out: the tile shows handles and its contents stop taking the pointer */
  editing: boolean;
  dragging: boolean;
  /** Describes the arrow keys on the handle */
  helpId: string;
  onHandleKeyDown(event: KeyboardEvent<HTMLButtonElement>, tile: Tile): void;
  onDragStart(event: PointerEvent<HTMLElement>, tile: Tile, mode: 'move' | 'resize'): void;
  movement?: {
    name: string;
    up?: () => void;
    down?: () => void;
    destinations: ReadonlyArray<{ id: string; name: string; move(): void }>;
  };
}

/** The name a tile shows: its title, or the kind of tile it is. */
export function useTileName(tile: Tile): string {
  const { i18n } = useLingui();
  return tile.title.trim() || i18n._(KIND_LABELS[tile.kind]);
}

function tileMessage(
  i18n: ReturnType<typeof useLingui>['i18n'],
  state: Extract<TileState, { status: 'error' }>,
) {
  // The server words its own reasons.  One the app doesn't know yet reads as a plain failure.
  const key =
    SERVER_MESSAGES[state.messageKey] || !state.messageKey.startsWith('dashboards.')
      ? state.messageKey
      : 'dashboards.tile.failed';
  return serverMessage(i18n, key, state.params);
}

function TileBody({
  tile,
  context,
  asTable,
  name,
}: {
  tile: Tile;
  context: TileContext;
  asTable: boolean;
  name: string;
}) {
  const { t, i18n } = useLingui();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  if (tile.kind === 'text') return <NoteText text={tile.text} />;
  const state = context.states.get(tile.id);
  if (!state || state.status === 'loading')
    return (
      <div className="rio-dashboard-tile__status">
        <Spinner size="sm" />
      </div>
    );
  if (
    state.status === 'error' &&
    tile.kind === 'pivot' &&
    state.messageKey.startsWith('dashboards.tile.') &&
    state.messageKey !== 'dashboards.tile.failed'
  )
    return (
      <div className="rio-dashboard-tile__status">
        <p>
          {context.canEdit
            ? t({
                id: 'dashboards.tile.attention',
                message: 'This tile needs attention.  Edit it to choose fields you can see.',
              })
            : t({ id: 'dashboards.tile.attention.reader', message: 'This tile needs attention.' })}
        </p>
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="rio-dashboard-tile__status">
        <p>{tileMessage(i18n, state)}</p>
        <Button size="sm" onPress={() => context.onRetry(tile.id)}>
          {t({ id: 'dashboards.tile.retry', message: 'Try again' })}
        </Button>
      </div>
    );
  const table = context.schema.tableById.get(tile.source.tableId);
  const fields = context.schema.fields.get(tile.source.tableId) ?? [];
  const { data } = state;
  if (tile.kind === 'number' && data.kind === 'number')
    return (
      <NumberBody
        tile={tile}
        value={data.value}
        records={data.records}
        fields={fields}
        format={context.format}
      />
    );
  if (tile.kind === 'chart' && data.kind === 'chart')
    return (
      <ChartBody
        tile={tile}
        data={data}
        fields={fields}
        format={context.format}
        label={name}
        asTable={asTable}
        onPick={context.onDrill ? (slice) => context.onDrill!(tile, slice) : undefined}
      />
    );
  if (tile.kind === 'pivot' && data.kind === 'pivot')
    return (
      <PivotTable
        data={data}
        settings={tile.pivot}
        fields={fields}
        format={context.format}
        label={name}
        popup="dialog"
        refreshing={state.refreshing}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        onPick={(target) =>
          context.onDrill?.(tile, {
            row: target.row,
            ...(target.column === undefined ? {} : { column: target.column }),
          })
        }
      />
    );
  if (tile.kind === 'records' && data.kind === 'records' && table)
    return (
      <RecordsBody
        tile={tile}
        data={data}
        table={table}
        fields={fields}
        format={context.format}
        hrefFor={(recordId) => context.recordHref(table.id, tile.source.viewId, recordId)}
        onOpen={(recordId) => context.onOpenRecord(table.id, recordId)}
      />
    );
  // Data for an earlier version of the tile: the fresh load is on its way.
  return (
    <div className="rio-dashboard-tile__status">
      <Spinner size="sm" />
    </div>
  );
}

export function DashboardTile({
  tile,
  context,
  editing,
  dragging,
  helpId,
  onHandleKeyDown,
  onDragStart,
  movement,
}: DashboardTileProps) {
  const { t } = useLingui();
  const titleId = useId();
  const name = useTileName(tile);
  const [asTable, setAsTable] = useState(false);
  const state = tile.kind === 'text' ? undefined : context.states.get(tile.id);
  const busy =
    tile.kind !== 'text' &&
    (!state || state.status === 'loading' || (state.status === 'ready' && state.refreshing));
  const { x, y, w, h } = tile.place;
  const style = {
    '--rio-dashboard-x': x + 1,
    '--rio-dashboard-y': y + 1,
    '--rio-dashboard-w': w,
    '--rio-dashboard-h': h,
  } as CSSProperties;
  return (
    <LayoutDragItem
      enabled={editing}
      label={t({ id: 'dashboards.tile.handle', message: `Move or resize ${name}` })}
      descriptionId={helpId}
      onKeys={(event) => onHandleKeyDown(event, tile)}
      onMove={(event) => onDragStart(event, tile, 'move')}
      movement={movement}
      className="rio-dashboard-tile"
      style={style}
      aria-labelledby={titleId}
      data-tile={tile.id}
      data-kind={tile.kind}
      data-editing={editing || undefined}
      data-dragging={dragging || undefined}
    >
      <header className="rio-dashboard-tile__header">
        <h3 id={titleId} className="rio-dashboard-tile__title" title={name}>
          {name}
        </h3>
        {tile.kind === 'chart' && state?.status === 'ready' ? (
          <Button
            variant="quiet"
            size="sm"
            icon={asTable ? faChartColumn : faTable}
            aria-label={
              asTable
                ? t({ id: 'dashboards.tile.showChart', message: 'Show as chart' })
                : t({ id: 'dashboards.tile.showTable', message: 'Show as table' })
            }
            onPress={() => setAsTable(!asTable)}
          />
        ) : null}
        {context.canEdit ? (
          <MenuTrigger>
            <Button
              className="rio-dashboard-tile__menu"
              variant="quiet"
              size="sm"
              icon={faEllipsis}
              aria-label={t({ id: 'database.sidebar.menu', message: `More for ${name}` })}
            />
            <Menu aria-label={t({ id: 'database.sidebar.menu', message: `More for ${name}` })}>
              <MenuItem icon={faPen} onAction={() => context.onEdit(tile)}>
                {t({ id: 'dashboards.tile.edit', message: 'Edit' })}
              </MenuItem>
              <MenuItem icon={faCopy} isDisabled={!context.canAdd} onAction={() => context.onDuplicate(tile)}>
                {t({ id: 'dashboards.tile.duplicate', message: 'Duplicate' })}
              </MenuItem>
              <MenuItem icon={faTrashCan} tone="danger" onAction={() => context.onDelete(tile)}>
                {t({ id: 'dashboards.tile.delete', message: 'Delete' })}
              </MenuItem>
            </Menu>
          </MenuTrigger>
        ) : null}
      </header>
      <div className="rio-dashboard-tile__body" aria-busy={busy || undefined}>
        <TileBody tile={tile} context={context} asTable={asTable} name={name} />
      </div>
      {editing ? (
        <>
          {tile.kind !== 'text' ? <div className="rio-dashboard-tile__shield" aria-hidden="true" /> : null}
          <div
            className="rio-dashboard-tile__resize"
            aria-hidden="true"
            onPointerDown={(event) => onDragStart(event, tile, 'resize')}
          />
        </>
      ) : null}
    </LayoutDragItem>
  );
}
