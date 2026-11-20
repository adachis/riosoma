import { HelpDialogTitle } from '../../docs/HelpDialogTitle';
import { useEffect, useRef, useState } from 'react';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { isPrimaryType, newId, type DocumentColumnType } from '@riosoma/contracts';
import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  Modal,
  ProgressBar,
  toast,
} from '@riosoma/ui';
import { ApiError } from '../../api';
import { adoptDatabaseAction, undoDatabaseAction, type DatabaseSession } from '../../data';
import { serverMessage } from '../../messages/useServerMessage';
import { makeColumns, specFor, uniqueNames, type Column, type Preview } from './columns';
import { ImportPreview } from './ImportPreview';
import { importRecords, type ImportResult } from './importRecords';
import { undoImport } from './undoImport';
import { FileChooser, SheetLimits, SheetPicker } from './SourcePicker';
import { useImportFile } from './useImportFile';
import { useCelebrations } from '../../features/celebrations/useCelebrations';
import { inspectFile, streamFile, validateFile } from './workerClient';
import { anchor } from '../../demos/anchors';
import './ImportDialog.css';

export interface ImportDialogProps {
  databaseId: string;
  session?: Pick<DatabaseSession, 'adoptAction' | 'undo'>;
  onClose: () => void;
  onDone: (tableId: string) => void;
}
export interface ImportFlowProps {
  documentImport?: boolean;
  /** Adds a table to this database.  Without it, the import starts a database. */
  databaseId?: string;
  session?: Pick<DatabaseSession, 'adoptAction' | 'undo'>;
  onClose: () => void;
  onDone: (id: string) => void;
}
export function ImportDialog(props: ImportDialogProps) {
  return <ImportFlow {...props} />;
}

/** One sheet's (or a CSV file's) preview, and the choices made about its columns. */
interface Plan {
  preview: Preview;
  columns: Column[];
  primary: number;
  prepared?: { columns: Column[]; misfits: number[] };
  /** The columns `prepared` was checked against */
  preparedFor?: Column[];
}

function invalidPlan(plan: Plan): boolean {
  const included = plan.columns.filter((column) => column.include);
  const names = included.map((column) => column.name.trim().toLowerCase());
  const primary = plan.columns[plan.primary];
  return (
    !included.length ||
    names.some((name) => !name) ||
    new Set(names).size !== names.length ||
    !primary?.include ||
    !isPrimaryType(primary.field.type)
  );
}

/**
 * Starts a table, or a whole database, from a CSV or Excel file.  A workbook's sheets each keep
 * their own preview, and a new database can take every sheet as a table of its own.
 */
