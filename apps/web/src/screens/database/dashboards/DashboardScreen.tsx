import { HelpButton } from '../../../docs/HelpButton';
import { useCallback, useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import { faCheck, faFilter, faPlus, faUpDownLeftRight } from '@fortawesome/free-solid-svg-icons';
import {
  roleAllows,
  type DashboardFilters,
  type DashboardMeta,
  type Tile,
  type TileSource,
} from '@riosoma/contracts';
import { Button, toast } from '@riosoma/ui';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { readRecent } from '../../../palette/recent';
import { undoAction, undoToast } from '../../../grid/view/actions';
import { serverMessage } from '../../../messages/useServerMessage';
import { databaseHref } from '../screen/routes';
import { MAX_TILES, newTileId, TILE_SIZES, useDashboardConfig } from './config';
import { useDashboardData, REFRESH_DELAY } from './data';
import { DashboardGrid } from './DashboardGrid';
import { DashboardRecord } from './DashboardRecord';
import { DashboardFilterDialog } from './DashboardFilterDialog';
import type { TileContext } from './DashboardTile';
import { drillToken, parseDrill } from './drill';
import { DrillDrawer } from './DrillDrawer';
import { firstFreeSpace } from './layout';
import { KIND_LABELS } from './messages';
import { TileEditor, type TileContent } from './TileEditor';
import { ResponsiveToolbar, type ResponsiveToolbarItem } from '../../../components/ResponsiveToolbar';
import './dashboards.css';

export interface DashboardScreenProps {
  session: DatabaseSession;
  schema: SchemaState;
  dashboard: DashboardMeta;
  /** How long record changes settle before tiles refresh */
  refreshDelay?: number;
  /** Dashboard conditions and date ranges, narrowed separately for each source table. */
  filters?: DashboardFilters;
  onFiltersChange?(filters: DashboardFilters): void;
  /**
   * The part of a chart whose records are open, as a `drill` token (see `drillToken`), when the
   * address keeps it.  Without it, the dashboard keeps the open part itself.
   */
  drill?: string | null;
  onDrillChange?(drill: string | null): void;
  /** Opens a grid view narrowed by a `where` token, from the records behind a chart */
  onOpenView?(tableId: string, viewId: string, where: string): void;
}

/**
 * Where a new tile starts.  First the table or view the person came from, read from the places the
 * command palette remembers and kept only when it still belongs to this database.  Otherwise the
 * table the dashboard's most recent tile reads, and otherwise the database's first table.
 */
function startingSource(schema: SchemaState, tiles: readonly Tile[]): TileSource | null {
  for (const place of readRecent()) {
    if (place.kind === 'views') {
      const view = schema.viewById.get(place.id);
      if (view) return { tableId: view.tableId, viewId: view.id, filter: null };
    }
    if (place.kind === 'tables' && schema.tableById.has(place.id))
      return { tableId: place.id, viewId: null, filter: null };
  }
  for (let index = tiles.length - 1; index >= 0; index--) {
    const tile = tiles[index]!;
    if (tile.kind !== 'text' && schema.tableById.has(tile.source.tableId))
      return { tableId: tile.source.tableId, viewId: null, filter: null };
  }
  const first = schema.tables[0];
  return first ? { tableId: first.id, viewId: null, filter: null } : null;
}

function editable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || Boolean(target.closest('input, textarea, select, [role="textbox"]')))
  );
}

/**
 * A dashboard: its name, then its tiles on a 12-column grid that becomes one column on phones.
 * People who can change the schema add, edit, duplicate, and delete tiles, and lay them out in an
 * edit mode by dragging or with the keyboard.  Every change saves through `dashboard.update`.
 */
