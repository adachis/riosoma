import { duplicateRecords } from '../../data/duplicate-actions';
import { useRef } from 'react';
import { Menu as AriaMenu } from 'react-aria-components';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { LIMITS, PINNED_RECORD_LIMIT, roleAllows } from '@riosoma/contracts';
import { MenuItem, Popover, toast, useConfirm } from '@riosoma/ui';
import { AI_FIELD_LIMITS, isEmptyValue, type AiFieldEstimate } from '@riosoma/contracts';
import { cancelRun, estimateRun, startRun } from '../../features/ai-fields/status';
import type { ContextTarget, GridApi } from '../../../../../packages/grid-core/src/types';
import type { RowData } from '@riosoma/contracts';
import type { GroupedGrid } from '../grouping/engine';
import { directionFamily, directionLabels } from '../../screens/database/view/messages';
import { newCondition } from '../../screens/database/view/filterValues';
import type { createGridController, GridState } from './controller';
import { loadRows, reportError, selectedRows, selectionRange, undoToast } from './actions';
import { useLevel } from '../../levels/context';
import { useFootprintFormat } from '../../features/ai-footprint/format';
import { useTrashPhrase } from '../../features/retention/window';

/** One entry of the grid's menu.  A disabled entry can say why in its description. */
interface GridMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  description?: string;
  run: () => void | Promise<void>;
}

