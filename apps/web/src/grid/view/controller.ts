import { joinedSources } from '@riosoma/contracts';
import { withSourceLabels } from '../../fields/sourceLabels';
import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { icon } from '../cells/dom';
import type { AnyRouter } from '@tanstack/react-router';
import { api as requestApi } from '../../api';
import { sourceReadOnly, overridesOff } from '../../screens/database/synced/override';
import { followsValues, matchedTooltip } from '../../screens/database/joins/matched';
import { msg, plural } from '@lingui/core/macro';
import {
  validateFieldValue,
  cellValue,
  isComputedType,
  type RecordComment,
  type CellValue,
  type GridGroupBoundary,
  isEmptyValue,
  newId,
  presenceColor,
  roleAllows,
  readsSourceLive,
  type FieldMeta,
  type GridConfig,
  type PresencePeer,
  type RowData,
  type TableMeta,
  type ViewMeta,
} from '@riosoma/contracts';
import { toast } from '@riosoma/ui';
import type {
  CellDecoration,
  CellRange,
  CellRef,
  ContextTarget,
  FillRequest,
  GridApi,
  GridColumn,
  GridHost,
  GridSelection,
} from '../../../../../packages/grid-core/src/types';
import type { CommandInput, DatabaseSession, ViewRows } from '../../data/types';
import { i18n } from '../../i18n';
import { clearRioSelection, setRioSelection } from '../../features/rio/context';
import { serverMessage } from '../../messages/useServerMessage';
import { gridColumns } from '../cells/columns';
import { createCellRenderer } from '../cells/renderers';
import type { AiFieldStatusStore } from '../../features/ai-fields/status';
import { createHeaderRenderer } from '../cells/header';
import { createRowHeaderRenderer } from '../cells/rowHeader';
import { describeCell } from '../cells/describe';
import { createSummaryFooter } from '../summary/footer';
import type { GridSummaryState } from '../summary/store';
import { editText, type FormatContext } from '../format';
import { parseText } from '../parse';
import { mountEditor } from '../editors/mountEditor';
import { readAttachmentClipboard, writeAttachmentClipboard } from '../../files/clipboard';
import { copyCells } from '../clipboard/copy';
import { colorGridHost } from '../../screens/database/colors/grid';
import type { ViewColors } from '../../screens/database/colors/paint';
import { writeClipboard } from '../clipboard/write';
import { readClipboard } from '../clipboard/read';
import { planPaste, type PastePlan } from '../clipboard/plan';
import { pasteCommands } from '../clipboard/commands';
import { FILL_LIMIT, planFill, type FillPlan } from '../fill/plan';
import { createFind, type FindController, type FindDeps } from '../find/find';
import {
  emptyValues,
  loadRows,
  optionAction,
  recordCommands,
  reportError,
  selectedRows,
  selectionRange,
  undoAction,
  undoToast,
} from './actions';

/** How a finished fill reads in its toast: what changed, and what was left alone and why. */
function fillToast(session: GridState['session'], plan: FillPlan, capped: boolean): void {
  const t = i18n._.bind(i18n);
  const notes = [
    capped
      ? t(
          msg({
            id: 'grid.fill.capped',
            message: plural(FILL_LIMIT, { other: 'A fill changes up to # cells, so it stopped there.' }),
          }),
        )
      : '',
    plan.skipped
      ? t(
          msg({
            id: 'grid.fill.skipped',
            message: plural(plan.skipped, {
              one: 'Skipped # cell that can’t be changed here.',
              other: 'Skipped # cells that can’t be changed here.',
            }),
          }),
        )
      : '',
    plan.unfit
      ? t(
          msg({
            id: 'grid.fill.unfit',
            message: plural(plan.unfit, {
              one: '# value didn’t fit its field.',
              other: '# values didn’t fit their fields.',
            }),
          }),
        )
      : '',
  ].filter(Boolean);
  if (!plan.cells) {
    toast.show({
      tone: 'info',
      title: t(msg({ id: 'grid.fill.nothing', message: 'Nothing was filled' })),
      ...(notes.length ? { description: notes.join('  ') } : {}),
    });
    return;
  }
  toast.show({
    tone: 'success',
    title: t(
      msg({
        id: 'grid.fill.done',
        message: plural(plan.cells, { one: 'Filled # cell', other: 'Filled # cells' }),
      }),
    ),
    ...(notes.length ? { description: notes.join('  ') } : {}),
    action: {
      label: t(msg({ id: 'grid.undo', message: 'Undo' })),
      onPress: () => {
        void undoAction(session);
      },
    },
  });
}

export interface GridState {
  router?: AnyRouter;
  session: DatabaseSession;
  rows: ViewRows;
  table: TableMeta;
  view: ViewMeta;
  fields: readonly FieldMeta[];
  format: FormatContext;
  peers: readonly PresencePeer[];
  recordId?: string;
  /** The view's conditional colors */
  colors?: ViewColors;
  onConfig(patch: Partial<GridConfig>): void;
  onExpand(recordId: string, fieldId?: string): void;
  onSelectRecord?(recordId: string): void;
  onDuplicateField?(fieldId: string): void;
  onField(fieldId: string | null, index?: number): void;
  /** Opens who can see and change a field */
  onPermissions?(fieldId: string): void;
  onMenu(target: ContextTarget, point: { x: number; y: number }): void;
  onPreview(plan: PastePlan): void;
  /** A column's footer cell was opened, to choose its summary */
  onAppearance?(fieldId: string): void;
  onSummary?(fieldId: string, anchor: HTMLElement): void;
  /** Where the table's AI fields stand, when it has any */
  aiFields?: AiFieldStatusStore;
}

