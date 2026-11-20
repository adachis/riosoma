import { useViewColors } from '../colors/useViewColors';
import { SparklineChart } from '../colors/SparklineChart';
import { useEffect, useId, useMemo, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  cellValue,
  GridConfig,
  type ViewMeta,
  idsOf,
  isComputedType,
  roleAllows,
  type CellValue,
  type FieldMeta,
  type RecordBlock,
  type RowData,
} from '@riosoma/contracts';
import { Icon } from '@riosoma/icons';
import { ApiError } from '../../../api';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { AttachmentPanel } from '../../../files/AttachmentPanel';
import { FieldButton } from '../../../fields/FieldButton';
import { createLinkedRecord, LinkPicker } from '../../../grid/editors/LinkEditor';
import { formatCell, type FormatContext } from '../../../grid/format';
import { optionAction, reportError } from '../../../grid/view/actions';
import { fieldTypeInfo } from '../fields/fieldTypes';
import { followsValues } from '../joins/matched';
import { FieldEditor } from '../record/FieldEditor';
import { sourceReadOnly } from '../synced/override';
import { BlockStatus, BlockUnavailable } from './BlockStatus';
import type { BlockContext } from './context';
import { followed, shownFields } from './model';
import '../record/RecordCard.css';

/**
 * A record block: the fields of the record picked in the records block it follows, in the block's
 * order, as the record card shows them.  People who can edit records edit them here.
 */
export function RecordBody({
  block,
  context,
  nameOf,
}: {
  block: RecordBlock;
  context: BlockContext;
  nameOf(blockId: string): string;
}) {
  const { t } = useLingui();
  const source = followed(context.page, block.recordsBlockId);
  if (!source)
    return (
      <p className="rio-interface-hint">
        {roleAllows(context.session.role(), 'editSchema')
          ? t({
              id: 'interfaces.record.noSource',
              message: 'This block shows the record picked in a records block.  Choose one in its settings.',
            })
          : t({ id: 'interfaces.record.nothing', message: 'There’s nothing to show here yet.' })}
      </p>
    );
  const { tableId } = source.source;
  if (!context.schema.tableById.get(tableId)) return <BlockUnavailable />;
  const recordId = context.selected[source.id];
  const sourceName = nameOf(source.id);
  if (!recordId)
    return (
      <p className="rio-interface-hint">
        {t({ id: 'interfaces.record.pick', message: `Pick a record in ${sourceName} to see it here.` })}
      </p>
    );
  return (
    <RecordFields
      key={`${tableId}/${recordId}`}
      session={context.session}
      schema={context.schema}
      tableId={tableId}
      recordId={recordId}
      fields={shownFields(context.schema, tableId, block.fieldIds)}
      format={context.format}
      canEdit={context.canEditRecords}
      view={context.schema.viewById.get(source.source.viewId)}
      sourceId={source.id}
      onMissing={context.onMissing}
    />
  );
}