export function GridMenu({
  state,
  target,
  point,
  grid,
  controller,
  signal,
  onClose,
  onFilter,
}: {
  state: GridState;
  target: ContextTarget;
  point: { x: number; y: number };
  grid: GridApi<RowData> & Partial<Pick<GroupedGrid, 'paste'>>;
  controller: ReturnType<typeof createGridController>;
  signal: AbortSignal;
  onClose(): void;
  onFilter(): void;
}) {
  const { t, i18n } = useLingui();
  const footprintFormat = useFootprintFormat();
  const trash = useTrashPhrase();
  const ask = useConfirm();
  const { offers } = useLevel();
  const anchor = useRef<HTMLSpanElement>(null);
  const editSchema = roleAllows(state.session.role(), 'editSchema');
  const editRecords = roleAllows(state.session.role(), 'editRecords');
  const field =
    target.kind === 'header'
      ? state.fields.find((field) => field.id === controller.columns()[target.col]?.id)
      : undefined;
  const row = target.kind === 'cell' ? target.cell.row : target.kind === 'rowHeader' ? target.row : -1;
  const selection = grid.getSelection();
  const indices = selectedRows(selection, state.rows.rowCount());
  const count = indices.length;
  const range = selectionRange(selection, state.rows.rowCount(), controller.columns().length);
  const selectedFields = range ? controller.columns().slice(range.start.col, range.end.col + 1) : [];
  const hasOverrides = indices.some((index) =>
    selectedFields.some((field) => state.rows.getRow(index)?.overrides?.[field.id]),
  );
  const manyCells = indices.length * selectedFields.length > 1;
  // AI fields: the clicked column's for a cell, or the header's own.
  const cellField =
    target.kind === 'cell'
      ? state.fields.find((item) => item.id === controller.columns()[target.cell.col]?.id)
      : undefined;
  const aiStatus = state.aiFields;
  const aiField = (field ?? cellField)?.ai ? (field ?? cellField) : undefined;
  const aiProblem = aiField ? aiStatus?.problem(aiField.id) : undefined;
  const aiJob = aiField ? aiStatus?.job(aiField.id) : undefined;
  const aiRows = target.kind === 'cell' ? (indices.includes(row) ? indices : [row]) : [];
  const action = (fn: () => void | Promise<void>) => {
    onClose();
    void Promise.resolve()
      .then(fn)
      .catch((error) => {
        if (!signal.aborted) reportError(error);
      });
  };
  const deleteRecords = async () => {
    if (
      count > 1 &&
      !(await ask({
        title: t({
          id: 'grid.record.deleteTitle',
          message: plural(count, { one: 'Delete # record?', other: 'Delete # records?' }),
        }),
        confirmLabel: t({
          id: 'grid.record.deleteMany',
          message: plural(count, { one: 'Delete # record', other: 'Delete # records' }),
        }),
        tone: 'danger',
      }))
    )
      return;
    if (!indices.length) return;
    await loadRows(state.rows, indices[0]!, indices.at(-1)! + 1, signal);
    const ids = indices.map((index) => state.rows.getRow(index)!.id);
    state.session.run(
      Array.from({ length: Math.ceil(ids.length / LIMITS.recordsPerCommand) }, (_, index) => ({
        kind: 'record.trash' as const,
        tableId: state.table.id,
        recordIds: ids.slice(index * LIMITS.recordsPerCommand, (index + 1) * LIMITS.recordsPerCommand),
      })),
    );
    undoToast(
      state.session,
      t({
        id: 'grid.record.deleted',
        message: plural(count, { one: 'Deleted # record', other: 'Deleted # records' }),
      }),
    );
  };
  /**
   * A bulk run's likely size, the way Rio's usage line words it: model, tokens, and cost, then the
   * estimated energy and carbon when the model has an estimate.
   */
  const estimateText = (estimate: AiFieldEstimate) => {
    const model = estimate.model;
    const low = i18n.number(estimate.tokens.low);
    const high = i18n.number(estimate.tokens.high);
    const money = (value: number) =>
      i18n.number(value, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
    const cheap = estimate.costUsd ? money(estimate.costUsd.low) : '';
    const dear = estimate.costUsd ? money(estimate.costUsd.high) : '';
    const size = estimate.costUsd
      ? t({
          id: 'fields.ai.estimateCost',
          message: `${model} · about ${low}–${high} tokens · ${cheap}–${dear}`,
        })
      : t({ id: 'fields.ai.estimate', message: `${model} · about ${low}–${high} tokens` });
    if (!estimate.footprint) return size;
    const footprint = footprintFormat.both(estimate.footprint);
    return t({ id: 'fields.ai.estimateFootprint', message: `${size} · estimate: ${footprint}` });
  };
  const generateAll = async (scope: 'all' | 'empty') => {
    if (!aiField) return;
    const estimate = await estimateRun(aiField.id, scope);
    const records = estimate.records;
    if (!records) {
      toast.show({
        tone: 'info',
        title: t({ id: 'fields.ai.nothing', message: 'There’s nothing to generate.' }),
      });
      return;
    }
    // More than a handful of records at once costs enough to ask first.
    if (
      estimate.needsConfirmation &&
      !(await ask({
        title: t({
          id: 'fields.ai.confirmTitle',
          message: plural(records, { one: 'Generate # value?', other: 'Generate # values?' }),
        }),
        message: estimateText(estimate),
        confirmLabel: t({
          id: 'fields.ai.confirm',
          message: plural(records, { one: 'Generate # value', other: 'Generate # values' }),
        }),
      }))
    )
      return;
    await startRun(aiField.id, { scope, confirmed: estimate.needsConfirmation });
    toast.show({
      tone: 'info',
      title: t({
        id: 'fields.ai.started',
        message: plural(records, { one: 'Generating # value', other: 'Generating # values' }),
      }),
      description: estimateText(estimate),
    });
    await aiStatus?.refresh();
  };
  const aiFieldItems =
    field?.ai && aiField
      ? [
          ...(aiJob?.state === 'running'
            ? [
                {
                  id: 'aiStop',
                  label: t({ id: 'fields.ai.stop', message: 'Stop generating' }),
                  disabled: !editRecords,
                  run: async () => {
                    await cancelRun(aiJob.id);
                    await aiStatus?.refresh();
                  },
                },
              ]
            : [
                {
                  id: 'aiAll',
                  label: t({ id: 'fields.ai.generateAll', message: 'Generate for all records' }),
                  disabled: !editRecords || Boolean(aiProblem),
                  run: () => generateAll('all'),
                },
                {
                  id: 'aiEmpty',
                  label: t({ id: 'fields.ai.generateEmpty', message: 'Generate for empty records' }),
                  disabled: !editRecords || Boolean(aiProblem),
                  run: () => generateAll('empty'),
                },
              ]),
        ]
      : [];
  const aiCellItems =
    cellField?.ai && aiRows.length <= AI_FIELD_LIMITS.confirmAbove
      ? [
          {
            id: 'aiCell',
            label: aiRows.some(
              (index) => !isEmptyValue(state.rows.getRow(index)?.values[cellField.id] ?? null),
            )
              ? t({ id: 'fields.ai.regenerate', message: 'Regenerate value' })
              : t({ id: 'fields.ai.generate', message: 'Generate value' }),
            disabled: !editRecords || Boolean(aiProblem),
            run: async () => {
              await loadRows(state.rows, aiRows[0]!, aiRows.at(-1)! + 1, signal);
              const ids = aiRows.flatMap((index) => state.rows.getRow(index)?.id ?? []);
              if (!ids.length) return;
              await startRun(cellField.id, { scope: 'records', recordIds: ids });
              await aiStatus?.refresh();
            },
          },
        ]
      : [];
  const fieldItems = field
    ? [
        {
          id: 'appearance',
          label: t({ id: 'grid.appearance.title', message: 'Headers and column groups' }),
          disabled: !editSchema || state.view.config.locked,
          run: () => state.onAppearance?.(field.id),
        },
        {
          id: 'duplicate',
          label: t({ id: 'duplicate.field.title', message: 'Duplicate field' }),
          disabled: !editSchema,
          run: () => state.onDuplicateField?.(field.id),
        },
        {
          id: 'edit',
          label: t({ id: 'grid.field.edit', message: 'Edit field' }),
          run: () => state.onField(field.id),
        },
        ...(['asc', 'desc'] as const).map((direction, index) => ({
          id: direction,
          label: i18n._(directionLabels[directionFamily(field)][index]!),
          disabled: field.type === 'changeLog',
          run: () =>
            state.onConfig({
              sorts: [
                { fieldId: field.id, direction },
                ...state.view.config.sorts.filter((sort) => sort.fieldId !== field.id),
              ].slice(0, LIMITS.sortsPerView),
            }),
        })),
        // Field permissions are Advanced.  A field, or a database, that already has some keeps its
        // way to them at every level.
        ...(state.onPermissions &&
        offers('fieldMenu', 'permissions', {
          ruledFields: state.session.getSchema().access.fields.has(field.id) ? 1 : 0,
        })
          ? [
              {
                id: 'permissions',
                label: t({ id: 'grid.field.permissions', message: 'Permissions' }),
                run: () => state.onPermissions?.(field.id),
              },
            ]
          : []),
        {
          id: 'filter',
          label: t({ id: 'grid.field.filter', message: 'Filter by this field' }),
          disabled: field.type === 'changeLog',
          run: () => {
            const filter = state.view.config.filter;
            state.onConfig({
              filter: filter
                ? { ...filter, conditions: [...filter.conditions, newCondition(field)] }
                : { conjunction: 'and', conditions: [newCondition(field)] },
            });
            onFilter();
          },
        },
        {
          id: 'hide',
          label: t({ id: 'grid.field.hide', message: 'Hide field' }),
          disabled: field.id === state.table.primaryFieldId,
          run: () => state.onConfig({ hiddenFieldIds: [...state.view.config.hiddenFieldIds, field.id] }),
        },
        {
          id: 'left',
          label: t({ id: 'grid.field.insertLeft', message: 'Insert left' }),
          run: () => state.onField(null, target.kind === 'header' ? target.col : 0),
        },
        {
          id: 'right',
          label: t({ id: 'grid.field.insertRight', message: 'Insert right' }),
          run: () => state.onField(null, target.kind === 'header' ? target.col + 1 : 0),
        },
        ...(field.id === state.table.primaryFieldId
          ? []
          : [
              {
                id: 'delete',
                label: t({ id: 'grid.field.delete', message: 'Delete field' }),
                run: async () => {
                  const name = field.name;
                  if (
                    await ask({
                      title: t({ id: 'grid.field.deleteTitle', message: `Delete ${name}?` }),
                      message: t({
                        id: 'grid.field.deleteBody',
                        message: `Its values are deleted for everyone.  You can restore it from the trash ${trash}.`,
                      }),
                      confirmLabel: t({ id: 'grid.field.delete', message: 'Delete field' }),
                      tone: 'danger',
                    })
                  ) {
                    state.session.run([{ kind: 'field.trash', fieldId: field.id }]);
                    undoToast(state.session, t({ id: 'grid.field.deleted', message: `Deleted ${name}` }));
                  }
                },
              },
            ]),
      ]
    : [];
  // A pin the view's filter excludes stays saved and still counts toward the limit, but is never
  // drawn.  The menu says how many there are and offers to unpin them, since the grid itself shows
  // no row to unpin.  A field's menu has no record to pin, so it asks nothing of the rows.
  const pinnedIds = row < 0 ? [] : state.view.config.pinnedRecordIds;
  const drawnPins =
    row < 0 || state.rows.loading()
      ? pinnedIds.length
      : Math.min(state.rows.pinnedCount?.() ?? pinnedIds.length, pinnedIds.length);
  const undrawnPins = Math.max(0, pinnedIds.length - drawnPins);
  const rowId = row < 0 ? '' : (state.rows.getRow(row)?.id ?? '');
  const isPinned = pinnedIds.includes(rowId);
  const pinsFull = pinnedIds.length >= PINNED_RECORD_LIMIT;
  const recordItems =
    row < 0
      ? []
      : [
          {
            id: 'duplicate',
            label: t({
              id: 'duplicate.records.menu',
              message: plural(count, { one: 'Duplicate record', other: 'Duplicate # records' }),
            }),
            disabled: !editRecords || Boolean(state.table.source || state.table.joined),
            run: async () => {
              await loadRows(state.rows, indices[0]!, indices.at(-1)! + 1, signal);
              await duplicateRecords(
                state.session,
                state.table.id,
                indices.map((index) => state.rows.getRow(index)!.id),
                state.view.id,
                state.format.timeZone,
              );
            },
          },
          {
            id: 'pin',
            label: isPinned
              ? t({ id: 'grid.pin.remove', message: 'Unpin record' })
              : t({ id: 'grid.pin.add', message: 'Pin record' }),
            disabled: !editSchema || state.view.config.locked || (!isPinned && pinsFull),
            ...(!isPinned && pinsFull && undrawnPins
              ? {
                  description: t({
                    id: 'grid.pin.limitUndrawn',
                    message: plural(undrawnPins, {
                      one: 'The limit of 20 pins is reached, and # pinned record is not shown in this view.',
                      other:
                        'The limit of 20 pins is reached, and # pinned records are not shown in this view.',
                    }),
                  }),
                }
              : {}),
            run: () => {
              if (rowId)
                state.onConfig({
                  pinnedRecordIds: isPinned
                    ? pinnedIds.filter((item) => item !== rowId)
                    : [...pinnedIds, rowId],
                });
            },
          },
          ...(undrawnPins && editSchema && !state.view.config.locked
            ? [
                {
                  id: 'unpinUndrawn',
                  label: t({
                    id: 'grid.pin.unpinUndrawn',
                    message: plural(undrawnPins, {
                      one: 'Unpin the record not shown',
                      other: 'Unpin the # records not shown',
                    }),
                  }),
                  disabled: false,
                  run: async () => {
                    // The pins the view draws are its first rows, so they're kept and the rest go.
                    await loadRows(state.rows, 0, drawnPins, signal);
                    const kept: string[] = [];
                    for (let index = 0; index < drawnPins; index++) {
                      const id = state.rows.getRow(index)?.id;
                      if (id) kept.push(id);
                    }
                    state.onConfig({ pinnedRecordIds: kept });
                  },
                },
              ]
            : []),
          {
            id: 'above',
            label: t({ id: 'grid.record.insertAbove', message: 'Insert record above' }),
            disabled: !editRecords,
            run: () => controller.addRow(row),
          },
          {
            id: 'below',
            label: t({ id: 'grid.record.insertBelow', message: 'Insert record below' }),
            disabled: !editRecords,
            run: () => controller.addRow(row + 1),
          },
          {
            id: 'expand',
            label: t({ id: 'grid.record.expand', message: 'Expand record' }),
            run: () => controller.host.onExpandRow?.(row),
          },
          {
            id: 'copy',
            label: t({ id: 'grid.record.copy', message: 'Copy' }),
            run: async () => {
              const range = indices.length
                ? ([indices[0]!, indices.at(-1)! + 1] as const)
                : ([row, row + 1] as const);
              await loadRows(state.rows, ...range, signal);
              const copied = controller.copy(selection);
              if (copied) await navigator.clipboard.writeText(copied.text);
            },
          },
          {
            id: 'paste',
            label: t({ id: 'grid.record.paste', message: 'Paste' }),
            disabled: !editRecords,
            run: async () => {
              if (navigator.clipboard.read) {
                const items = await navigator.clipboard.read();
                let text = '',
                  html: string | null = null;
                for (const item of items) {
                  if (item.types.includes('text/plain'))
                    text = await (await item.getType('text/plain')).text();
                  if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
                }
                await (grid.paste ?? controller.paste)(selection, { text, html });
              } else
                await (grid.paste ?? controller.paste)(selection, {
                  text: await navigator.clipboard.readText(),
                  html: null,
                });
            },
          },
          {
            id: 'clear',
            label: t({ id: 'grid.record.clear', message: 'Clear' }),
            disabled: !editRecords,
            run: () => controller.clear(selection),
          },
          {
            id: 'delete',
            label:
              count > 1
                ? t({
                    id: 'grid.record.deleteMany',
                    message: plural(count, { one: 'Delete # record', other: 'Delete # records' }),
                  })
                : t({ id: 'grid.record.delete', message: 'Delete record' }),
            disabled: !editRecords,
            run: deleteRecords,
          },
        ];
  const items: GridMenuItem[] = field
    ? [
        ...fieldItems.map((item) => ({
          ...item,
          disabled: !editSchema || ('disabled' in item && item.disabled),
        })),
        ...aiFieldItems,
      ]
    : [
        ...(cellField && rowId
          ? [
              {
                id: 'cellComments',
                label: t({ id: 'comments.cell.menu', message: 'Cell comments' }),
                run: () => state.onExpand(rowId, cellField.id),
              },
            ]
          : []),
        ...aiCellItems,
        ...recordItems.filter(
          (item) =>
            !(state.table.source || state.table.joined) || !['above', 'below', 'delete'].includes(item.id),
        ),
        ...(hasOverrides && editRecords
          ? [
              {
                id: 'source',
                label: manyCells
                  ? t({ id: 'synced.override.clearMany', message: 'Use the source values' })
                  : t({ id: 'synced.override.clear', message: 'Use the source value' }),
                disabled: false,
                run: () => controller.clearSourceValues(selection),
              },
            ]
          : []),
      ];
  if (state.view.config.groups?.length)
    items.push(
      {
        id: 'collapseGroups',
        label: t({ id: 'grid.group.collapseAll', message: 'Collapse all' }),
        disabled: false,
        run: () => grid.collapseGroups?.(true),
      },
      {
        id: 'expandGroups',
        label: t({ id: 'grid.group.expandAll', message: 'Expand all' }),
        disabled: false,
        run: () => grid.collapseGroups?.(false),
      },
    );
  return (
    <>
      <span ref={anchor} className="rio-grid-menu-anchor" style={{ left: point.x, top: point.y }} />
      <Popover
        isOpen
        triggerRef={anchor}
        placement="bottom start"
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <AriaMenu
          autoFocus="first"
          className="rio-menu"
          aria-label={field?.name ?? t({ id: 'grid.record.expand', message: 'Expand record' })}
          onAction={(key) => {
            const item = items.find((item) => item.id === key);
            if (item && !item.disabled) action(item.run);
          }}
        >
          {items.map((item) => (
            <MenuItem
              key={item.id}
              id={item.id}
              isDisabled={Boolean(item.disabled)}
              description={'description' in item ? item.description : undefined}
              tone={item.id === 'delete' ? 'danger' : 'default'}
            >
              {item.label}
            </MenuItem>
          ))}
        </AriaMenu>
      </Popover>
    </>
  );
}
