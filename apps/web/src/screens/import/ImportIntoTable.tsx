import { HelpDialogTitle } from '../../docs/HelpDialogTitle';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { I18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import {
  newId,
  roleAllows,
  type DocumentColumnType,
  type CellValues,
  type FieldMeta,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  ListBoxItem,
  Modal,
  ProgressBar,
  Select,
} from '@riosoma/ui';
import { ApiError } from '../../api';
import type { DatabaseSession } from '../../data';
import { useSchema } from '../../data';
import { serverMessage } from '../../messages/useServerMessage';
import { makeColumns, mapColumns, type Column, type People, type Preview } from './columns';
import { ImportPreview } from './ImportPreview';
import { ImportSummary } from './ImportSummary';
import type { ImportSource } from './source';
import { FileChooser, SheetLimits, SheetPicker } from './SourcePicker';
import {
  canBeKey,
  currentValues,
  keyIndex,
  summarize,
  usedChoices,
  writeImport,
  ImportRefusal,
  type RepeatChoice,
  type UpsertPlan,
} from './upsert';
import { useImportFile } from './useImportFile';
import { useCelebrations } from '../../features/celebrations/useCelebrations';
import { inspectFile, planFile } from './workerClient';
import { anchor } from '../../demos/anchors';
import './ImportDialog.css';

export interface ImportIntoTableProps {
  session: DatabaseSession;
  tableId: string;
  onClose: () => void;
}

interface Loaded {
  source: ImportSource;
  header: boolean;
  preview: Preview;
  columns: Column[];
}

interface Analysis {
  columns: Column[];
  key: number | null;
  plan: UpsertPlan;
  current: Map<string, CellValues>;
}

const UNREADABLE = msg({ id: 'import.unreadableFile', message: 'This file couldn’t be read.' });

function reasonText(i18n: I18n, error: unknown): string {
  if (error instanceof ApiError) return serverMessage(i18n, error.info.messageKey, error.info.params);
  if (error instanceof Error && error.message === 'import.tooLarge')
    return serverMessage(i18n, 'errors.tooLarge');
  return i18n._(UNREADABLE);
}

interface Report {
  groupId?: string;
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
  stopped: boolean;
  /** A command was refused or couldn't be sent, which the error already says */
  failed?: boolean;
}

/**
 * Imports a CSV or Excel file into a table that already exists.  File columns map onto the
 * table's fields, and with a key field, rows whose key a record already has update that record
 * while the rest are added.  The dialog shows what will happen before anything is written, writes
 * in batches that undo as one step, and says what happened at the end.
 */
export function ImportIntoTable({ session, tableId, onClose }: ImportIntoTableProps) {
  const { t, i18n } = useLingui();
  const { celebrate } = useCelebrations();
  const schema = useSchema(session);
  const table = schema?.tableById.get(tableId);
  const tableFields = useMemo(() => schema?.fields.get(tableId) ?? [], [schema, tableId]);
  const fieldById = useMemo(() => schema?.fieldById ?? new Map<string, FieldMeta>(), [schema]);
  const createChoices = roleAllows(schema?.database.role, 'editSchema');
  const input = useImportFile();
  const { file, sheets, source } = input;
  const [header, setHeader] = useState(true);
  const [loaded, setLoaded] = useState<Loaded>();
  const [keyFieldId, setKeyFieldId] = useState<string | null>(null);
  const [repeat, setRepeat] = useState<RepeatChoice>('first');
  const [analysis, setAnalysis] = useState<Analysis>();
  const [readProgress, setReadProgress] = useState(0);
  const [phase, setPhase] = useState<'setup' | 'running' | 'done'>('setup');
  const [progress, setProgress] = useState({ added: 0, updated: 0 });
  const [report, setReport] = useState<Report>();
  const [undone, setUndone] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string>();
  const cancel = useRef(false);
  const indexes = useRef(new Map<string, Promise<Map<string, string[]>>>());
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const current = loaded && loaded.source === source && loaded.header === header ? loaded : undefined;
  const columns = current?.columns;
  const keyColumn = columns?.findIndex((column) => column.include && column.field.id === keyFieldId) ?? -1;
  const key = keyColumn >= 0 ? keyColumn : null;
  const keyField = key === null ? undefined : columns?.[key]?.field;
  const mapped = columns?.filter((column) => column.include) ?? [];
  const ready = analysis && analysis.columns === columns && analysis.key === key ? analysis : undefined;
  const reading = Boolean(source) && !current && !error;
  const analyzing = Boolean(current && mapped.length && !ready && !error);
  const summary = useMemo(
    () => (ready ? summarize(ready.plan, ready.current, fieldById, keyField?.id ?? null, repeat) : undefined),
    [ready, fieldById, keyField, repeat],
  );
  const writes = summary ? summary.added.length + summary.updated.length : 0;

  useEffect(
    () => () => {
      cancel.current = true;
    },
    [],
  );
  useEffect(() => {
    if (!source || current) return;
    const controller = new AbortController();
    void inspectFile(source, header, controller.signal, setReadProgress)
      .then((preview) => {
        if (controller.signal.aborted) return;
        if (!preview.stats.length) throw new Error('import.unreadable');
        const made = makeColumns(preview, header, (number) =>
          t({ id: 'import.fieldName', message: `Field ${number}` }),
        );
        setLoaded({ source, header, preview, columns: mapColumns(made, tableFields) });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(t({ id: 'import.unreadableFile', message: 'This file couldn’t be read.' }));
      });
    return () => controller.abort();
  }, [source, current, header, tableFields, t]);
  useEffect(() => {
    if (!source || !columns || phase !== 'setup' || !columns.some((column) => column.include)) return;
    const controller = new AbortController();
    const signal = controller.signal;
    const timer = setTimeout(() => {
      void (async () => {
        const field = key === null ? undefined : columns[key]?.field;
        let existing: Map<string, string[]> | null = null;
        if (field) {
          // A table's keys are read once for each key field and kept while the dialog is open.
          let index = indexes.current.get(field.id);
          if (!index) {
            index = keyIndex(tableId, field);
            indexes.current.set(field.id, index);
            index.catch(() => indexes.current.delete(field.id));
          }
          existing = await index;
        }
        // People are read as they are now, since a user field matches their names and email addresses.
        const people: People = new Map(
          [...session.getSchema().collaborators].map(([id, person]) => [
            id,
            { name: person.name, email: person.email },
          ]),
        );
        const plan = await planFile(
          source,
          header,
          { columns, key, existing, timeZone, people, createChoices },
          signal,
        );
        const fieldIds = columns
          .filter((column, index) => column.include && index !== key)
          .map((column) => column.field.id);
        const values = field
          ? await currentValues(
              tableId,
              plan.matches.map((match) => match.recordIds[0]!),
              fieldIds,
              signal,
            )
          : new Map<string, CellValues>();
        if (!signal.aborted) setAnalysis({ columns, key, plan, current: values });
      })().catch((error: unknown) => {
        if (!signal.aborted) setError(reasonText(i18n, error));
      });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [source, columns, key, header, phase, session, createChoices, tableId, timeZone, i18n]);

  function choose(next?: File, types?: DocumentColumnType[]) {
    if (!next || phase !== 'setup') return;
    setLoaded(undefined);
    setAnalysis(undefined);
    setReadProgress(0);
    setError(undefined);
    if (types) setHeader(true);
    input.choose(next, types);
  }
  function changeColumns(next: Column[]) {
    setError(undefined);
    if (current) setLoaded({ ...current, columns: next });
  }
  async function start() {
    if (!summary || !ready || summary.blocked || !writes || phase !== 'setup') return;
    cancel.current = false;
    setPhase('running');
    setProgress({ added: 0, updated: 0 });
    setError(undefined);
    const creates = summary.added.map((row) => ({ id: newId('record'), values: row.values }));
    const updates = summary.updated.map((row) => ({
      id: row.recordId,
      values: row.values,
      ...(row.baseValues ? { baseValues: row.baseValues } : {}),
    }));
    let groupId: string | undefined;
    let written = { added: 0, updated: 0 };
    try {
      const result = await writeImport({
        databaseId: session.databaseId,
        tableId,
        timeZone,
        choices: usedChoices(ready.plan.choices, [...creates, ...updates]),
        field: (fieldId) => session.getSchema().fieldById.get(fieldId),
        updates,
        creates,
        canceled: () => cancel.current,
        onProgress: (next) => {
          written = next;
          setProgress(next);
        },
        onApplied: (id) => {
          groupId = id;
          session.adoptAction?.(id, {
            kind: creates.length ? 'record.create' : 'record.update',
            count: creates.length || summary.updated.reduce((count, row) => count + row.changed.length, 0),
            name: table?.name ?? '',
          });
        },
      });
      setReport({
        groupId,
        added: result.added,
        updated: result.updated,
        unchanged: summary.unchanged.length,
        skipped: summary.skipped.length,
        stopped: result.canceled,
      });
      const clean = !summary.skipped.length && !summary.repeated.length && !summary.ambiguous.length;
      if (!result.canceled && clean) celebrate('importClean', tableId);
    } catch (failure) {
      const reason = reasonText(i18n, failure instanceof ImportRefusal ? failure.cause : failure);
      if (failure instanceof ImportRefusal) {
        const numbers = new Map([
          ...creates.map((record, index) => [record.id, summary.added[index]!.row] as const),
          ...updates.map((record, index) => [record.id, summary.updated[index]!.row] as const),
        ]);
        const refusedRows = failure.recordIds
          .map((id) => numbers.get(id)!)
          .filter(Number.isFinite)
          .sort((a, b) => a - b);
        const ranges: string[] = [];
        for (let index = 0; index < refusedRows.length; index++) {
          const start = refusedRows[index]!;
          let end = start;
          while (refusedRows[index + 1] === end + 1) end = refusedRows[++index]!;
          const first = i18n.number(start);
          const last = i18n.number(end);
          ranges.push(start === end ? first : t({ id: 'import.rowRange', message: `${first}–${last}` }));
        }
        const rows = new Intl.ListFormat(i18n.locale).format(ranges);
        setError(t({ id: 'import.refusedRows', message: `Rows ${rows} were refused: ${reason}` }));
      } else setError(t({ id: 'import.failed', message: `The import stopped: ${reason}` }));
      setReport({ groupId, ...written, unchanged: 0, skipped: 0, stopped: true, failed: true });
    } finally {
      setPhase('done');
    }
  }
  async function undo() {
    if (!report?.groupId || undoing) return;
    setUndoing(true);
    try {
      const outcome = await session.undo(report.groupId);
      if (!outcome.nothing) setUndone(true);
    } catch (reason) {
      setError(reasonText(i18n, reason));
    } finally {
      setUndoing(false);
    }
  }

  const tableName = table?.name ?? '';
  const filename = file?.name ?? '';
  const keyFields = mapped.map((column) => column.field).filter(canBeKey);
  const total = summary ? writes : 0;
  const done = progress.added + progress.updated;
  const message = input.error ?? error;
  return (
    <Modal
      isOpen
      isDismissable={phase !== 'running'}
      isKeyboardDismissDisabled={phase === 'running'}
      className="rio-import"
      onOpenChange={(open) => {
        if (!open && phase !== 'running') onClose();
      }}
    >
      <Dialog hideCloseButton>
        <HelpDialogTitle moduleId="importing" section="fixing-columns" anchorId="import.dialog">
          {file
            ? t({ id: 'import.into.fileTitle', message: `Import ${filename} into ${tableName}` })
            : t({ id: 'import.into.title', message: `Import into ${tableName}` })}
        </HelpDialogTitle>
        <DialogBody>
          <div className="rio-import__body">
            {phase === 'setup' && (
              <FileChooser onChoose={choose} databaseId={session.databaseId} tableId={tableId} />
            )}
            {input.loading && (
              <ProgressBar
                isIndeterminate
                label={t({ id: 'import.reading', message: `Reading ${filename}` })}
              />
            )}
            <SheetPicker
              sheets={sheets}
              sheet={input.sheet}
              disabled={phase !== 'setup'}
              onSheet={(index) => {
                setReadProgress(0);
                setError(undefined);
                input.setSheet(index);
              }}
            />
            <SheetLimits sheets={sheets.slice(input.sheet, input.sheet + 1)} />
            {source && (
              <Checkbox
                isSelected={header}
                isDisabled={phase !== 'setup'}
                onChange={(next) => {
                  setReadProgress(0);
                  setError(undefined);
                  setHeader(next);
                }}
              >
                {t({ id: 'import.header', message: 'Use the first row as field names' })}
              </Checkbox>
            )}
            {reading && (
              <ProgressBar
                value={readProgress * 100}
                label={t({ id: 'import.reading', message: `Reading ${filename}` })}
              />
            )}
            {current && (
              <Select
                label={t({ id: 'import.key.label', message: 'Match records on' })}
                description={
                  keyField
                    ? t({
                        id: 'import.key.help',
                        message: `A row whose ${keyField.name} a record already has updates that record.  The rest are added.`,
                      })
                    : t({ id: 'import.key.noneHelp', message: 'Every row is added as a new record.' })
                }
                selectedKey={keyField?.id ?? 'none'}
                isDisabled={phase !== 'setup'}
                onSelectionChange={(selected) => {
                  setError(undefined);
                  setKeyFieldId(selected === 'none' ? null : String(selected));
                }}
              >
                <ListBoxItem id="none">
                  {t({ id: 'import.key.none', message: 'Nothing, add every row' })}
                </ListBoxItem>
                {keyFields.map((field) => (
                  <ListBoxItem key={field.id} id={field.id}>
                    {field.name}
                  </ListBoxItem>
                ))}
              </Select>
            )}
            {current && (
              <ImportPreview
                preview={current.preview}
                columns={current.columns}
                primary={0}
                onPrimary={() => undefined}
                onChange={changeColumns}
                fields={tableFields}
                misfits={[]}
                disabled={phase !== 'setup'}
              />
            )}
            {current && !mapped.length && (
              <p className="rio-import__note">
                {t({
                  id: 'import.into.noColumns',
                  message: 'Choose a field for at least one column to import it.',
                })}
              </p>
            )}
            {analyzing && phase === 'setup' && (
              <ProgressBar
                isIndeterminate
                label={t({ id: 'import.into.checking', message: `Comparing with ${tableName}` })}
              />
            )}
            {summary && phase === 'setup' && (
              <ImportSummary
                summary={summary}
                columns={current?.columns ?? []}
                fields={fieldById}
                keyName={keyField?.name ?? null}
                repeat={repeat}
                onRepeat={setRepeat}
              />
            )}
            {phase !== 'setup' && (
              <ProgressBar
                value={done}
                maxValue={Math.max(1, total)}
                label={t({ id: 'import.into.progress', message: 'Importing' })}
                valueLabel={t({
                  id: 'import.into.progressValue',
                  message: `${i18n.number(done)} of ${i18n.number(total)}`,
                })}
              />
            )}
            {report && <ImportReport report={report} undone={undone} />}
            {message && <Banner tone="danger">{message}</Banner>}
          </div>
        </DialogBody>
        <DialogFooter>
          {phase === 'done' ? (
            <>
              {report?.groupId && !undone && (
                <Button isPending={undoing} onPress={() => void undo()}>
                  {t({ id: 'import.undo', message: 'Undo' })}
                </Button>
              )}
              <Button variant="primary" onPress={onClose}>
                {t({ id: 'import.into.close', message: 'Done' })}
              </Button>
            </>
          ) : (
            <>
              <Button
                onPress={() => {
                  if (phase === 'running') cancel.current = true;
                  else onClose();
                }}
              >
                {phase === 'running'
                  ? t({ id: 'import.stop', message: 'Stop' })
                  : t({ id: 'import.cancel', message: 'Cancel' })}
              </Button>
              <Button
                variant="primary"
                isDisabled={!summary || summary.blocked || !writes || analyzing || phase !== 'setup'}
                onPress={() => void start()}
                {...anchor('import.start')}
              >
                {t({ id: 'import.start', message: 'Import' })}
              </Button>
            </>
          )}
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}

function ImportReport({ report, undone }: { report: Report; undone: boolean }) {
  const { t } = useLingui();
  const label = t({ id: 'import.report.label', message: 'What the import did' });
  if (undone)
    return (
      <p role="status" aria-label={label} className="rio-import__report">
        {t({ id: 'import.report.undone', message: 'The import was undone.' })}
      </p>
    );
  const lines = [
    report.stopped && !report.failed
      ? t({ id: 'import.report.stopped', message: 'The import stopped before the end.' })
      : '',
    t({
      id: 'import.report.added',
      message: plural(report.added, { one: 'Added # record.', other: 'Added # records.' }),
    }),
    t({
      id: 'import.report.updated',
      message: plural(report.updated, { one: 'Updated # record.', other: 'Updated # records.' }),
    }),
    report.unchanged && !report.stopped
      ? t({
          id: 'import.report.unchanged',
          message: plural(report.unchanged, {
            one: '# record was already up to date.',
            other: '# records were already up to date.',
          }),
        })
      : '',
    report.skipped && !report.stopped
      ? t({
          id: 'import.report.skipped',
          message: plural(report.skipped, { one: 'Skipped # row.', other: 'Skipped # rows.' }),
        })
      : '',
  ].filter(Boolean);
  return (
    <div role="status" aria-label={label} className="rio-import__report">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}