function RecordFields({
  session,
  schema,
  tableId,
  recordId,
  fields,
  format,
  canEdit,
  sourceId,
  view,
  onMissing,
}: {
  session: DatabaseSession;
  schema: SchemaState;
  view?: ViewMeta;
  tableId: string;
  recordId: string;
  fields: readonly FieldMeta[];
  format: FormatContext;
  canEdit: boolean;
  /** The records block the record was picked in */
  sourceId: string;
  onMissing(blockId: string): void;
}) {
  const { t } = useLingui();
  const id = useId();
  const colors = useViewColors(
    session,
    view ?? { id: '', tableId, config: GridConfig.parse({}) },
    fields,
    format,
  );
  const [loaded, setLoaded] = useState<{ row: RowData | null; failed: string | null }>(() => ({
    row: session.cachedRecord(tableId, recordId) ?? null,
    failed: null,
  }));
  // Bumped when the record changes, so the block shows the session's newest copy.
  const [, setVersion] = useState(0);
  const options = useMemo(() => optionAction(session), [session]);
  useEffect(() => {
    let canceled = false;
    session
      .getRecord(tableId, recordId)
      .then((row) => {
        if (canceled) return;
        if (!row) onMissing(sourceId);
        else setLoaded({ row, failed: null });
      })
      .catch((error: unknown) => {
        if (canceled) return;
        const failed = error instanceof ApiError ? error.info.messageKey : 'errors.internal';
        setLoaded((current) => ({ ...current, failed }));
      });
    return () => {
      canceled = true;
    };
  }, [session, tableId, recordId, sourceId, onMissing]);
  // Edits here and anywhere else show at once, from the session's copy.
  useEffect(
    () =>
      session.subscribeRecords(tableId, (ids) => {
        if (ids.has(recordId)) setVersion((value) => value + 1);
      }),
    [session, tableId, recordId],
  );
  const row = session.cachedRecord(tableId, recordId) ?? loaded.row;
  const historyIds = fields
    .filter((field) => field.type === 'changeLog')
    .map((field) => field.id)
    .join(',');
  useEffect(() => {
    if (!recordId || !historyIds) return;
    return session?.watchHistory?.(tableId, recordId, historyIds.split(','));
  }, [session, tableId, recordId, historyIds]);
  if (!row) return loaded.failed ? <BlockStatus error={{ messageKey: loaded.failed }} /> : <BlockStatus />;
  const table = schema.tableById.get(tableId);
  const change = (fieldId: string, value: CellValue) => {
    try {
      options.apply(tableId, recordId, fieldId, value);
    } catch (error) {
      reportError(error);
    }
  };
  return (
    <div className="rio-interface-record">
      {fields.map((field) => {
        const labelId = `${id}-${field.id}`;
        const value = cellValue(row, field);
        const paint = colors.cell(row, field);
        const locked = sourceReadOnly(field, table) || followsValues(field);
        const readOnly = !canEdit || locked || isComputedType(field.type);
        return (
          <div key={field.id} className="rio-record-card__row">
            <div id={labelId} className="rio-record-card__label">
              <Icon icon={fieldTypeInfo(field.type).icon} />
              <span>{field.name}</span>
            </div>
            <div>
              {paint?.sparkline && <SparklineChart paint={paint.sparkline} />}
              {field.type === 'attachment' ? (
                <AttachmentPanel
                  field={field}
                  recordId={row.id}
                  ids={idsOf(value)}
                  session={session}
                  details={format.attachments}
                  locale={format.locale}
                  readOnly={readOnly}
                  layout="grid"
                  onChange={(ids) => change(field.id, ids)}
                />
              ) : field.type === 'link' ? (
                <LinkPicker
                  field={field}
                  selected={idsOf(value)}
                  recordId={row.id}
                  currentValues={row.values}
                  format={format}
                  session={session}
                  readOnly={readOnly}
                  expanded={false}
                  onChange={(ids) => change(field.id, ids)}
                  onCreate={(name) => createLinkedRecord(session, field, row.id, name, idsOf(value), format)}
                />
              ) : row.errors?.[field.id] ? (
                <span className="rio-record-card__error">
                  {t({ id: 'grid.formula.error', message: '#ERROR' })}
                </span>
              ) : field.type === 'button' ? (
                <div className="rio-record-card__value" role="group" aria-labelledby={labelId}>
                  <FieldButton field={field} row={row} format={format} showReason />
                </div>
              ) : readOnly ? (
                <div className="rio-record-card__value" role="group" aria-labelledby={labelId}>
                  <span>{formatCell(field, value, format)}</span>
                </div>
              ) : (
                <FieldEditor
                  session={session}
                  recordId={row.id}
                  values={row.values}
                  key={`${row.id}:${field.type}`}
                  field={field}
                  value={value}
                  format={format}
                  labelId={labelId}
                  autoFocus={false}
                  canEditOptions={roleAllows(session.role(), 'editSchema')}
                  onChange={change}
                  onAddOption={options.add}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