export function createGridController(
  initial: GridState,
  signal: AbortSignal,
  finder: FindController = createFind(),
) {
  let state = initial;
  let editingCell: { recordId: string; fieldId: string } | null = null;
  const comments = new Map<string, RecordComment>();
  let commentedCells = new Set<string>();
  const commentChanges = new Set<string>();
  const refreshCommentCells = () => {
    commentedCells = new Set(
      [...comments.values()]
        .filter((comment) => comment.fieldId)
        .map((comment) => `${comment.recordId}/${comment.fieldId}`),
    );
  };
  const loadedComments = new Set<string>();
  const pendingComments = new Set<string>();
  const queuedComments = new Set<string>();
  let commentsQueued = false;
  function queueComments(recordId: string) {
    if (loadedComments.has(recordId) || pendingComments.has(recordId) || signal.aborted) return;
    pendingComments.add(recordId);
    queuedComments.add(recordId);
    if (commentsQueued) return;
    commentsQueued = true;
    queueMicrotask(() => {
      commentsQueued = false;
      const ids = [...queuedComments];
      queuedComments.clear();
      for (let start = 0; start < ids.length; start += 200) {
        const batch = ids.slice(start, start + 200);
        void state.session
          .cellComments(state.table.id, batch, signal)
          .then((page) => {
            if (signal.aborted) return;
            for (const id of batch) {
              pendingComments.delete(id);
              loadedComments.add(id);
            }
            for (const comment of page.comments)
              if (loadedComments.has(comment.recordId) && !commentChanges.has(comment.id))
                comments.set(comment.id, comment);
            while (loadedComments.size > 2000) {
              const expired = loadedComments.values().next().value!;
              loadedComments.delete(expired);
              for (const [id, comment] of comments)
                if (comment.recordId === expired) {
                  comments.delete(id);
                  commentChanges.delete(id);
                }
            }
            refreshCommentCells();
            api?.rowsChanged();
          })
          .catch(() => {
            for (const id of batch) pendingComments.delete(id);
          });
      }
    });
  }
  const tracksComments = (id: string) => loadedComments.has(id) || pendingComments.has(id);
  const stopComments = initial.session.subscribeComments((change) => {
    if (change.kind === 'comment.deleted') {
      if (change.tableId !== state.table.id || !tracksComments(change.recordId)) return;
      comments.delete(change.commentId);
      commentChanges.add(change.commentId);
    } else if (change.kind === 'comment.moved') {
      for (const comment of change.comments) {
        if (!tracksComments(comment.recordId) && !comments.has(comment.id)) continue;
        comments.set(comment.id, comment);
        commentChanges.add(comment.id);
      }
    } else {
      if (change.comment.tableId !== state.table.id || !tracksComments(change.comment.recordId)) return;
      comments.set(change.comment.id, change.comment);
      commentChanges.add(change.comment.id);
    }
    refreshCommentCells();
    api?.rowsChanged();
  });
  signal.addEventListener('abort', stopComments, { once: true });
  let selectedRecordRequest = 0;
  let api: GridApi<RowData> | null = null;
  let columns = gridColumns(state.view, state.fields, state.table.primaryFieldId, state.table);
  let byId = new Map(state.fields.map((field) => [field.id, field]));
  const t = i18n._.bind(i18n);
  let cellRenderer = createCellRenderer({
    fieldsById: byId,
    session: state.session,
    format: state.format,
    rowHeight: state.view.config.rowHeight,
    colors: state.colors,
    aiFields: state.aiFields,
  });
  let headerRenderer = createHeaderRenderer({
    fieldsById: byId,
    primaryFieldId: state.table.primaryFieldId,
    sourceName: state.table.source?.sourceName,
    mappedSources: (id) => {
      const mapping = state.table.joined?.fields.find((item) => item.outputFieldId === id);
      const schema = state.session.getSchema();
      return mapping
        ? joinedSources(mapping).flatMap((source) => {
            const field = schema.fieldById.get(source.fieldId);
            const table = schema.tableById.get(source.tableId);
            return field && table
              ? [t(msg({ id: 'joined.mapping.sourceLabel', message: `${table.name} ${field.name}` }))]
              : [];
          })
        : [];
    },
    access: () => state.session.getSchema().access.fields,
    aiFields: state.aiFields,
    t,
  });
  const rowRenderer = createRowHeaderRenderer({ t, movable: true });
  /** The role the renderers were made under, since read only and the footer's menus follow it */
  let drawnRole = state.session.role();
  let summary: GridSummaryState = { status: 'loading' };
  const footerFor = () =>
    createSummaryFooter({
      fieldsById: byId,
      primaryFieldId: state.table.primaryFieldId,
      summaries: state.view.config.summaries,
      state: summary,
      format: state.format,
      editable: roleAllows(state.session.role(), 'editSchema'),
      t,
    });
  let footer = footerFor();
  const snapshots = new Map<string, RowData>();
  const refusedCells = new Map<string, string>();
  const unsubscribeRefusals = state.session.subscribeEvents((event) => {
    if (event.kind !== 'rejected') return;
    for (const issue of event.issues ?? [])
      refusedCells.set(
        `${issue.recordId}:${issue.fieldId}`,
        issue.message || serverMessage(i18n, issue.messageKey, event.params),
      );
    api?.rowsChanged();
  });
  signal.addEventListener('abort', unsubscribeRefusals, { once: true });
  let flashes: CellDecoration[] = [];
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const editable = () => roleAllows(state.session.role(), 'editRecords');
  const schemaEditable = () => !state.view.config.locked && roleAllows(state.session.role(), 'editSchema');
  /**
   * Cells nobody edits here: source values without overrides, links that follow values, and fields
   * locked to other people.  The server refuses those edits anyway.
   */
  const readOnly = (field: FieldMeta) =>
    sourceReadOnly(field, state.table) ||
    followsValues(field) ||
    state.session.getSchema().access.fields.get(field.id)?.editable === false;
  const visibleFields = () => columns.map((column) => byId.get(column.id)!).filter(Boolean);
  const find = (cell: CellRef) => {
    const row = state.rows.getRow(cell.row);
    const field = byId.get(columns[cell.col]?.id ?? '');
    return row && field ? { row, field } : null;
  };
  const execute = (action: () => void) => {
    try {
      action();
    } catch (error) {
      reportError(error);
    }
  };
  const asyncAction = (action: () => Promise<void>) => {
    void action().catch((error) => {
      if (!signal.aborted) reportError(error);
    });
  };

  function decorate() {
    const decorations: CellDecoration[] = [...finder.marks(), ...flashes];
    for (const peer of state.peers) {
      if (peer.where?.viewId !== state.view.id || !peer.where.cell) continue;
      const row = state.rows.indexOf(peer.where.cell.recordId);
      const col = columns.findIndex((column) => column.id === peer.where?.cell?.fieldId);
      if (row >= 0 && col >= 0)
        decorations.push({
          kind: 'presence',
          row,
          col,
          color: `var(--rio-aa-choice-${peer.color})`,
          label: peer.name,
        });
    }
    api?.setDecorations(decorations);
  }

  function presence(selection: GridSelection) {
    const range =
      selection.range ??
      (selection.active && selection.rows.kind === 'none'
        ? { start: selection.active, end: selection.active }
        : null);
    // Cap before allocating: selecting a whole table can mean millions of rows.
    const indices =
      selection.rows.kind === 'all'
        ? Array.from({ length: Math.min(200, state.rows.rowCount()) }, (_, index) => index)
        : selection.rows.kind === 'some'
          ? [...selection.rows.rows]
              .filter((index) => index < state.rows.rowCount())
              .sort((a, b) => a - b)
              .slice(0, 200)
          : range
            ? Array.from(
                { length: Math.min(200, range.end.row - range.start.row + 1) },
                (_, index) => range.start.row + index,
              )
            : [];
    const fieldIds = range
      ? columns
          .slice(range.start.col, range.end.col + 1)
          .slice(0, 100)
          .map((column) => column.id)
      : columns.slice(0, 100).map((column) => column.id);
    const rows = state.rows;
    setRioSelection(state.session, state.view.id, async () => {
      if (!indices.length) return {};
      await Promise.all(indices.map((index) => loadRows(rows, index, index + 1, signal)));
      return {
        recordIds: indices.flatMap((index) => {
          const row = rows.getRow(index);
          return row ? [row.id] : [];
        }),
        fieldIds,
      };
    });
    const active = selection.active ? find(selection.active) : null;
    state.session.setPresence({
      tableId: state.table.id,
      viewId: state.view.id,
      ...(state.recordId ? { recordId: state.recordId } : {}),
      ...(active ? { cell: { recordId: active.row.id, fieldId: active.field.id } } : {}),
      ...(active && editingCell?.recordId === active.row.id && editingCell.fieldId === active.field.id
        ? { editing: true }
        : {}),
    });
  }

  function copy(selection: GridSelection) {
    const range = selectionRange(selection, state.rows.rowCount(), columns.length);
    if (!range) return null;
    const fields = visibleFields();
    const indices = selectedRows(selection, state.rows.rowCount());
    if (indices.some((index) => !state.rows.getRow(index))) {
      asyncAction(async () => {
        await loadRows(state.rows, range.start.row, range.end.row + 1, signal);
        const data = copy(selection);
        if (data) {
          if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write)
            await navigator.clipboard.write([
              new ClipboardItem({
                'text/plain': new Blob([data.text], { type: 'text/plain' }),
                'text/html': new Blob([data.html], { type: 'text/html' }),
              }),
            ]);
          else await navigator.clipboard.writeText(data.text);
        }
      });
      return null;
    }
    const cells =
      selection.rows.kind === 'none'
        ? copyCells(range, fields, (index) => state.rows.getRow(index)!, {
            ...state.format,
            attachments: state.session.attachments,
          })
        : indices.flatMap((index) =>
            copyCells(
              { start: { row: index, col: 0 }, end: { row: index, col: fields.length - 1 } },
              fields,
              (position) => state.rows.getRow(position)!,
              { ...state.format, attachments: state.session.attachments },
            ),
          );
    const sourceFields =
      selection.rows.kind === 'none' ? fields.slice(range.start.col, range.end.col + 1) : fields;
    const sourceIndices =
      selection.rows.kind === 'none'
        ? Array.from({ length: range.end.row - range.start.row + 1 }, (_, index) => range.start.row + index)
        : indices;
    return writeAttachmentClipboard(
      writeClipboard(cells),
      sourceFields,
      sourceIndices.map((index) => state.rows.getRow(index)!),
    );
  }

  async function paste(selection: GridSelection, data: { text: string; html: string | null }) {
    if (!editable()) return;
    const range = selectionRange(selection, state.rows.rowCount(), columns.length) ?? {
      start: { row: 0, col: 0 },
      end: { row: 0, col: 0 },
    };
    const cells = readClipboard(data);
    const height = Math.max(cells.length, range.end.row - range.start.row + 1);
    await loadRows(state.rows, range.start.row, range.start.row + height, signal);
    const pasteFields = await Promise.all(
      visibleFields().map((field, index) => {
        const width = cells[0]?.length ?? 1;
        const source = index - range.start.col;
        return source < 0
          ? field
          : withSourceLabels(
              field,
              cells.map((row) => row[source % width] ?? ''),
              signal,
            );
      }),
    );
    const plan = planPaste({
      cells,
      attachments: readAttachmentClipboard(data.html),
      start: range.start,
      selection: { rows: range.end.row - range.start.row + 1, cols: range.end.col - range.start.col + 1 },
      fields: pasteFields,
      allowCreate: !(state.table.source || state.table.joined),
      readOnlyFieldIds: new Set(state.fields.filter(readOnly).map((field) => field.id)),
      rowCount: state.rows.rowCount(),
      rowIdAt: (index) => state.rows.getRow(index)!.id,
      context: state.format,
    });
    if (!plan.cellCount) return;
    const needsPreview =
      state.fields.some(
        (field) =>
          ('validation' in field.options && field.options.validation) ||
          ('unique' in field.options && field.options.unique),
      ) ||
      [...plan.updates].some((record) => {
        const index = state.rows.indexOf(record.id);
        return index >= 0 && state.rows.getRow(index)?.lock;
      });
    if (needsPreview && !plan.newChoices.size) {
      const commands = pasteCommands(plan, state.table.id, byId).recordCommands();
      if (commands.length) {
        const result = await requestApi<{
          issues: Array<{ recordId: string; fieldId: string; messageKey: string; message?: string }>;
        }>(`/api/databases/${state.session.databaseId}/commands/preview`, {
          body: {
            clientId: newId('client'),
            commands: commands.map((command) => ({
              ...command,
              id: newId('command'),
              groupId: newId('action'),
            })),
          },
        });
        for (const issue of result.issues) {
          const row = state.rows.indexOf(issue.recordId);
          const added = plan.creates.findIndex((record) => record.id === issue.recordId);
          const col = columns.findIndex((column) => column.id === issue.fieldId);
          plan.problems.push({
            row: row >= 0 ? row : state.rows.rowCount() + added,
            col,
            text: '',
            reason: 'validation',
            messageKey: issue.messageKey,
            message: issue.message,
          });
        }
        if (result.issues.length) plan.refused = true;
      }
    }
    if (plan.creates.length || plan.newChoices.size || plan.problems.length || plan.cellCount > 1000)
      state.onPreview(plan);
    else applyPaste(plan);
  }

  function applyPaste(plan: PastePlan) {
    if (!editable() || plan.refused) return;
    execute(() => {
      if (plan.newChoices.size && !schemaEditable()) {
        toast.show({ tone: 'danger', title: serverMessage(i18n, 'errors.forbidden') });
        return;
      }
      const prepared = pasteCommands(plan, state.table.id, byId);
      const commands = [...prepared.optionCommands, ...prepared.recordCommands()]
        .filter((command) => !(state.table.source || state.table.joined) || command.kind !== 'record.create')
        .map((command) =>
          command.kind === 'record.update'
            ? {
                ...command,
                records: command.records
                  .map((record) => ({
                    ...record,
                    values: Object.fromEntries(
                      Object.entries(record.values).filter(([id]) => {
                        const field = byId.get(id);
                        return field && !readOnly(field);
                      }),
                    ),
                  }))
                  .filter((record) => Object.keys(record.values).length),
              }
            : command,
        )
        .filter((command) => command.kind !== 'record.update' || command.records.length);
      if (!commands.length) return;
      const count = plan.cellCount - plan.problems.length - plan.skippedComputed;
      const title = t(
        msg({
          id: 'grid.paste.done',
          message: plural(count, { one: 'Pasted # cell', other: 'Pasted # cells' }),
        }),
      );
      const handle = state.session.run(commands, {
        placeAt: { viewId: state.view.id, index: state.rows.rowCount() },
      });
      if (plan.cellCount <= 1000) {
        undoToast(state.session, title);
        return;
      }
      const total = count;
      let key = '';
      const initialPending = state.session.saveState().pending;
      const progress = () => {
        const remaining = Math.min(commands.length, state.session.saveState().pending);
        const done = Math.min(
          total,
          Math.floor((total * Math.max(0, initialPending - remaining)) / commands.length),
        );
        if (key) toast.dismiss(key);
        key = toast.show({
          tone: 'info',
          timeout: 0,
          title: t(msg({ id: 'grid.paste.progress', message: `Pasting… ${done} of ${total}` })),
        });
      };
      progress();
      const unsubscribe = state.session.subscribeSaveState(progress);
      void handle.done
        .then((result) => {
          unsubscribe();
          toast.dismiss(key);
          if (!result.rejected) undoToast(state.session, title);
        })
        .catch((error) => {
          unsubscribe();
          toast.dismiss(key);
          reportError(error);
        });
    });
  }

  async function clear(selection: GridSelection) {
    if (!editable()) return;
    const range = selectionRange(selection, state.rows.rowCount(), columns.length);
    if (!range) return;
    await loadRows(state.rows, range.start.row, range.end.row + 1, signal);
    const fields = visibleFields().slice(range.start.col, range.end.col + 1);
    const values = emptyValues(fields.filter((field) => !readOnly(field)));
    if (!Object.keys(values).length) return;
    state.session.run(
      recordCommands(
        'record.update',
        state.table.id,
        selectedRows(selection, state.rows.rowCount()).map((index) => ({
          id: state.rows.getRow(index)!.id,
          values,
        })),
      ),
    );
  }

  async function clearSourceValues(selection: GridSelection) {
    if (!editable()) return;
    const range = selectionRange(selection, state.rows.rowCount(), columns.length);
    if (!range) return;
    await loadRows(state.rows, range.start.row, range.end.row + 1, signal);
    const fields = visibleFields().slice(range.start.col, range.end.col + 1);
    const records = selectedRows(selection, state.rows.rowCount()).flatMap((index) => {
      const row = state.rows.getRow(index)!;
      const fieldIds = fields
        .filter((field) => field.source && row.overrides?.[field.id])
        .map((field) => field.id);
      return fieldIds.length ? [{ id: row.id, fieldIds }] : [];
    });
    const commands: CommandInput[] = [];
    for (let offset = 0; offset < records.length; offset += 1000)
      commands.push({
        kind: 'record.clearOverrides',
        tableId: state.table.id,
        records: records.slice(offset, offset + 1000),
      });
    if (commands.length) state.session.run(commands);
  }

  /** Down a column from the source, as far as the column beside it has values, as spreadsheets do. */
  async function fillExtent(source: CellRange): Promise<CellRange | null> {
    const fields = visibleFields();
    const count = state.rows.rowCount();
    const first = source.end.row + 1;
    const most = Math.max(1, Math.floor(FILL_LIMIT / (source.end.col - source.start.col + 1)));
    for (const col of [source.start.col - 1, source.end.col + 1]) {
      const field = fields[col];
      if (!field) continue;
      let last = source.end.row;
      let filled = true;
      for (let start = first; filled && start < count && last - source.end.row < most; start += 500) {
        const end = Math.min(count, start + 500, first + most);
        await loadRows(state.rows, start, end, signal);
        for (let row = start; row < end; row++) {
          const record = state.rows.getRow(row);
          if (api?.isRowHidden?.(row) || !record || isEmptyValue(cellValue(record, field))) {
            filled = false;
            break;
          }
          last = row;
        }
      }
      if (last > source.end.row)
        return { start: { row: first, col: source.start.col }, end: { row: last, col: source.end.col } };
    }
    return null;
  }

  async function fill(request: FillRequest) {
    if (!editable()) return;
    let target = request.target ?? (await fillExtent(request.source));
    if (!target) return;
    const vertical = request.direction === 'down' || request.direction === 'up';
    const width = target.end.col - target.start.col + 1;
    const height = target.end.row - target.start.row + 1;
    const capped = width * height > FILL_LIMIT;
    if (capped) {
      // Keep the cells nearest the source.
      const keep = Math.max(1, Math.floor(FILL_LIMIT / (vertical ? width : height)));
      target =
        request.direction === 'down'
          ? { start: target.start, end: { ...target.end, row: target.start.row + keep - 1 } }
          : request.direction === 'up'
            ? { start: { ...target.start, row: target.end.row - keep + 1 }, end: target.end }
            : request.direction === 'right'
              ? { start: target.start, end: { ...target.end, col: target.start.col + keep - 1 } }
              : { start: { ...target.start, col: target.end.col - keep + 1 }, end: target.end };
    }
    const top = Math.min(request.source.start.row, target.start.row);
    const bottom = Math.max(request.source.end.row, target.end.row);
    await loadRows(state.rows, top, bottom + 1, signal);
    // Loading values can yield long enough for a group to collapse.
    for (let row = top; row <= bottom; row++) if (api?.isRowHidden?.(row)) return;
    const plan = planFill({
      request: { ...request, target },
      fields: visibleFields(),
      rowAt: (index) => state.rows.getRow(index)!,
      readOnly,
      context: { ...state.format, attachments: state.session.attachments },
    });
    execute(() => {
      if (plan.records.length)
        state.session.run(recordCommands('record.update', state.table.id, plan.records));
      fillToast(state.session, plan, capped);
    });
    if (!request.target && api) {
      const block = { start: request.source.start, end: { ...target.end, col: request.source.end.col } };
      const active = api.getSelection().active ?? request.source.start;
      api.setSelection({ active, range: block, rows: { kind: 'none' } });
    }
  }

  function addRow(index: number, values: Record<string, CellValue> = {}) {
    index = Math.max(index, state.rows.pinnedCount?.() ?? 0);
    if (!editable() || state.table.source || state.table.joined) return;
    state.session.run(
      [{ kind: 'record.create', tableId: state.table.id, records: [{ id: newId('record'), values }] }],
      { placeAt: { viewId: state.view.id, index } },
    );
    // As in a spreadsheet, the new record's first cell is where typing goes next, so the button
    // that added it doesn't keep the focus (and Enter doesn't add another).
    const cell = { row: index, col: 0 };
    requestAnimationFrame(() => {
      if (!api) return;
      api.setSelection({ active: cell, range: { start: cell, end: cell }, rows: { kind: 'none' } });
      api.scrollToCell(cell, 'nearest');
      api.focus();
    });
  }

  const findDeps: FindDeps = {
    session: () => state.session,
    rows: () => state.rows,
    table: () => state.table,
    view: () => state.view,
    columns: () => columns,
    field: (id) => byId.get(id),
    format: () => state.format,
    editable,
    readOnly,
    grid: () => api,
    decorate: () => decorate(),
    replaced(cells) {
      undoToast(
        state.session,
        t(
          msg({
            id: 'grid.find.replacedToast',
            message: plural(cells, { one: 'Replaced # cell', other: 'Replaced # cells' }),
          }),
        ),
      );
    },
    signal,
  };
  finder.attach(findDeps);

  function groupChanges(from: number, groupKey?: string) {
    const groups = state.rows.groups?.() ?? [];
    const target = groups.find((group) => group.key === groupKey);
    const row = state.rows.getRow(from);
    if (!target || !row || (from >= target.start && from < target.start + target.count)) return [];
    // Boundaries already contain the server's normalized keys, including date buckets and arrays.
    const source = Object.assign(
      {},
      ...groups
        .filter((group) => from >= group.start && from < group.start + group.count)
        .map((group) => group.values),
    ) as Record<string, unknown>;
    return Object.entries(target.values).filter(([id, value]) => {
      const raw = row.values[id];
      const key =
        id in source
          ? source[id]
          : byId.get(id)?.type === 'checkbox'
            ? (raw ?? false)
            : raw === ''
              ? null
              : (raw ?? null);
      return JSON.stringify(key) !== JSON.stringify(value);
    });
  }

  function rowDropReason(from: number, to: number, groupKey?: string): string | null {
    const row = state.rows.getRow(from);
    if (state.view.config.locked)
      return t(msg({ id: 'grid.drag.lockedView', message: 'This view is locked.' }));
    if (!editable())
      return t(msg({ id: 'grid.drag.noAccess', message: 'You do not have access to change this.' }));
    if (!row) return t(msg({ id: 'grid.drag.loading', message: 'Wait for these records to load.' }));
    if (row.lock && !row.lock.canEdit)
      return t(msg({ id: 'grid.drag.lockedRecord', message: 'This record is locked.' }));
    const changes = groupChanges(from, groupKey);
    for (const [id, value] of changes) {
      const field = byId.get(id);
      if (!field)
        return t(msg({ id: 'grid.drag.noAccess', message: 'You do not have access to change this.' }));
      if (isComputedType(field.type))
        return t(msg({ id: 'grid.drag.computed', message: 'This group uses a computed field.' }));
      if (sourceReadOnly(field, state.table))
        return t(msg({ id: 'grid.drag.source', message: 'This source field is read-only.' }));
      if (readOnly(field))
        return t(msg({ id: 'grid.drag.lockedField', message: 'This grouping field cannot be changed.' }));
      const grouping = state.view.config.groups.find((group) => group.fieldId === id);
      if (
        (field.type === 'date' &&
          (field.options.includeTime || (grouping?.dateGranularity ?? 'day') !== 'day')) ||
        ['multipleSelect', 'user', 'link', 'attachment'].includes(field.type) ||
        Array.isArray(value)
      )
        return t(
          msg({
            id: 'grid.drag.lossyGroup',
            message: 'This group cannot be set without changing other values.',
          }),
        );
      const checked = validateFieldValue(field, value);
      if (checked)
        return t(msg({ id: 'grid.drag.invalid', message: 'This value does not fit the grouping field.' }));
    }
    if (changes.length) return null;
    if (!state.rows.getRow(to))
      return t(msg({ id: 'grid.drag.loading', message: 'Wait for these records to load.' }));
    if (state.view.config.sorts.length)
      return t(msg({ id: 'grid.drag.sorted', message: 'Remove the sort to reorder records.' }));
    if (readsSourceLive(state.table.source))
      return t(msg({ id: 'grid.drag.sourceOrder', message: 'This source controls the record order.' }));
    if (from < (state.rows.pinnedCount?.() ?? 0) || to < (state.rows.pinnedCount?.() ?? 0))
      return t(msg({ id: 'grid.drag.pinned', message: 'Unpin this record before reordering it.' }));
    return null;
  }
  const plainHost: GridHost<RowData> = {
    frozenRows: () => state.rows.pinnedCount?.() ?? 0,
    dragMessage(status, kind, index) {
      const position = index + 1;
      if (status === 'cancel') return t(msg({ id: 'grid.drag.canceled', message: 'Move canceled.' }));
      if (status === 'outside')
        return t(msg({ id: 'grid.drag.outside', message: 'Release here to cancel the move.' }));
      if (status === 'done') return t(msg({ id: 'grid.drag.done', message: 'Move finished.' }));
      if (status === 'start')
        return t(
          msg({
            id: 'grid.drag.start',
            message: 'Use arrow keys to choose a position, Enter to drop, or Escape to cancel.',
          }),
        );
      return kind === 'row'
        ? t(msg({ id: 'grid.drag.rowTarget', message: `Move to row ${position}` }))
        : t(msg({ id: 'grid.drag.columnTarget', message: `Move to column ${position}` }));
    },
    columnDropReason(from, to) {
      if (state.view.config.locked)
        return t(msg({ id: 'grid.drag.lockedView', message: 'This view is locked.' }));
      if (!schemaEditable())
        return t(msg({ id: 'grid.drag.noAccess', message: 'You do not have access to change this.' }));
      if (from === 0 || to === 0)
        return t(msg({ id: 'grid.drag.primary', message: 'The primary field stays first.' }));
      const frozen = Math.min(state.view.config.frozenFieldCount, columns.length);
      if (from < frozen !== to < frozen)
        return t(
          msg({
            id: 'grid.drag.frozenBoundary',
            message: 'Move this field within its frozen or scrolling columns.',
          }),
        );
      return null;
    },
    rowDropReason,
    onRowMove(from, to, groupKey) {
      if (rowDropReason(from, to, groupKey) !== null) return;
      const row = state.rows.getRow(from)!;
      const target = state.rows.getRow(to)!;
      const values = Object.fromEntries(groupChanges(from, groupKey)) as Record<string, CellValue>;
      state.session.run(
        Object.keys(values).length
          ? [{ kind: 'record.update', tableId: state.table.id, records: [{ id: row.id, values }] }]
          : [
              {
                kind: 'record.move',
                tableId: state.table.id,
                viewId: state.view.id,
                recordIds: [row.id],
                place: from < to ? { after: target.id } : { before: target.id },
              },
            ],
      );
    },
    onColumnGroupToggle(id) {
      if (schemaEditable())
        state.onConfig({
          columnGroups: state.view.config.columnGroups.map((group) =>
            group.id === id ? { ...group, collapsed: !group.collapsed } : group,
          ),
        });
    },
    getRow: (index) => {
      const row = state.rows.getRow(index);
      if (row) snapshots.set(row.id, row);
      return row;
    },
    ensureRows: (start, end) => state.rows.ensureRows(start, end),
    cellComment: (row, column) => {
      queueComments(row.id);
      const present = commentedCells.has(`${row.id}/${column.id}`);
      const field = byId.get(column.id)?.name ?? '';
      return present ? t(msg({ id: 'comments.cell.open', message: `Comments on ${field}` })) : null;
    },
    onCellComment: (cell) => {
      const target = find(cell);
      if (target) state.onExpand(target.row.id, target.field.id);
    },
    renderCell: (el, context) => {
      cellRenderer(el, context);
      const error = context.row ? refusedCells.get(`${context.row.id}:${context.column.id}`) : undefined;
      if (error) {
        el.setAttribute('aria-invalid', 'true');
        el.setAttribute('aria-description', error);
        el.title = error;
      } else {
        el.removeAttribute('aria-invalid');
        el.removeAttribute('aria-description');
      }
    },
    renderHeader: (el, column, index) => headerRenderer(el, column, index),
    renderRowHeader: rowRenderer,
    renderAddIcon: (button) => button.replaceChildren(icon(button.ownerDocument, faPlus)),
    renderFooter: (el, column) => footer.render(el, column),
    describeFooter: (index) => footer.describe(columns[index]?.id),
    onFooterActivate: (index, anchor) => {
      const fieldId = columns[index]?.id;
      // The primary field's footer counts records, and summaries are part of the view's settings.
      if (fieldId && fieldId !== state.table.primaryFieldId && schemaEditable())
        state.onSummary?.(fieldId, anchor);
    },
    rowClass: (row) => (state.rows.prompts().left.has(row.id) ? 'rio-grid-row-left' : null),
    editText: (row, column) => {
      const field = byId.get(column.id);
      return field ? editText(field, cellValue(row, field), state.format) : '';
    },
    canStartEdit(cell) {
      const target = find(cell);
      return Boolean(
        target && editable() && !readOnly(target.field) && (!target.row.lock || target.row.lock.canEdit),
      );
    },
    commitText(cell, text) {
      const target = find(cell);
      if (!target || !editable() || readOnly(target.field)) return null;
      if (target.row.lock && !target.row.lock.canEdit)
        return serverMessage(i18n, 'data.locks.recordLocked', { reason: target.row.lock.reason });
      const parsed = parseText(target.field, text, state.format);
      if (parsed.ok !== true)
        return serverMessage(
          i18n,
          parsed.ok === false && parsed.reason === 'notNumber'
            ? 'data.value.notNumber'
            : parsed.ok === false && parsed.reason === 'notDate'
              ? 'data.value.notDate'
              : parsed.ok === false && parsed.reason !== 'computed'
                ? parsed.reason
                : 'data.value.invalid',
        );
      refusedCells.delete(`${target.row.id}:${target.field.id}`);
      const issue = validateFieldValue(target.field, parsed.value);
      if (issue) return issue.message || serverMessage(i18n, issue.messageKey);
      try {
        state.session.run([
          {
            kind: 'record.update',
            tableId: state.table.id,
            records: [{ id: target.row.id, values: { [target.field.id]: parsed.value } }],
          },
        ]);
        return null;
      } catch (error) {
        return error instanceof Error
          ? serverMessage(i18n, error.message)
          : serverMessage(i18n, 'errors.internal');
      }
    },
    openEditor(request) {
      const field = byId.get(request.column.id);
      if (!field || !editable() || readOnly(field) || (request.row.lock && !request.row.lock.canEdit))
        return () => {};
      const options = optionAction(state.session);
      const textCell =
        field.type === 'longText' || field.type === 'json'
          ? { recordId: request.row.id, fieldId: field.id }
          : null;
      if (textCell) editingCell = textCell;
      const dispose = mountEditor(request, {
        router: state.router,
        field,
        session: state.session,
        format: { ...state.format, attachments: state.session.attachments },
        canEditOptions: schemaEditable(),
        apply: (value) => execute(() => options.apply(state.table.id, request.row.id, field.id, value)),
        addOption: (name) => options.add(field.id, name),
      });
      return () => {
        dispose();
        if (textCell && editingCell === textCell) {
          editingCell = null;
          if (api) presence(api.getSelection());
        }
      };
    },
    toggle: (cell) =>
      execute(() => {
        const target = find(cell);
        if (target && editable() && !readOnly(target.field))
          state.session.run([
            {
              kind: 'record.update',
              tableId: state.table.id,
              records: [
                {
                  id: target.row.id,
                  values: { [target.field.id]: cellValue(target.row, target.field) !== true },
                },
              ],
            },
          ]);
      }),
    copy,
    paste: (selection, data) => asyncAction(() => paste(selection, data)),
    clear: (selection) => asyncAction(() => clear(selection)),
    fill: (request) => asyncAction(() => fill(request)),
    onFind: (mode) => finder.open(mode),
    describeCell: (cell) => {
      const target = find(cell);
      const field = target?.field.name ?? '';
      return target
        ? describeCell(
            target.field,
            target.row,
            cell.row,
            { ...state.format, attachments: state.session.attachments },
            t,
          ) +
            (sourceReadOnly(target.field, state.table)
              ? ` ${t(overridesOff)}`
              : followsValues(target.field)
                ? ` ${t(matchedTooltip)}`
                : '') +
            (commentedCells.has(`${target.row.id}/${target.field.id}`)
              ? ` ${t(msg({ id: 'comments.cell.open', message: `Comments on ${field}` }))}`
              : '')
        : '';
    },
    onSelectionChange: (selection) => {
      presence(selection);
      const request = ++selectedRecordRequest;
      const index = selection.active?.row;
      if (!state.onSelectRecord || index === undefined || index >= state.rows.rowCount()) return;
      asyncAction(async () => {
        await loadRows(state.rows, index, index + 1, signal);
        const row = state.rows.getRow(index);
        if (!signal.aborted && request === selectedRecordRequest && row) state.onSelectRecord?.(row.id);
      });
    },
    onExpandRow: (index) =>
      asyncAction(async () => {
        await loadRows(state.rows, index, index + 1, signal);
        const row = state.rows.getRow(index);
        if (row) state.onExpand(row.id);
      }),
    onAddRow: () => execute(() => addRow(state.rows.rowCount())),
    onAddColumn: () => {
      if (schemaEditable()) state.onField(null);
    },
    onUndo: () => {
      void undoAction(state.session);
    },
    onRedo: () => {
      void undoAction(state.session, true);
    },
    onColumnResize: (id, width, final) => {
      if (final && schemaEditable())
        state.onConfig({ columnWidths: { ...state.view.config.columnWidths, [id]: width } });
    },
    onColumnMove: (id, toIndex) => {
      if (!schemaEditable()) return;
      const moved = columns.map((column) => column.id).filter((fieldId) => fieldId !== id);
      moved.splice(toIndex, 0, id);
      const destination = columns[toIndex]?.group?.id;
      const columnGroups = state.view.config.columnGroups.flatMap((group) => {
        const fieldIds = group.fieldIds.filter((fieldId) => fieldId !== id);
        if (group.id === destination) fieldIds.push(id);
        return fieldIds.length ? [{ ...group, fieldIds }] : [];
      });
      state.onConfig({
        columnGroups,
        fieldOrder: [
          ...moved,
          ...state.fields.map((field) => field.id).filter((fieldId) => !moved.includes(fieldId)),
        ],
      });
    },
    onHeaderActivate: (col, anchor) => {
      const rect = anchor.getBoundingClientRect();
      state.onMenu({ kind: 'header', col }, { x: rect.left, y: rect.bottom });
    },
    onContextMenu: (target, point) => state.onMenu(target, point),
  };

  const host = colorGridHost(plainHost, {
    colors: () => state.colors,
    find,
    locale: () => state.format.locale,
    t,
  });

  return {
    host,
    columns: () => columns,
    attach(grid: GridApi<RowData>) {
      api = grid;
      presence(grid.getSelection());
      decorate();
    },
    update(next: GridState): GridColumn[] | undefined {
      const previous = columns;
      const before = state;
      state = next;
      const role = next.session.role();
      // The cells, headers, and footer draw from these, so a change to any of them draws every row
      // again.  The grid reads everything else, such as the callbacks, the open record, and who is
      // where, at the moment it's used, so a parent drawing again with these unchanged leaves the
      // rows alone.
      const redraw =
        before.fields !== next.fields ||
        before.session !== next.session ||
        before.format !== next.format ||
        before.colors !== next.colors ||
        before.aiFields !== next.aiFields ||
        before.table !== next.table ||
        before.view.config !== next.view.config ||
        role !== drawnRole;
      drawnRole = role;
      columns = gridColumns(next.view, next.fields, next.table.primaryFieldId, next.table);
      if (redraw) {
        byId = new Map(next.fields.map((field) => [field.id, field]));
        cellRenderer = createCellRenderer({
          fieldsById: byId,
          session: next.session,
          format: next.format,
          rowHeight: next.view.config.rowHeight,
          colors: next.colors,
          aiFields: next.aiFields,
        });
        headerRenderer = createHeaderRenderer({
          fieldsById: byId,
          primaryFieldId: next.table.primaryFieldId,
          sourceName: next.table.source?.sourceName,
          mappedSources: (id) => {
            const mapping = next.table.joined?.fields.find((item) => item.outputFieldId === id);
            const schema = next.session.getSchema();
            return mapping
              ? joinedSources(mapping).flatMap((source) => {
                  const field = schema.fieldById.get(source.fieldId);
                  const table = schema.tableById.get(source.tableId);
                  return field && table
                    ? [t(msg({ id: 'joined.mapping.sourceLabel', message: `${table.name} ${field.name}` }))]
                    : [];
                })
              : [];
          },
          access: () => next.session.getSchema().access.fields,
          aiFields: next.aiFields,
          t,
        });
        footer = footerFor();
        api?.footerChanged();
      }
      const changed = JSON.stringify(previous) !== JSON.stringify(columns);
      if (changed && api) {
        const selection = api.getSelection();
        const remap = (cell: CellRef) => ({
          ...cell,
          col: Math.max(
            0,
            columns.findIndex((column) => column.id === previous[cell.col]?.id),
          ),
        });
        api.update({ columns });
        api.setSelection({
          ...selection,
          active: selection.active && remap(selection.active),
          range: selection.range && { start: remap(selection.range.start), end: remap(selection.range.end) },
        });
      }
      if (redraw) api?.rowsChanged();
      // Marks for who is where follow the people and the columns.
      if (redraw || changed || before.peers !== next.peers || before.view.id !== next.view.id) decorate();
      if (api) presence(api.getSelection());
      return changed ? columns : undefined;
    },
    recordsChanged(ids: ReadonlySet<string>) {
      const next: CellDecoration[] = [];
      for (const id of ids) {
        const row = state.session.cachedRecord(state.table.id, id);
        const before = snapshots.get(id);
        if (!row) continue;
        snapshots.set(id, row);
        const peer = state.peers.find((peer) => peer.userId === row.updatedBy);
        if (!before || !peer) continue;
        const index = state.rows.indexOf(id);
        if (index < 0) continue;
        columns.forEach((column, col) => {
          if (JSON.stringify(before.values[column.id]) !== JSON.stringify(row.values[column.id]))
            next.push({
              kind: 'flash',
              row: index,
              col,
              color: `var(--rio-aa-choice-${peer.color ?? presenceColor(peer.userId)})`,
            });
        });
      }
      if (next.length) {
        flashes = next;
        clearTimeout(flashTimer);
        decorate();
        flashTimer = setTimeout(() => {
          flashes = [];
          decorate();
        }, 900);
      }
    },
    decorate,
    /** The summary row's numbers as they stand, which the footer redraws with */
    setSummary(next: GridSummaryState) {
      if (next === summary) return;
      summary = next;
      footer = footerFor();
      api?.footerChanged();
    },
    find: finder,
    fill,
    applyPaste,
    clearSourceValues,
    paste,
    clear,
    copy,
    addRow,
    addGroup(group: GridGroupBoundary) {
      const values: Record<string, CellValue> = {};
      for (const [id, value] of Object.entries(group.values)) {
        const field = byId.get(id);
        if (!field || isComputedType(field.type) || readOnly(field)) continue;
        if (field.type === 'date' && value !== null) {
          const parsed = parseText(field, String(value), state.format);
          if (parsed.ok === true) values[id] = parsed.value;
        } else if (
          ['number', 'currency', 'percent', 'duration', 'rating'].includes(field.type) &&
          value !== null
        )
          values[id] = Number(value);
        else values[id] = value as CellValue;
      }
      addRow(group.start + group.count, values);
    },
    destroy() {
      clearTimeout(flashTimer);
      finder.detach(signal);
      clearRioSelection(state.session);
      state.session.setPresence(null);
      api = null;
      snapshots.clear();
    },
  };
}
