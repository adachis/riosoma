import { DuplicateDialog } from '../screens/database/screen/DuplicateDialog';
import { attachmentUploads } from '../files/upload';
import { useRouter } from '@tanstack/react-router';
import { sourceReadOnly } from '../screens/database/synced/override';
import { SourceHint } from '../screens/database/synced/SourceHint';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLingui } from '@lingui/react/macro';
import { localeInfo } from '@riosoma/i18n';
import { ROW_HEIGHT_PX, roleAllows, type SummaryKind, type TableMeta } from '@riosoma/contracts';
import { createGroupedGrid, type GroupedGrid, type GroupingState } from './grouping/engine';
import type { ContextTarget, GridOptions } from '../../../../packages/grid-core/src/types';
import { useSchema } from '../data/hooks';
import { personTimeZone } from '../screens/database/dashboards/data';
import type { PastePlan } from './clipboard/plan';
import { createFind } from './find/find';
import { FindBar } from './find/FindBar';
import { GridSummaryStore } from './summary/store';
import { SummaryMenu } from './summary/SummaryMenu';
import { createGridController, type GridState } from './view/controller';
import { PastePreview } from './view/PastePreview';
import { GridAppearance } from './view/GridAppearance';
import { GridMenu } from './view/GridMenu';
import { ViewPromptPill } from '../screens/database/shell/ViewPromptPill';
import { reportError } from './view/actions';
import { useGridCelebrations } from '../features/celebrations/watchers';
import { AiFieldStatusStore } from '../features/ai-fields/status';
import { anchor } from '../demos/anchors';
import { SHORTCUTS, type Shortcut } from '../shortcuts/registry';
import type { GridShortcutId } from '../../../../packages/grid-core/src/shortcuts';
import { usePaletteItems } from '../palette/sources';
import type { PaletteOffer } from '../palette/types';
import './view/view.css';

type Props = Omit<GridState, 'onMenu' | 'onPreview' | 'onSummary'> & {
  onFilter(): void;
  onCloseRecord?(): void;
  offerShortcuts?: boolean;
};
/** The settings the view hands the engine, which it compares before passing them on */
type ViewOptions = Pick<
  GridOptions<unknown>,
  'label' | 'direction' | 'rowHeight' | 'frozenColumnCount' | 'headerHeight' | 'showAddRow' | 'showAddColumn'
>;
interface MountedGrid {
  grid: GroupedGrid;
  controller: ReturnType<typeof createGridController>;
  abort: AbortController;
  /** Whether the engine was last told its records can't be changed */
  readOnly: boolean;
  /** What the engine was last told of the view's settings */
  options: ViewOptions;
  /** The grouping the engine was last given */
  grouping: GroupingState;
}

/** Whether two groupings would draw the same group rows */
function sameGrouping(a: GroupingState, b: GroupingState): boolean {
  return (
    a.enabled === b.enabled &&
    a.storageKey === b.storageKey &&
    a.fields === b.fields &&
    a.format === b.format &&
    a.add === b.add &&
    (a.groups === b.groups || (!a.groups.length && !b.groups.length))
  );
}

/** The view's summaries with one field's changed, leaving out fields that show none. */
function withSummary(
  summaries: Readonly<Record<string, SummaryKind>>,
  fieldId: string,
  kind: SummaryKind,
): Record<string, SummaryKind> {
  const next = Object.fromEntries(Object.entries(summaries).filter(([id]) => id !== fieldId));
  return kind === 'none' ? next : { ...next, [fieldId]: kind };
}

/** A synced or joined table takes its rows from elsewhere, so the grid adds and groups nothing. */
function fixedRows(table: TableMeta): boolean {
  return Boolean(table.source || table.joined);
}

