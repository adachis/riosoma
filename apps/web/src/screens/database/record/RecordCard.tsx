import { duplicateRecords } from '../../../data/duplicate-actions';
import { reportError } from '../../../messages/reportError';
import { LineItemsEditor } from '../../../fields/LineItemsEditor';
import { LazyBoundary } from '../../../shell/lazy';
import { SparklineChart } from '../colors/SparklineChart';
import { RecordLockControl } from './RecordLockControl';
import { RecordValue } from './RecordValue';
import { ComputedPin } from '../synced/ComputedPin';
import { RecordPayment } from '../../../features/payments/RecordPayment';
import { overrideDescription, overridesOff, sourceReadOnly } from '../synced/override';
import { followsValues, matchedTooltip } from '../joins/matched';
import '../synced/synced.css';
import {
  faArrowUpRightFromSquare,
  faChevronDown,
  faChevronUp,
  faEllipsis,
  faTableColumns,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import {
  cellValue,
  idsOf,
  isComputedType,
  isOverrideType,
  isSignatureValue,
  prettyJson,
  type CellValue,
  type FieldMeta,
  type RowData,
} from '@riosoma/contracts';
import { Icon } from '@riosoma/icons';
import { useQuery } from '@tanstack/react-query';
import {
  Avatar,
  Banner,
  Button,
  DialogBody,
  DialogTitle,
  Menu,
  MenuItem,
  MenuTrigger,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Tooltip,
  TooltipTrigger,
} from '@riosoma/ui';
import { I18nProvider } from 'react-aria-components';
import { lazy, useEffect, useId, useRef, useState } from 'react';
import { formatCell, type FormatContext } from '../../../grid/format';
import { fieldInfo } from '../fields/fieldTypes';
import { useSchema, type DatabaseSession } from '../../../data';
import { ApiError } from '../../../api';
import { signatureRequestsQuery } from '../../../features/signatures/requests';
import { useLevel } from '../../../levels/context';
import { useFeatureCommands } from '../../../levels/palette';
import { LinkPicker, createLinkedRecord } from '../../../grid/editors/LinkEditor';
import { useServerMessage } from '../../../messages/useServerMessage';
import { AttachmentPanel } from '../../../files/AttachmentPanel';
import { CommentsPanel } from './Comments';
import { HistoryPanel } from './History';
import { FieldEditor } from './FieldEditor';
import type { TextCellHandle } from '../../../fields/TextCellInput';
import { useBlocker, useRouter } from '@tanstack/react-router';
import { FieldButton } from '../../../fields/FieldButton';
import { SignatureView } from '../../../fields/SignatureView';
import { RichTextView } from '../../../fields/richText/lazy';
import { ColorMark } from '../colors/ColorMark';
import type { ViewColors } from '../colors/paint';
import { printMenu } from '../print/messages';
import { lockedMark } from '../permissions/restricted';
import { RecordShell, type RecordLayout } from './RecordShell';
import { recordPageHref } from '../screen/routes';
import './RecordCard.css';
import './RecordCard.print.css';
import { SignatureHistoryPanel } from '../../../features/signatures/HistoryPanel';

// Printing, and the PDF library behind it, load only when someone prints a record.
const PrintRecordDialog = lazy(() =>
  import('../print/PrintRecordDialog').then((module) => ({ default: module.PrintRecordDialog })),
);
const RecordWordDialog = lazy(() =>
  import('./RecordWordDialog').then((module) => ({ default: module.RecordWordDialog })),
);
const RequestDialog = lazy(() =>
  import('../../../features/signatures/RequestDialog').then((module) => ({ default: module.RequestDialog })),
);

export interface RecordCardProps {
  layout?: RecordLayout;
  onLayoutChange?: (layout: 'card' | 'panel') => void;
  fullPageHref?: string;
  fields: readonly FieldMeta[];
  session?: DatabaseSession;
  viewId?: string;
  onOpenRecord?: (tableId: string, recordId: string) => void;
  loadError?: string;
  primaryFieldId: string;
  row: RowData | null;
  format: FormatContext;
  /** The view's conditional colors, marked beside the title and each colored field */
  colors?: ViewColors;
  readOnly: boolean;
  canEditOptions: boolean;
  /** Zero-based position, matching the rows API. */
  position: { index: number; total: number } | null;
  onChange: (fieldId: string, value: CellValue) => void;
  onAddOption: (fieldId: string, name: string) => string;
  onPrevious?: () => void;
  onNext?: () => void;
  onClose: () => void;
}

export function RecordCard({
  layout = 'card',
  onLayoutChange,
  fullPageHref,
  fields,
  session,
  viewId,
  onOpenRecord,
  loadError,
  primaryFieldId,
  row,
  format: suppliedFormat,
  colors,
  readOnly,
  canEditOptions,
  position,
  onChange,
  onAddOption,
  onPrevious,
  onNext,
  onClose,
}: RecordCardProps) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const [linkedRecord, setLinkedRecord] = useState<{ tableId: string; recordId: string }>();
  const [printing, setPrinting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [requestingSignature, setRequestingSignature] = useState(false);
  const format = {
    ...suppliedFormat,
    linked: session?.linked ?? suppliedFormat.linked,
    attachments: session?.attachments ?? suppliedFormat.attachments,
    fieldsById: session?.getSchema().fieldById ?? suppliedFormat.fieldsById,
  };
  const id = useId();
  const primary = fields.find((field) => field.id === primaryFieldId);
  const title = row && primary ? formatCell(primary, cellValue(row, primary), format) : '';
  const recordColor = row && colors ? colors.record(row) : null;
  const cellThread = fields.some(
    (field) => field.id === new URLSearchParams(window.location.search).get('cellField'),
  );
  const firstEditable =
    cellThread || readOnly || (row?.lock && !row.lock.canEdit)
      ? undefined
      : fields.find(
          (field) =>
            !isComputedType(field.type) &&
            !followsValues(field) &&
            !sourceReadOnly(field, session?.getSchema().tableById.get(field.tableId)),
        )?.id;
  const body = useRef<HTMLDivElement>(null);
  const textInputs = useRef(new Map<string, TextCellHandle>());
  const router = useRouter({ warn: false });
  function canLeaveRecord() {
    const focused = document.activeElement;
    // Blur starts the same save as leaving a field by keyboard or pointer.
    if (focused instanceof HTMLElement && body.current?.contains(focused)) focused.blur();
    // A field can retain a draft after another window takes focus without a blur event.
    const inputs = [...textInputs.current.values()];
    const saved = inputs.map((input) => input.save());
    return saved.every(Boolean) && inputs.every((input) => input.canClose());
  }
  function leaveRecord(action?: () => void) {
    if (canLeaveRecord()) action?.();
  }
  const recordId = row?.id;
  // Comments and history come from the server, so a card without a session has neither to show.
  const tableId = primary?.tableId ?? fields[0]?.tableId ?? '';
  const historyIds = fields
    .filter((field) => field.type === 'changeLog')
    .map((field) => field.id)
    .join(',');
  useEffect(() => {
    if (!recordId || !historyIds) return;
    return session?.watchHistory?.(tableId, recordId, historyIds.split(','));
  }, [session, tableId, recordId, historyIds]);
  const pageView = session?.getSchema().views.get(tableId)?.[0];
  const pageHref =
    fullPageHref ??
    (session && recordId && pageView
      ? recordPageHref(session.databaseId, tableId, pageView.id, recordId)
      : undefined);
  const side = session && row && tableId ? { session, tableId, recordId: row.id } : undefined;
  useEffect(() => {
    if (!recordId || (!cellThread && (layout !== 'card' || !firstEditable))) return;
    // The dialog's opening focus runs first; then choose the first field instead of the heading.
    let canceled = false;
    queueMicrotask(() => {
      if (!canceled)
        body.current
          ?.querySelector<HTMLElement>(
            cellThread
              ? '.rio-comments__composer textarea'
              : 'input, textarea, [role="spinbutton"], [contenteditable="true"]',
          )
          ?.focus();
    });
    return () => {
      canceled = true;
    };
  }, [recordId, firstEditable, layout, cellThread]);
  const previous = position && position.index <= 0 ? undefined : onPrevious;
  const next = position && position.index >= position.total - 1 ? undefined : onNext;
  const index = (position?.index ?? 0) + 1;
  const total = position?.total ?? 0;
  const previousLabel = t({ id: 'record.previous', message: 'Previous record' });
  const nextLabel = t({ id: 'record.next', message: 'Next record' });
  const closeLabel = t({ id: 'record.close', message: 'Close' });
  const moreLabel = t({ id: 'print.record.menu', message: 'More for this record' });
  // Signature requests are Standard.  Below it a record that already has some keeps the way to
  // request more, and the palette always offers it.  Requests carry signers' addresses, so they
  // are only for people who can edit the record.
  const { offers, tidies } = useLevel();
  const signing = side && !readOnly ? side : undefined;
  const [signatureRequests, setSignatureRequests] = useState(0);
  const counting = signing && tidies('signatures') ? signing : undefined;
  const requestable = Boolean(signing) && offers('recordMenu', 'signatures', { signatureRequests });
  useFeatureCommands(
    'record.signatures',
    signing
      ? [
          {
            place: 'recordMenu:signatures',
            target: {
              id: signing.recordId,
              name: title.trim() || t({ id: 'record.untitled', message: 'Untitled record' }),
            },
            run: () => setRequestingSignature(true),
          },
        ]
      : [],
  );

  if (linkedRecord && session)
    return (
      <LinkedRecordCard
        key={linkedRecord.recordId}
        session={session}
        tableId={linkedRecord.tableId}
        recordId={linkedRecord.recordId}
        format={format}
        readOnly={readOnly}
        layout={layout}
        onLayoutChange={onLayoutChange}
        onClose={() => setLinkedRecord(undefined)}
      />
    );

  return (
    <I18nProvider locale={format.locale}>
      {router && <RecordNavigationGuard canLeave={canLeaveRecord} />}
      {counting ? (
        <SignatureRequestCount
          key={counting.recordId}
          tableId={counting.tableId}
          recordId={counting.recordId}
          onCount={setSignatureRequests}
        />
      ) : null}
      <div
        className={layout === 'card' ? undefined : `rio-record-host rio-record-host--${layout}`}
        onKeyDownCapture={(event) => {
          if (event.target instanceof Element && event.target.closest('.rio-files')) return;
          if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault();
            event.stopPropagation();
            (event.key === 'ArrowUp' ? previous : next)?.();
          }
        }}
      >
        <RecordShell
          layout={layout}
          titleId={`${id}-title`}
          wide={Boolean(session && tableId)}
          onClose={() => leaveRecord(onClose)}
        >
          <div className="rio-record-card__header">
            {recordColor && <ColorMark record={recordColor} />}
            <DialogTitle id={`${id}-title`}>
              {row === null
                ? t({ id: 'record.loading', message: 'Loading record' })
                : title.trim() || t({ id: 'record.untitled', message: 'Untitled record' })}
            </DialogTitle>
            {position && (
              <span className="rio-record-card__position">
                {t({ id: 'record.position', message: `${index} of ${total}` })}
              </span>
            )}
            <div className="rio-record-card__navigation">
              {onLayoutChange && (
                <MenuTrigger>
                  <Button
                    icon={faTableColumns}
                    variant="quiet"
                    aria-label={t({ id: 'record.layout', message: 'Record layout' })}
                  />
                  <Menu
                    aria-label={t({ id: 'record.layout', message: 'Record layout' })}
                    selectionMode="single"
                    selectedKeys={layout === 'page' ? [] : [layout]}
                    onAction={(key) => leaveRecord(() => onLayoutChange(key === 'panel' ? 'panel' : 'card'))}
                  >
                    <MenuItem id="card">{t({ id: 'record.layout.card', message: 'Card' })}</MenuItem>
                    <MenuItem id="panel">{t({ id: 'record.layout.panel', message: 'Side panel' })}</MenuItem>
                  </Menu>
                </MenuTrigger>
              )}
              {pageHref && (
                <a
                  className="rio-record-card__popout"
                  href={pageHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t({ id: 'record.openWindow', message: 'Open in new window' })}
                  title={t({ id: 'record.openWindow', message: 'Open in new window' })}
                >
                  <Icon icon={faArrowUpRightFromSquare} />
                </a>
              )}
              <TooltipTrigger>
                <Button
                  icon={faChevronUp}
                  variant="quiet"
                  aria-label={previousLabel}
                  isDisabled={!previous}
                  onPress={() => leaveRecord(previous)}
                />
                <Tooltip>{previousLabel}</Tooltip>
              </TooltipTrigger>
              <TooltipTrigger>
                <Button
                  icon={faChevronDown}
                  variant="quiet"
                  aria-label={nextLabel}
                  isDisabled={!next}
                  onPress={() => leaveRecord(next)}
                />
                <Tooltip>{nextLabel}</Tooltip>
              </TooltipTrigger>
              {row && (
                <MenuTrigger>
                  <Button icon={faEllipsis} variant="quiet" aria-label={moreLabel} />
                  <Menu aria-label={moreLabel}>
                    {session && recordId && !readOnly && (
                      <MenuItem
                        onAction={() => {
                          void duplicateRecords(
                            session,
                            tableId,
                            [recordId],
                            viewId ?? pageView?.id,
                            format.timeZone,
                          ).catch(reportError);
                        }}
                      >
                        {t({ id: 'duplicate.record.title', message: 'Duplicate record' })}
                      </MenuItem>
                    )}
                    {session && (
                      <MenuItem
                        onAction={() => {
                          const text = fields
                            .map((field) => row.values[field.id])
                            .filter((value) => typeof value === 'string')
                            .join(' ')
                            .slice(0, 2000);
                          leaveRecord(() =>
                            window.location.assign(
                              `/${encodeURIComponent(session.databaseId)}/settings/similar?${new URLSearchParams({ table: tableId, query: text })}`,
                            ),
                          );
                        }}
                      >
                        {t({ id: 'knowledge.similar', message: 'Find similar records' })}
                      </MenuItem>
                    )}
                    <MenuItem onAction={() => setPrinting(true)}>{i18n._(printMenu)}</MenuItem>
                    {requestable && (
                      <MenuItem onAction={() => setRequestingSignature(true)}>
                        {t({ id: 'signatures.request.title', message: 'Request signatures' })}
                      </MenuItem>
                    )}
                    {/* The server makes the document, so it's for cards read through a session. */}
                    {side && (
                      <MenuItem onAction={() => setDownloading(true)}>
                        {t({ id: 'export.record.menu', message: 'Download as Word' })}
                      </MenuItem>
                    )}
                  </Menu>
                </MenuTrigger>
              )}
              <Button
                icon={faXmark}
                variant="quiet"
                aria-label={closeLabel}
                onPress={() => leaveRecord(onClose)}
              />
            </div>
          </div>
          <DialogBody
            className="rio-record-card__body"
            aria-busy={row === null}
            tabIndex={row === null ? 0 : undefined}
          >
            {row && <RecordLockControl key={row.id} session={session} tableId={tableId} row={row} />}
            {loadError && <Banner tone="danger">{message(loadError)}</Banner>}
            <div className="rio-record-card__columns">
              <div ref={body} className="rio-record-card__fields">
                {fields.map((field) => {
                  const sourceLocked = sourceReadOnly(
                    field,
                    session?.getSchema().tableById.get(field.tableId),
                  );
                  // Links that follow values change with the values, never by hand, and a
                  // locked field changes only for the people its lock names.
                  const permissionLocked =
                    session?.getSchema().access.fields.get(field.id)?.editable === false;
                  const locked =
                    sourceLocked ||
                    followsValues(field) ||
                    permissionLocked ||
                    Boolean(row?.lock && !row.lock.canEdit);
                  const lockedText =
                    row?.lock && !row.lock.canEdit
                      ? message('data.locks.recordLocked', { reason: row.lock.reason })
                      : sourceLocked
                        ? i18n._(overridesOff)
                        : permissionLocked
                          ? i18n._(lockedMark)
                          : i18n._(matchedTooltip);
                  const explanation = row ? overrideDescription(field, row, format, i18n._.bind(i18n)) : '';
                  const labelId = `${id}-${field.id}`;
                  const value = row === null ? null : cellValue(row, field);
                  const text = formatCell(field, value, format);
                  const paint = row && colors ? colors.cell(row, field) : null;
                  return (
                    <div
                      className={`rio-record-card__row${explanation ? ' rio-synced-override rio-synced-record' : ''}`}
                      key={field.id}
                      title={explanation || (locked ? lockedText : undefined)}
                    >
                      <div id={labelId} className="rio-record-card__label">
                        <Icon icon={fieldInfo(field).icon} />
                        <span>{field.name}</span>
                        {paint && <ColorMark paint={paint} />}
                      </div>
                      <div className="rio-synced-record-value">
                        {explanation && <span className="rio-synced-explanation">{explanation}</span>}
                        {locked && <span className="rio-synced-explanation">{lockedText}</span>}
                        {row && explanation && session && !readOnly && (
                          <Button
                            size="sm"
                            variant="quiet"
                            onPress={() =>
                              session.run([
                                {
                                  kind: 'record.clearOverrides',
                                  tableId: field.tableId,
                                  records: [{ id: row.id, fieldIds: [field.id] }],
                                },
                              ])
                            }
                          >
                            {t({ id: 'synced.override.clear', message: 'Use the source value' })}
                          </Button>
                        )}
                        {row &&
                          session &&
                          !readOnly &&
                          !permissionLocked &&
                          isOverrideType(field.type) &&
                          session.getSchema().tableById.get(field.tableId)?.allowComputedOverrides && (
                            <ComputedPin
                              key={`${row.id}:${field.id}`}
                              field={field}
                              row={row}
                              session={session}
                            />
                          )}
                        {paint?.sparkline && <SparklineChart paint={paint.sparkline} />}
                        {row === null ? (
                          <div className="rio-record-card__placeholder" aria-hidden="true" />
                        ) : field.type === 'attachment' ? (
                          <AttachmentPanel
                            key={`${row.id}:${field.id}`}
                            field={field}
                            recordId={row.id}
                            ids={idsOf(value)}
                            session={session}
                            details={format.attachments}
                            locale={format.locale}
                            readOnly={readOnly || locked}
                            layout="grid"
                            onChange={(ids) => onChange(field.id, ids)}
                          />
                        ) : field.type === 'lineItems' ? (
                          <LineItemsEditor
                            key={`${row.id}:${field.id}`}
                            field={field}
                            recordId={row.id}
                            value={value}
                            session={session}
                            format={format}
                            readOnly={readOnly || locked}
                          />
                        ) : field.type === 'link' ? (
                          <LinkPicker
                            key={`${row.id}:${field.id}`}
                            field={field}
                            selected={idsOf(value)}
                            recordId={row.id}
                            currentValues={row.values}
                            format={format}
                            session={session}
                            readOnly={readOnly || locked}
                            expanded={false}
                            hidden={row.hiddenLinks?.[field.id] ?? 0}
                            onChange={(ids) => onChange(field.id, ids)}
                            onCreate={
                              session
                                ? (name) =>
                                    createLinkedRecord(session, field, row.id, name, idsOf(value), format)
                                : undefined
                            }
                            onOpen={
                              onOpenRecord || session
                                ? (recordId) => {
                                    leaveRecord(() => {
                                      if (onOpenRecord) onOpenRecord(field.options.linkedTableId, recordId);
                                      else
                                        setLinkedRecord({ tableId: field.options.linkedTableId, recordId });
                                    });
                                  }
                                : undefined
                            }
                          />
                        ) : row.errors?.[field.id] ? (
                          <span className="rio-record-card__error" title={message(row.errors[field.id]!)}>
                            {t({ id: 'grid.formula.error', message: '#ERROR' })}
                          </span>
                        ) : field.type === 'button' ? (
                          // A button works for everyone who can see the record, editors or not.
                          <div className="rio-record-card__value" role="group" aria-labelledby={labelId}>
                            <FieldButton field={field} row={row} format={format} showReason />
                          </div>
                        ) : readOnly || locked || isComputedType(field.type) ? (
                          <RecordValue labelId={labelId}>
                            {(field.type === 'createdBy' || field.type === 'lastModifiedBy') && text && (
                              <Avatar
                                personId={typeof value === 'string' ? value : undefined}
                                name={text}
                                color="gray"
                                size="sm"
                              />
                            )}
                            {field.type === 'signature' && isSignatureValue(value) ? (
                              <>
                                <SignatureView value={value} format={format} />
                                <span>{text}</span>
                              </>
                            ) : field.type === 'json' && typeof value === 'string' ? (
                              <pre className="rio-json-view">{prettyJson(value)}</pre>
                            ) : field.type === 'longText' &&
                              field.options.richText &&
                              typeof value === 'string' ? (
                              <RichTextView value={value} />
                            ) : (
                              <span>{text}</span>
                            )}
                          </RecordValue>
                        ) : (
                          <FieldEditor
                            ref={(input) => {
                              if (input) textInputs.current.set(field.id, input);
                              else textInputs.current.delete(field.id);
                            }}
                            session={session}
                            recordId={row.id}
                            values={row.values}
                            key={`${row.id}:${field.type}`}
                            field={field}
                            value={value}
                            format={format}
                            labelId={labelId}
                            autoFocus={layout === 'card' && field.id === firstEditable}
                            canEditOptions={canEditOptions}
                            onChange={onChange}
                            onAddOption={onAddOption}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {side && (
                <div className="rio-record-card__side">
                  <Tabs key={cellThread ? 'cell' : 'record'} defaultSelectedKey="comments">
                    <TabList>
                      <Tab id="comments">{t({ id: 'record.tab.comments', message: 'Comments' })}</Tab>
                      <Tab id="history">{t({ id: 'record.tab.history', message: 'History' })}</Tab>
                      {/* Requests carry signers' addresses, so only people who can edit the record see them. */}
                      {!readOnly && (
                        <Tab id="signatures">
                          {t({ id: 'signatures.history.tab', message: 'Signatures' })}
                        </Tab>
                      )}
                    </TabList>
                    {/* A thread is keyed to its record so navigating never shows the last one. */}
                    <TabPanel id="comments">
                      <CommentsPanel
                        key={side.recordId}
                        session={side.session}
                        tableId={side.tableId}
                        recordId={side.recordId}
                      />
                    </TabPanel>
                    <TabPanel id="history">
                      {!readOnly && side && <RecordPayment tableId={side.tableId} recordId={side.recordId} />}
                      <HistoryPanel
                        key={side.recordId}
                        session={side.session}
                        tableId={side.tableId}
                        recordId={side.recordId}
                        format={format}
                      />
                    </TabPanel>
                    {!readOnly && (
                      <TabPanel id="signatures">
                        <SignatureHistoryPanel
                          key={side.recordId}
                          tableId={side.tableId}
                          recordId={side.recordId}
                        />
                      </TabPanel>
                    )}
                  </Tabs>
                </div>
              )}
            </div>
          </DialogBody>
        </RecordShell>
      </div>
      {/* Beside the card, not in it, so keys pressed in the dialog never reach the card's shortcuts. */}
      {printing && row && (
        <LazyBoundary size="dialog" onDismiss={() => setPrinting(false)}>
          <PrintRecordDialog
            databaseName={session?.getSchema().database.name ?? ''}
            tableName={session?.getSchema().tableById.get(tableId)?.name ?? ''}
            row={row}
            fields={fields}
            primaryFieldId={primaryFieldId}
            format={format}
            colors={colors}
            onClose={() => setPrinting(false)}
          />
        </LazyBoundary>
      )}
      {downloading && side && (
        <LazyBoundary size="dialog" onDismiss={() => setDownloading(false)}>
          <RecordWordDialog
            tableId={side.tableId}
            recordId={side.recordId}
            onClose={() => setDownloading(false)}
          />
        </LazyBoundary>
      )}
      {requestingSignature && side && row && (
        <LazyBoundary size="dialog" onDismiss={() => setRequestingSignature(false)}>
          <RequestDialog
            tableId={side.tableId}
            row={row}
            fields={fields}
            attachments={format.attachments}
            onClose={() => setRequestingSignature(false)}
          />
        </LazyBoundary>
      )}
    </I18nProvider>
  );
}

function RecordNavigationGuard({ canLeave }: { canLeave(): boolean }) {
  useBlocker({ shouldBlockFn: () => !canLeave(), enableBeforeUnload: false });
  return null;
}

function LinkedRecordCard({
  layout,
  onLayoutChange,
  session,
  tableId,
  recordId,
  format,
  readOnly,
  onClose,
}: {
  layout: RecordLayout;
  onLayoutChange?: RecordCardProps['onLayoutChange'];
  session: DatabaseSession;
  tableId: string;
  recordId: string;
  format: FormatContext;
  readOnly: boolean;
  onClose: () => void;
}) {
  const schema = useSchema(session);
  const [row, setRow] = useState<RowData | null>(() => session.cachedRecord(tableId, recordId) ?? null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    const unsubscribe = session.subscribeRecords(tableId, (ids) => {
      if (ids.has(recordId)) setRow(session.cachedRecord(tableId, recordId) ?? null);
    });
    void session
      .getRecord(tableId, recordId)
      .then((row) => {
        if (active) {
          setRow(row);
          if (!row) setError('errors.notFound');
        }
      })
      .catch((error: unknown) => {
        if (active) setError(error instanceof ApiError ? error.info.messageKey : 'errors.offline');
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [session, tableId, recordId]);
  return (
    <RecordCard
      layout={layout}
      onLayoutChange={onLayoutChange}
      session={session}
      fields={schema?.fields.get(tableId) ?? []}
      primaryFieldId={schema?.tableById.get(tableId)?.primaryFieldId ?? ''}
      row={row}
      loadError={error}
      format={format}
      readOnly={readOnly}
      canEditOptions={false}
      position={null}
      onClose={onClose}
      onChange={(fieldId, value) =>
        session.run([
          { kind: 'record.update', tableId, records: [{ id: recordId, values: { [fieldId]: value } }] },
        ])
      }
      onAddOption={() => ''}
    />
  );
}

/**
 * Counts a record's signature requests, for a card whose level would otherwise tidy away the way to
 * request more.  It shares the history tab's list, so a request made or canceled shows in both.
 */
function SignatureRequestCount({
  tableId,
  recordId,
  onCount,
}: {
  tableId: string;
  recordId: string;
  onCount(count: number): void;
}) {
  const requests = useQuery(signatureRequestsQuery(tableId, recordId));
  const count = requests.data?.requests.length ?? 0;
  useEffect(() => onCount(count), [count, onCount]);
  return null;
}