export function DashboardScreen({
  session,
  schema,
  dashboard,
  refreshDelay = REFRESH_DELAY,
  filters: linkedFilters,
  onFiltersChange,
  drill: linkedDrill,
  onDrillChange,
  onOpenView,
}: DashboardScreenProps) {
  const { t, i18n } = useLingui();
  const headingId = useId();
  const canEdit = roleAllows(session.role(), 'editSchema');
  const { config, change, save } = useDashboardConfig(session, dashboard);
  const [ownFilters, setOwnFilters] = useState<DashboardFilters>([]);
  const filters = linkedFilters ?? ownFilters;
  const setFilters = onFiltersChange ?? setOwnFilters;
  const queryFilters = filters.length ? filters : undefined;
  const [filtering, setFiltering] = useState(false);
  const { states, retry } = useDashboardData(session, dashboard.id, config.tiles, refreshDelay, queryFilters);
  const [editing, setEditing] = useState(false);
  const [editor, setEditor] = useState<{ tile: Tile | null } | null>(null);
  const [record, setRecord] = useState<{ tableId: string; recordId: string } | null>(null);
  const [ownDrill, setOwnDrill] = useState<string | null>(null);
  const drillText = linkedDrill === undefined ? ownDrill : linkedDrill;
  const setDrill = onDrillChange ?? setOwnDrill;
  const drill = parseDrill(drillText);
  const drillTile = drill ? config.tiles.find((tile) => tile.id === drill.tileId) : undefined;
  const drilled =
    drill &&
    ((drillTile?.kind === 'chart' && 'category' in drill.slice) ||
      (drillTile?.kind === 'pivot' && 'row' in drill.slice))
      ? { tile: drillTile, slice: drill.slice }
      : null;
  const drilledState = drilled ? states.get(drilled.tile.id) : undefined;
  const drilledData =
    drilledState?.status === 'ready' &&
    (drilledState.data.kind === 'chart' || drilledState.data.kind === 'pivot')
      ? drilledState.data
      : undefined;
  // An address that names no chart of this dashboard, such as a deleted tile's, is put right.
  const named = Boolean(drilled);
  useEffect(() => {
    if (drillText && !named) setDrill(null);
  }, [drillText, named, setDrill]);
  const closeDrill = useCallback(() => {
    const tileId = drilled?.tile.id;
    setDrill(null);
    // Focus goes back to what opened the list.  A pointer on a chart leaves nothing focused, so it
    // lands on the tile's own controls instead.
    requestAnimationFrame(() =>
      setTimeout(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        document
          .querySelector<HTMLElement>(`[data-tile="${tileId}"] .rio-dashboard-tile__header button`)
          ?.focus();
      }),
    );
  }, [drilled?.tile.id, setDrill]);
  const layingOut = editing && canEdit && config.tiles.length > 0;
  const full = config.tiles.length >= MAX_TILES;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const format = useMemo(
    () => ({
      locale: i18n.locale || 'en-US',
      timeZone,
      collaborators: schema.collaborators,
      linked: session.linked,
      attachments: session.attachments,
      fieldsById: schema.fieldById,
    }),
    [i18n.locale, timeZone, schema.collaborators, schema.fieldById, session],
  );
  const placeFor = (kind: Tile['kind'], tiles: readonly Tile[], size = TILE_SIZES[kind]) =>
    firstFreeSpace(
      tiles.map((tile) => tile.place),
      size.w,
      size.h,
    );
  const saveTile = (content: TileContent) => {
    const current = editor?.tile;
    setEditor(null);
    if (current)
      change(
        config.tiles.map((tile) =>
          tile.id === current.id ? { ...content, id: tile.id, place: tile.place } : tile,
        ),
      );
    else
      change([...config.tiles, { ...content, id: newTileId(), place: placeFor(content.kind, config.tiles) }]);
  };
  const missingRecord = useCallback(() => {
    setRecord(null);
    toast.show({ tone: 'info', title: serverMessage(i18n, 'errors.notFound') });
  }, [i18n]);
  const context: TileContext = {
    session,
    schema,
    format,
    canEdit,
    canAdd: !full,
    states,
    onEdit: (tile) => {
      save();
      setEditor({ tile });
    },
    onDuplicate: (tile) => {
      const size = { w: tile.place.w, h: tile.place.h };
      change([...config.tiles, { ...tile, id: newTileId(), place: placeFor(tile.kind, config.tiles, size) }]);
    },
    onDelete: (tile) => {
      const name = tile.title.trim() || i18n._(KIND_LABELS[tile.kind]);
      change(config.tiles.filter((item) => item.id !== tile.id));
      undoToast(session, t({ id: 'grid.field.deleted', message: `Deleted ${name}` }));
    },
    onRetry: retry,
    onOpenRecord: (tableId, recordId) => setRecord({ tableId, recordId }),
    onDrill: (tile, slice) => setDrill(drillToken({ tileId: tile.id, slice })),
    recordHref: (tableId, viewId, recordId) =>
      databaseHref(session.databaseId, tableId, viewId ?? schema.views.get(tableId)?.[0]?.id, recordId),
  };
  const undoKeys = (event: KeyboardEvent<HTMLElement>) => {
    // Keys pressed in the tile editor or an open record arrive here through React, but belong to them.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    const key = event.key.toLowerCase();
    if (!(event.metaKey || event.ctrlKey) || event.altKey || editable(event.target)) return;
    if (key !== 'z' && key !== 'y') return;
    event.preventDefault();
    save();
    void undoAction(session, key === 'y' || event.shiftKey);
  };
  const addTile = () => {
    save();
    setEditor({ tile: null });
  };
  return (
    <section className="rio-dashboard" aria-labelledby={headingId} onKeyDown={undoKeys}>
      <header className="rio-dashboard__header" data-anchor="dashboard.designer">
        <h2 id={headingId} className="rio-dashboard__title">
          {dashboard.name}
        </h2>
        <HelpButton subject={dashboard.name} moduleId="dashboards" section="adding-a-tile" />
        {config.tiles.length > 0 ? (
          <ResponsiveToolbar
            label={dashboard.name}
            className="rio-dashboard__actions"
            items={[
              {
                id: 'filters',
                variant: 'secondary',
                priority: 110,
                icon: faFilter,
                active: filters.length > 0,
                disabled: !config.tiles.some(
                  (tile) => tile.kind !== 'text' && schema.tableById.has(tile.source.tableId),
                ),
                label: t({ id: 'dashboards.filters', message: 'Dashboard filters' }),
                onAction: () => setFiltering(true),
              },
              ...(canEdit
                ? [
                    {
                      id: 'layout',
                      variant: layingOut ? 'primary' : 'secondary',
                      priority: 100,
                      active: layingOut,
                      icon: layingOut ? faCheck : faUpDownLeftRight,
                      label: layingOut
                        ? t({ id: 'dashboards.done', message: 'Done' })
                        : t({ id: 'dashboards.edit', message: 'Edit layout' }),
                      onAction: () => {
                        if (layingOut) save();
                        setEditing(!layingOut);
                      },
                    } satisfies ResponsiveToolbarItem,
                    {
                      id: 'add',
                      variant: 'secondary' as const,
                      priority: 90,
                      icon: faPlus,
                      disabled: full,
                      label: t({ id: 'dashboards.addTile', message: 'Add a tile' }),
                      onAction: addTile,
                    } satisfies ResponsiveToolbarItem,
                  ]
                : []),
            ]}
          />
        ) : null}
      </header>
      {config.tiles.length ? (
        <DashboardGrid
          tiles={config.tiles}
          context={context}
          editing={layingOut}
          onLayout={(tiles, options) => change(tiles, { debounce: !options?.immediate })}
        />
      ) : (
        <div className="rio-dashboard__empty">
          <p>
            {t({
              id: 'dashboards.empty',
              message:
                'This dashboard is empty.  Add a tile to show a number, a chart, a pivot table, some records, or a note.',
            })}
          </p>
          {canEdit ? (
            <Button
              variant="primary"
              icon={faPlus}
              onPress={addTile}
              aria-label={t({ id: 'dashboards.addTile', message: 'Add a tile' })}
            />
          ) : null}
        </div>
      )}
      {editor ? (
        <TileEditor
          session={session}
          schema={schema}
          tile={editor.tile}
          defaultSource={editor.tile ? null : startingSource(schema, config.tiles)}
          onSave={saveTile}
          onCancel={() => setEditor(null)}
        />
      ) : null}
      {filtering ? (
        <DashboardFilterDialog
          session={session}
          schema={schema}
          tiles={config.tiles}
          filters={filters}
          onChange={setFilters}
          onClose={() => setFiltering(false)}
        />
      ) : null}
      {drilled ? (
        <DrillDrawer
          key={drillText}
          session={session}
          schema={schema}
          dashboardId={dashboard.id}
          tile={drilled.tile}
          slice={drilled.slice}
          filters={queryFilters}
          data={drilledData}
          format={format}
          onOpenRecord={(tableId, recordId) => setRecord({ tableId, recordId })}
          onOpenView={onOpenView}
          onClose={closeDrill}
        />
      ) : null}
      {record ? (
        <DashboardRecord
          key={`${record.tableId}/${record.recordId}`}
          session={session}
          schema={schema}
          tableId={record.tableId}
          recordId={record.recordId}
          format={format}
          onOpenRecord={(tableId, recordId) => setRecord({ tableId, recordId })}
          onMissing={missingRecord}
          onClose={() => setRecord(null)}
        />
      ) : null}
    </section>
  );
}