/** The view owns one engine instance; schema and paging updates only redraw it. */
export function GridView(props: Props) {
  const router = useRouter({ warn: false });
  const { t, i18n } = useLingui();
  const paletteSource = useId();
  const container = useRef<HTMLDivElement>(null);
  const mounted = useRef<MountedGrid | null>(null);
  const latest = useRef(props);
  const [fileDrop, setFileDrop] = useState<string>();
  const dropCell = useRef<HTMLElement | null>(null);
  const [appearance, setAppearance] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('gridField'),
  );
  function openAppearance(id: string | null) {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('gridField', id);
    else url.searchParams.delete('gridField');
    window.history.replaceState(window.history.state, '', url);
    setAppearance(id);
  }
  const appearanceField = props.fields.find((field) => field.id === appearance);
  const [preview, setPreview] = useState<PastePlan | null>(null);
  // One store for the view's life, so the bar listens from the first render and keeps its text.
  const [find] = useState(createFind);
  const [duplicateFieldId, setDuplicateFieldId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    target: ContextTarget;
    point: { x: number; y: number };
    engine: MountedGrid;
  } | null>(null);
  const [summaryMenu, setSummaryMenu] = useState<{
    fieldId: string;
    anchor: HTMLElement;
    engine: MountedGrid;
  } | null>(null);
  const { session, rows } = props;
  const viewId = props.view.id;
  const tableId = props.table.id;
  const where = rows?.scope?.where;
  const summaryStore = useMemo(
    () => new GridSummaryStore(session, viewId, tableId, personTimeZone(), where),
    [session, viewId, tableId, where],
  );
  useEffect(() => summaryStore.start(), [summaryStore]);
  // A table with AI fields follows where their runs stand, and asks again when records change.
  const hasAi = props.fields.some((field) => field.ai);
  const aiFields = useMemo(() => (hasAi ? new AiFieldStatusStore(tableId) : undefined), [hasAi, tableId]);
  const aiRef = useRef(aiFields);
  useLayoutEffect(() => {
    aiRef.current = aiFields;
  });
  useEffect(() => {
    if (!aiFields) return;
    const stop = aiFields.start();
    const redraw = aiFields.subscribe(() => mounted.current?.grid.rowsChanged());
    const records = session.subscribeRecords(tableId, () => aiFields.nudge());
    return () => {
      stop();
      redraw();
      records();
    };
  }, [aiFields, session, tableId]);
  // The server reads the saved settings, so the row follows them rather than a filter being typed.
  const schema = useSchema(session);
  const saved = schema?.viewById.get(viewId)?.config ?? props.view.config;
  // A role can change while the view is open, when what the person may do reloads.
  const role = schema?.database.role ?? session.role();
  const commands = useMemo<PaletteOffer[]>(
    () =>
      SHORTCUTS.filter(
        (shortcut): shortcut is Shortcut & { id: GridShortcutId } =>
          Boolean(props.offerShortcuts) &&
          [
            'grid.undo',
            'grid.redo',
            'grid.all',
            'grid.fillDown',
            'grid.fillRight',
            'grid.find',
            'grid.replace',
          ].includes(shortcut.id) &&
          (roleAllows(role, 'editRecords') || ['grid.all', 'grid.find'].includes(shortcut.id)),
      ).map((shortcut) => ({
        id: `cmd:${shortcut.id}`,
        group: 'commands',
        label: i18n._(shortcut.label),
        shortcut: shortcut.id,
        run: () =>
          requestAnimationFrame(() => {
            mounted.current?.grid.runShortcut?.(shortcut.id);
          }),
      })),
    [i18n, role, props.offerShortcuts],
  );
  usePaletteItems(`grid.shortcuts:${paletteSource}`, commands);
  const summaryKey = JSON.stringify([saved.filter, saved.summaries, saved.hiddenFieldIds]);
  useEffect(() => summaryStore.setKey(summaryKey), [summaryStore, summaryKey]);
  const summary = useSyncExternalStore(summaryStore.subscribe, summaryStore.getSnapshot);
  useGridCelebrations({
    session,
    rows,
    table: props.table,
    view: props.view,
    fields: props.fields,
    container,
  });
  useLayoutEffect(() => {
    latest.current = props;
  });
  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    const abort = new AbortController();
    const controller = createGridController(
      {
        ...latest.current,
        router,
        aiFields: aiRef.current,
        onPreview: setPreview,
        onMenu: (target, point) => {
          if (mounted.current && target.kind !== 'empty') setMenu({ target, point, engine: mounted.current });
        },
        onSummary: (fieldId, anchor) => {
          if (mounted.current) setSummaryMenu({ fieldId, anchor, engine: mounted.current });
        },
      },
      abort.signal,
      find,
    );
    controller.setSummary(summaryStore.getSnapshot());
    const current = latest.current;
    const readOnly = !roleAllows(session.role(), 'editRecords');
    const grouping = (): GroupingState => ({
      enabled: latest.current.view.config.groups.length > 0,
      groups: rows.groups?.() ?? [],
      fields: latest.current.fields,
      format: latest.current.format,
      storageKey: `grid-groups:${session.userId}:${viewId}`,
      add: fixedRows(latest.current.table) ? undefined : controller.addGroup,
    });
    const options: ViewOptions = {
      label: current.view.name,
      direction: localeInfo(current.format.locale).dir,
      rowHeight: ROW_HEIGHT_PX[current.view.config.rowHeight],
      frozenColumnCount: current.view.config.frozenFieldCount,
      headerHeight: current.view.config.columnGroups.length ? 56 : 32,
      showAddRow: !fixedRows(latest.current.table) && !readOnly,
      showAddColumn: roleAllows(session.role(), 'editSchema'),
    };
    const initialGrouping = grouping();
    const grid = createGroupedGrid(
      node,
      {
        ...options,
        host: controller.host,
        columns: controller.columns(),
        rowCount: rows.rowCount(),
        rowHeaderWidth: 88,
        readOnly,
        showFooter: true,
        messages: {
          'grid.addRow': t({ id: 'grid.addRecord', message: 'Add record' }),
          'grid.field.add': t({ id: 'grid.field.add', message: 'Add field' }),
        },
      },
      initialGrouping,
    );
    const engine: MountedGrid = { grid, controller, abort, readOnly, options, grouping: initialGrouping };
    mounted.current = engine;
    controller.attach(grid);
    let count = rows.rowCount();
    const unsubscribe = rows.subscribe((change) => {
      engine.grouping = grouping();
      grid.grouping(engine.grouping);
      if (count !== rows.rowCount()) {
        count = rows.rowCount();
        grid.update({ rowCount: count });
      }
      if (Array.isArray(change.rows)) grid.rowsChanged(change.rows[0], change.rows[1]);
      else grid.rowsChanged();
      controller.decorate();
    });
    const records = session.subscribeRecords(current.table.id, controller.recordsChanged);
    return () => {
      abort.abort();
      records();
      unsubscribe();
      controller.destroy();
      grid.destroy();
      mounted.current = null;
    };
  }, [session, rows, t, find, summaryStore, viewId, router]);
  useLayoutEffect(() => {
    const engine = mounted.current;
    if (!engine) return;
    engine.controller.update({
      ...props,
      router,
      aiFields,
      onPreview: setPreview,
      onMenu: (target, point) => {
        if (target.kind !== 'empty') setMenu({ target, point, engine });
      },
      onSummary: (fieldId, anchor) => setSummaryMenu({ fieldId, anchor, engine }),
    });
    // Only a change of role changes this, and telling the engine stops any edit under way.
    const readOnly = !roleAllows(role, 'editRecords');
    const changed = readOnly !== engine.readOnly;
    engine.readOnly = readOnly;
    // The engine hears only what changed, so a parent drawing again with the same settings, such
    // as when someone's presence moves or a record opens, leaves the rows as they are.
    const grouping: GroupingState = {
      enabled: props.view.config.groups.length > 0,
      groups: rows.groups?.() ?? [],
      fields: props.fields,
      format: props.format,
      storageKey: `grid-groups:${session.userId}:${viewId}`,
      add: fixedRows(props.table) ? undefined : engine.controller.addGroup,
    };
    if (!sameGrouping(grouping, engine.grouping)) {
      engine.grouping = grouping;
      engine.grid.grouping(grouping);
    }
    const options: ViewOptions = {
      label: props.view.name,
      direction: localeInfo(props.format.locale).dir,
      rowHeight: ROW_HEIGHT_PX[props.view.config.rowHeight],
      frozenColumnCount: props.view.config.frozenFieldCount,
      headerHeight: props.view.config.columnGroups.length ? 56 : 32,
      showAddRow: !fixedRows(latest.current.table) && !readOnly,
      showAddColumn: roleAllows(role, 'editSchema'),
    };
    const update = Object.fromEntries(
      Object.entries(options).filter(([key, value]) => engine.options[key as keyof ViewOptions] !== value),
    ) as Partial<ViewOptions> & { readOnly?: boolean };
    if (changed) update.readOnly = readOnly;
    engine.options = options;
    if (Object.keys(update).length) engine.grid.update(update);
  }, [props, role, aiFields, rows, session.userId, viewId, router]);

  useLayoutEffect(() => {
    mounted.current?.controller.setSummary(summary);
  }, [summary]);

  useLayoutEffect(() => {
    rows.onSyncRefresh?.(refresh);
    return () => rows.onSyncRefresh?.(undefined);
  });

  async function refresh() {
    const engine = mounted.current;
    if (!engine) return;
    const anchor = engine.grid.anchorRow();
    const id = rows.getRow(anchor)?.id;
    const row = props.view.config.groups.length
      ? null
      : container.current?.querySelector<HTMLElement>(`.rio-grid__row[data-rio-row="${anchor}"]`);
    const offset = row ? row.getBoundingClientRect().top - row.parentElement!.getBoundingClientRect().top : 0;
    const result = await rows.refresh(id);
    if (engine.abort.signal.aborted || result.anchorIndex === null) return;
    engine.grid.update({ rowCount: rows.rowCount() });
    engine.grid.scrollToCell({ row: result.anchorIndex }, 'start');
    // Feed the engine a content-pixel delta so compressed scrollbars preserve partial-row offsets too.
    requestAnimationFrame(() => {
      if (!engine.abort.signal.aborted)
        container.current?.dispatchEvent(new WheelEvent('wheel', { deltaY: -offset, cancelable: true }));
    });
  }

  const summaryField = summaryMenu
    ? props.fields.find((field) => field.id === summaryMenu.fieldId)
    : undefined;
  function attachmentTarget(target: EventTarget | null) {
    if (!(target instanceof Element) || target.closest('[data-rio-footer], [data-rio-add-row]')) return null;
    const element = target.closest<HTMLElement>('[role="gridcell"]');
    if (!element || !mounted.current) return null;
    const cell = mounted.current.grid.recordCell({
      row: Number(element.dataset.rioRow),
      col: Number(element.dataset.rioCol),
    });
    if (!cell) return null;
    const row = props.rows.getRow(cell.row);
    const fieldId = mounted.current.controller.columns()[cell.col]?.id;
    const field = props.fields.find((field) => field.id === fieldId);
    if (!row || field?.type !== 'attachment') return null;
    const reason =
      !roleAllows(session.role(), 'editRecords') ||
      sourceReadOnly(field, props.table) ||
      schema?.access.fields.get(field.id)?.editable === false
        ? t({ id: 'files.dropReadOnly', message: 'You cannot add files to this cell.' })
        : row.lock && !row.lock.canEdit
          ? row.lock.reason
          : undefined;
    return { row, field, cell, element, reason };
  }
  const clearDrop = () => {
    dropCell.current?.removeAttribute('data-file-drop');
    dropCell.current = null;
    setFileDrop(undefined);
  };

  return (
    <div
      className="rio-grid-view"
      {...anchor('grid')}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        const target = attachmentTarget(event.target);
        dropCell.current?.removeAttribute('data-file-drop');
        dropCell.current = target?.element ?? null;
        target?.element.setAttribute('data-file-drop', target.reason ? 'refused' : 'ready');
        event.dataTransfer.dropEffect = target && !target.reason ? 'copy' : 'none';
        setFileDrop(
          target?.reason ??
            (target
              ? t({ id: 'files.drop', message: 'Drop files to add them' })
              : t({ id: 'files.dropAttachmentCell', message: 'Drop files onto an attachment cell.' })),
        );
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearDrop();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        const target = attachmentTarget(event.target);
        clearDrop();
        if (!target || target.reason) return;
        attachmentUploads(session, props.table.id, target.field.id, target.row.id).add(
          Array.from(event.dataTransfer.files),
        );
        mounted.current?.grid.startEditing(target.cell);
      }}
      onKeyDownCapture={(event) => {
        if (
          props.onCloseRecord &&
          event.key === 'Escape' &&
          !mounted.current?.grid.isEditing() &&
          event.target instanceof Element &&
          event.target.matches('.rio-grid__input')
        ) {
          event.preventDefault();
          event.stopPropagation();
          props.onCloseRecord();
        }
      }}
    >
      {fileDrop && (
        <p className="rio-grid-file-drop" role="status">
          {fileDrop}
        </p>
      )}
      <div ref={container} className="rio-grid-view__engine" />
      <SourceHint container={container} />
      <FindBar
        find={find}
        canReplace={roleAllows(session.role(), 'editRecords')}
        onClose={() => mounted.current?.grid.focus()}
      />
      <ViewPromptPill
        prompts={rows.prompts()}
        onRefresh={() => {
          void refresh().catch(reportError);
        }}
      />
      {preview && (
        <PastePreview
          plan={preview}
          fields={new Map(props.fields.map((field) => [field.id, field]))}
          onCancel={() => {
            setPreview(null);
            mounted.current?.grid.focus();
          }}
          onPaste={() => {
            mounted.current?.controller.applyPaste(preview);
            setPreview(null);
            mounted.current?.grid.focus();
          }}
        />
      )}
      {duplicateFieldId && props.fields.some((field) => field.id === duplicateFieldId) && (
        <DuplicateDialog
          kind="field"
          id={duplicateFieldId}
          name={props.fields.find((field) => field.id === duplicateFieldId)!.name}
          existingNames={(props.session.getSchema().fields.get(props.table.id) ?? []).map(
            (field) => field.name,
          )}
          session={props.session}
          onClose={() => setDuplicateFieldId(null)}
        />
      )}
      {menu && (
        <GridMenu
          state={{
            ...props,
            aiFields,
            onPreview: setPreview,
            onMenu: () => {},
            onAppearance: openAppearance,
            onDuplicateField: setDuplicateFieldId,
          }}
          {...menu}
          grid={menu.engine.grid}
          controller={menu.engine.controller}
          signal={menu.engine.abort.signal}
          onClose={() => {
            setMenu(null);
            menu.engine.grid.focus();
          }}
          onFilter={props.onFilter}
        />
      )}
      {appearanceField && !props.view.config.locked && roleAllows(role, 'editSchema') && (
        <GridAppearance
          field={appearanceField}
          fields={props.fields}
          primaryFieldId={props.table.primaryFieldId}
          config={props.view.config}
          onSave={props.onConfig}
          onClose={() => openAppearance(null)}
        />
      )}
      {summaryMenu && summaryField && (
        <SummaryMenu
          field={summaryField}
          summaries={props.view.config.summaries}
          anchor={summaryMenu.anchor}
          onChoose={(kind) => {
            props.onConfig({ summaries: withSummary(props.view.config.summaries, summaryField.id, kind) });
            setSummaryMenu(null);
            summaryMenu.engine.grid.focus();
          }}
          onClose={() => {
            setSummaryMenu(null);
            summaryMenu.engine.grid.focus();
          }}
        />
      )}
    </div>
  );
}