export function ImportFlow({ databaseId, session, documentImport, onClose, onDone }: ImportFlowProps) {
  const { t, i18n } = useLingui();
  const { celebrate, observe } = useCelebrations();
  const input = useImportFile();
  const { file, sheets, source } = input;
  const [header, setHeader] = useState(true);
  const [plans, setPlans] = useState<Record<string, Plan>>({});
  const [everySheet, setEverySheet] = useState(false);
  const [readProgress, setReadProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const cancel = useRef(false);
  const active = useRef(false);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const key = !source ? '' : source.kind === 'csv' ? 'csv' : `sheet:${input.sheet}`;
  const plan = plans[key];
  const preview = plan?.preview;
  const columns = plan?.columns;
  const preparedFor = plan?.preparedFor;
  const reading = Boolean(source) && !preview && !error;
  const validating = Boolean(preview && columns && preparedFor !== columns);
  const choosesSheets = !databaseId && sheets.length > 1;
  const importsEvery = choosesSheets && everySheet;

  function reasonFor(error: unknown): string {
    if (error instanceof ApiError) return serverMessage(i18n, error.info.messageKey, error.info.params);
    if (error instanceof Error && error.message === 'import.tooLarge')
      return serverMessage(i18n, 'errors.tooLarge');
    return t({ id: 'import.unreadableFile', message: 'This file couldn’t be read.' });
  }
  useEffect(
    () => () => {
      cancel.current = true;
    },
    [],
  );
  useEffect(() => {
    if (!source || preview) return;
    const controller = new AbortController();
    void inspectFile(source, header, controller.signal, setReadProgress)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.stats.length) throw new Error('import.unreadable');
        const columns = makeColumns(result, header, (number) =>
          t({ id: 'import.fieldName', message: `Field ${number}` }),
        );
        const suggested = input.suggestedTypes;
        if (suggested)
          columns.forEach((column, index) => {
            const type = suggested[index];
            if (type && (index !== 0 || isPrimaryType(type === 'dateTime' ? 'date' : type)))
              column.field = { ...column.field, ...specFor(type, result.stats[index]) };
          });
        setPlans((plans) => ({ ...plans, [key]: { preview: result, columns, primary: 0 } }));
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(t({ id: 'import.unreadableFile', message: 'This file couldn’t be read.' }));
      });
    return () => controller.abort();
  }, [source, key, preview, header, t, input.suggestedTypes]);
  useEffect(() => {
    if (!source || !preview || !columns?.length || preparedFor === columns) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void validateFile(source, columns, header, false, timeZone, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setPlans((plans) => {
            const current = plans[key];
            return current?.columns === columns
              ? { ...plans, [key]: { ...current, prepared: result, preparedFor: columns } }
              : plans;
          });
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError(t({ id: 'import.unreadableFile', message: 'This file couldn’t be read.' }));
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [source, key, preview, columns, preparedFor, header, timeZone, t]);

  function changePlan(patch: Partial<Plan>) {
    setPlans((plans) => {
      const current = plans[key];
      return current ? { ...plans, [key]: { ...current, ...patch } } : plans;
    });
  }
  function choose(next?: File, types?: DocumentColumnType[]) {
    if (!next || running) return;
    setPlans({});
    setReadProgress(0);
    setError(undefined);
    setStopped(false);
    setEverySheet(false);
    setCount(0);
    if (types) setHeader(true);
    input.choose(next, types);
  }
  function readingLabel(filename: string) {
    return t({ id: 'import.reading', message: `Reading ${filename}` });
  }
  function titleLabel(file: string) {
    return t({ id: 'import.title', message: `Import ${file}` });
  }
  function emptyLabel(count: number) {
    return t({
      id: 'import.doneEmpty',
      message: plural(count, {
        one: '# value was left empty.',
        other: '# values were left empty.',
      }),
    });
  }
  const invalid = !plan || invalidPlan(plan);
  // Sheets edited but not shown right now still have to make sense.
  const others =
    importsEvery && Object.entries(plans).some(([other, item]) => other !== key && invalidPlan(item));

  function undoAction(result: ImportResult, databaseName?: string) {
    return {
      label: t({ id: 'import.undo', message: 'Undo' }),
      onPress: () => {
        const undo = (async () => {
          if (!databaseId && databaseName)
            await adoptDatabaseAction(result.databaseId, result.groupId, {
              kind: 'database.create',
              count: 1,
              name: databaseName,
              asksFirst: true,
            });
          return session || !databaseId
            ? undoDatabaseAction(result.databaseId, result.groupId)
            : undoImport(result.databaseId, result.groupId);
        })();
        void undo
          .then((outcome) => {
            if (outcome.nothing && !outcome.canceled)
              toast.show({
                tone: 'warning',
                title: t({ id: 'import.undoNothing', message: 'The import could not be undone.' }),
              });
          })
          .catch((error: unknown) => {
            const reason = reasonFor(error);
            toast.show({
              tone: 'danger',
              title: t({ id: 'import.failed', message: `The import stopped: ${reason}` }),
            });
          });
      },
    };
  }
  /** A sheet nobody opened gets the columns its preview would have suggested. */
  async function readyPlan(index: number): Promise<Plan> {
    const known = plans[`sheet:${index}`];
    const sheet = sheets[index]!;
    if (known?.prepared && known.preparedFor === known.columns) return known;
    setStatus(readingLabel(sheet.name));
    const result = known?.preview ?? (await inspectFile(sheet, header));
    const columns =
      known?.columns ??
      makeColumns(result, header, (number) => t({ id: 'import.fieldName', message: `Field ${number}` }));
    const prepared = await validateFile(sheet, columns, header, false, timeZone);
    return { preview: result, columns, primary: known?.primary ?? 0, prepared, preparedFor: columns };
  }
  async function start() {
    if (!file || !source || !plan?.prepared || validating || invalid || others || active.current) return;
    active.current = true;
    cancel.current = false;
    setRunning(true);
    setError(undefined);
    let applied: ImportResult | undefined;
    const base =
      file.name
        .replace(/\.[^.]*$/, '')
        .trim()
        .slice(0, 255) || t({ id: 'import.tableName', message: 'Imported data' });
    try {
      // A workbook with several sheets names each table after its sheet.
      const names =
        sheets.length > 1
          ? uniqueNames(
              sheets.map((sheet) => sheet.name),
              (number) => t({ id: 'import.sheetName', message: `Sheet ${number}` }),
            )
          : [base];
      const chosen = importsEvery ? sheets.map((_, index) => index) : [input.sheet];
      const groupId = newId('action');
      let target = databaseId;
      let written = 0;
      let empty = 0;
      let result: ImportResult | undefined;
      for (const index of chosen) {
        const ready = source.kind === 'csv' || index === input.sheet ? plan : await readyPlan(index);
        setStatus(undefined);
        if (!ready.prepared || cancel.current) break;
        const before = written;
        result = await importRecords({
          databaseId: target,
          name: source.kind === 'csv' ? base : names[index]!,
          databaseName: base,
          viewName: t({ id: 'import.viewName', message: 'Grid' }),
          columns: ready.prepared.columns,
          primary: ready.primary,
          header,
          timeZone,
          rows: streamFile(source.kind === 'csv' ? source : sheets[index]!),
          groupId,
          canceled: () => cancel.current,
          onProgress: (count) => setCount(before + count),
          onApplied: (result) => {
            applied = result;
            session?.adoptAction?.(result.groupId, {
              kind: 'table.create',
              count: 1,
              name: source.kind === 'csv' ? base : names[index]!,
            });
          },
        });
        target = result.databaseId;
        written += result.count;
        empty += result.empty;
        if (result.canceled) break;
      }
      if (!result) return;
      if (!databaseId)
        await adoptDatabaseAction(result.databaseId, result.groupId, {
          kind: 'database.create',
          count: 1,
          name: base,
          asksFirst: true,
        });
      toast.show({
        tone: 'success',
        timeout: 0,
        title: t({
          id: 'import.done',
          message: plural(written, { one: 'Imported # record.', other: 'Imported # records.' }),
        }),
        description: empty ? emptyLabel(empty) : undefined,
        action: undoAction(result),
      });
      if (!result.canceled && !cancel.current) {
        // A new database made from a file brings its first table with it.
        if (!databaseId) observe('firstTable', 'you', true);
        if (!empty) celebrate('importClean', result.tableId);
        onDone(databaseId ? result.tableId : result.databaseId);
      } else setStopped(true);
    } catch (error) {
      const reason = reasonFor(error);
      const title = t({ id: 'import.failed', message: `The import stopped: ${reason}` });
      setError(title);
      if (applied) toast.show({ tone: 'danger', title, action: undoAction(applied, base) });
      setStopped(true);
    } finally {
      setStatus(undefined);
      active.current = false;
      setRunning(false);
    }
  }
  const filename = file?.name ?? '';
  const progressLabel = t({
    id: 'import.progress',
    message: plural(count, { one: 'Imported # record', other: 'Imported # records' }),
  });
  const expected = importsEvery ? sheets.reduce((sum, sheet) => sum + sheet.sent, 0) : (preview?.total ?? 1);
  const message = input.error ?? error;
  return (
    <Modal
      isOpen
      isDismissable={!running}
      isKeyboardDismissDisabled={running}
      className="rio-import"
      onOpenChange={(open) => {
        if (!open && !running) onClose();
      }}
    >
      <Dialog hideCloseButton>
        <HelpDialogTitle moduleId="importing" section="choosing-a-file" anchorId="import.dialog">
          {file
            ? titleLabel(filename)
            : databaseId
              ? t({ id: 'import.chooseFile', message: 'Choose a CSV or Excel file' })
              : t({ id: 'import.newDatabaseFile', message: 'New database from a CSV or Excel file' })}
        </HelpDialogTitle>
        <DialogBody>
          <div className="rio-import__body">
            {!running && !stopped && (
              <FileChooser initialOpen={documentImport} onChoose={choose} databaseId={databaseId} />
            )}
            {input.loading && <ProgressBar isIndeterminate label={readingLabel(filename)} />}
            {choosesSheets && (
              <Checkbox isSelected={everySheet} isDisabled={running || stopped} onChange={setEverySheet}>
                {t({ id: 'import.everySheet', message: 'Import every sheet as its own table' })}
              </Checkbox>
            )}
            <SheetPicker
              sheets={sheets}
              sheet={input.sheet}
              disabled={running || stopped}
              onSheet={(index) => {
                setReadProgress(0);
                setError(undefined);
                input.setSheet(index);
              }}
            />
            <SheetLimits sheets={importsEvery ? sheets : sheets.slice(input.sheet, input.sheet + 1)} />
            {source && (
              <Checkbox
                isSelected={header}
                isDisabled={running || stopped}
                onChange={(next) => {
                  setPlans({});
                  setReadProgress(0);
                  setError(undefined);
                  setHeader(next);
                }}
              >
                {t({ id: 'import.header', message: 'Use the first row as field names' })}
              </Checkbox>
            )}
            {reading && <ProgressBar value={readProgress * 100} label={readingLabel(filename)} />}
            {validating && <ProgressBar isIndeterminate label={readingLabel(filename)} />}
            {plan && (
              <ImportPreview
                preview={plan.preview}
                columns={plan.columns}
                primary={plan.primary}
                onPrimary={(primary) => changePlan({ primary })}
                onChange={(columns) => changePlan({ columns })}
                misfits={plan.preparedFor === plan.columns ? (plan.prepared?.misfits ?? []) : []}
                disabled={running || stopped}
              />
            )}
            {status && <ProgressBar isIndeterminate label={status} />}
            {(running || stopped) && (
              <ProgressBar
                value={count}
                maxValue={Math.max(1, expected)}
                label={progressLabel}
                valueLabel={progressLabel}
              />
            )}
            {message && <Banner tone="danger">{message}</Banner>}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            onPress={() => {
              if (running) {
                cancel.current = true;
              } else onClose();
            }}
          >
            {t({ id: 'import.cancel', message: 'Cancel' })}
          </Button>
          <Button
            variant="primary"
            isDisabled={!plan?.prepared || reading || validating || invalid || others || running || stopped}
            onPress={() => void start()}
            {...anchor('import.start')}
          >
            {t({ id: 'import.start', message: 'Import' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
