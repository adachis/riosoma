import { useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import {
  Banner,
  Button,
  Checkbox,
  CheckboxGroup,
  FilterableList,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Modal,
  ProgressBar,
  Radio,
  RadioGroup,
  TextField,
  toast,
} from '@riosoma/ui';
import { ApiError } from '../../../api';
import { serverMessage } from '../../../messages/useServerMessage';
import { saveFile } from '../view/download';
import type { PrintSettings } from './document';
import { printMenu } from './messages';
import { chosenFields, defaultPageSize, type FieldChoice, type Orientation, type PageSize } from './options';
import { pdfBlob, printBlob } from './output';
import './print.css';

/** What making a document may do while it reads: report progress, and ask about a large view. */
export interface PrintControls {
  signal: AbortSignal;
  onProgress(read: number, total: number): void;
  confirmLarge(total: number): Promise<boolean>;
}

export interface PrintDialogProps {
  /** A view reads its records first, with progress, and a record is already here. */
  kind: 'view' | 'record';
  defaultTitle: string;
  defaultOrientation: Orientation;
  /** Every field that can be printed, in order, with the ones chosen to start */
  choices: readonly FieldChoice[];
  primaryFieldId: string;
  fileName(title: string): string;
  /** Makes the document, or resolves null when the person stopped it. */
  make(settings: PrintSettings, controls: PrintControls): Promise<TDocumentDefinitions | null>;
  onClose(): void;
}

type Phase = 'setup' | 'loading' | 'confirm' | 'making';
type Output = 'print' | 'save';

/** A moment for the screen to show what is happening before the PDF library takes the thread. */
const paint = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Choosing how a view or a record prints: its title, paper, orientation, and fields.  Then the
 * records load a page at a time, with a way to stop, and the PDF is saved or opened in the
 * browser's print dialog.
 */
export function PrintDialog({
  kind,
  defaultTitle,
  defaultOrientation,
  choices,
  primaryFieldId,
  fileName,
  make,
  onClose,
}: PrintDialogProps) {
  const { t, i18n } = useLingui();
  const [title, setTitle] = useState(defaultTitle);
  const [pageSize, setPageSize] = useState<PageSize>(() =>
    defaultPageSize(i18n.locale || 'en-US', typeof navigator === 'undefined' ? [] : navigator.languages),
  );
  const [orientation, setOrientation] = useState<Orientation>(defaultOrientation);
  const [chosen, setChosen] = useState<string[]>(() =>
    choices
      .filter((choice) => choice.chosen || choice.field.id === primaryFieldId)
      .map(({ field }) => field.id),
  );
  const [phase, setPhase] = useState<Phase>('setup');
  const [output, setOutput] = useState<Output>('save');
  const [progress, setProgress] = useState<{ read: number; total: number } | null>(null);
  const [large, setLarge] = useState(0);
  /** Why the last attempt failed, with the server's reason when it gave one. */
  const [failure, setFailure] = useState<{ reason: string | null } | null>(null);
  const [stopped, setStopped] = useState(false);
  const running = useRef<AbortController | null>(null);
  const answer = useRef<((go: boolean) => void) | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const shownPhase = useRef<Phase>('setup');

  // Each step swaps the buttons, so the keyboard lands on the one that moves things along.
  useEffect(() => {
    if (shownPhase.current === phase) return;
    shownPhase.current = phase;
    const buttons = root.current?.querySelectorAll<HTMLButtonElement>('.rio-dialog__footer button');
    buttons?.[buttons.length - 1]?.focus();
  }, [phase]);

  // Closing the dialog mid-read stops the read, so nothing saves after the dialog is gone.
  useEffect(
    () => () => {
      running.current?.abort();
      answer.current?.(false);
    },
    [],
  );

  /** The server's own reason rides along, so a lost grant reads as one rather than a mystery. */
  function reason(error: unknown): string | null {
    return error instanceof ApiError ? serverMessage(i18n, error.info.messageKey, error.info.params) : null;
  }

  async function start(chosenOutput: Output) {
    if (running.current) return;
    const controller = new AbortController();
    running.current = controller;
    setOutput(chosenOutput);
    setFailure(null);
    setStopped(false);
    setProgress(null);
    setPhase(kind === 'view' ? 'loading' : 'making');
    const settings: PrintSettings = {
      title: title.trim() || defaultTitle,
      pageSize,
      orientation,
      fields: chosenFields(choices, new Set(chosen), primaryFieldId),
    };
    try {
      const definition = await make(settings, {
        signal: controller.signal,
        onProgress: (read, total) => {
          if (!controller.signal.aborted) setProgress({ read, total });
        },
        confirmLarge: (total) =>
          new Promise<boolean>((resolve) => {
            answer.current = resolve;
            setLarge(total);
            setPhase('confirm');
          }),
      });
      if (!definition || controller.signal.aborted) return;
      setPhase('making');
      await paint();
      const blob = await pdfBlob(definition);
      if (controller.signal.aborted) return;
      const name = fileName(settings.title);
      if (chosenOutput === 'save') saveFile(blob, name);
      else {
        try {
          await printBlob(blob);
        } catch {
          // The PDF is made either way, so it is saved for printing from wherever it opens.
          saveFile(blob, name);
          toast.show({
            tone: 'info',
            title: t({
              id: 'print.printFallback',
              message: 'The browser didn’t open its print dialog, so the PDF was saved instead.',
            }),
          });
        }
      }
      onClose();
    } catch (error) {
      if (controller.signal.aborted) return;
      setFailure({ reason: reason(error) });
      setPhase('setup');
    } finally {
      if (running.current === controller) running.current = null;
    }
  }

  function stop() {
    running.current?.abort();
    running.current = null;
    answer.current?.(false);
    answer.current = null;
    setStopped(true);
    setProgress(null);
    setPhase('setup');
  }

  function goOn() {
    answer.current?.(true);
    answer.current = null;
    setPhase('loading');
  }

  const busy = phase !== 'setup';
  const read = i18n.number(progress?.read ?? 0);
  const total = i18n.number(progress?.total ?? 0);
  const count = i18n.number(large);
  return (
    <Modal
      isOpen
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
      className="rio-print"
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog hideCloseButton>
        <div ref={root} className="rio-print__root">
          <DialogTitle>{i18n._(printMenu)}</DialogTitle>
          <DialogBody>
            <div className="rio-print__body">
              <TextField
                label={t({ id: 'print.titleLabel', message: 'Title' })}
                value={title}
                isDisabled={busy}
                onChange={setTitle}
              />
              <div className="rio-print__paper">
                <RadioGroup
                  label={t({ id: 'print.pageSize', message: 'Page size' })}
                  orientation="horizontal"
                  value={pageSize}
                  isDisabled={busy}
                  onChange={(value) => setPageSize(value === 'A4' ? 'A4' : 'LETTER')}
                >
                  <Radio value="LETTER">{t({ id: 'print.pageSize.letter', message: 'Letter' })}</Radio>
                  <Radio value="A4">{t({ id: 'print.pageSize.a4', message: 'A4' })}</Radio>
                </RadioGroup>
                <RadioGroup
                  label={t({ id: 'print.orientation', message: 'Orientation' })}
                  orientation="horizontal"
                  value={orientation}
                  isDisabled={busy}
                  onChange={(value) => setOrientation(value === 'landscape' ? 'landscape' : 'portrait')}
                >
                  <Radio value="portrait">
                    {t({ id: 'print.orientation.portrait', message: 'Portrait' })}
                  </Radio>
                  <Radio value="landscape">
                    {t({ id: 'print.orientation.landscape', message: 'Landscape' })}
                  </Radio>
                </RadioGroup>
              </div>
              {choices.length > 10 ? (
                <FilterableList
                  listId="print.fields"
                  label={t({ id: 'print.fields', message: 'Fields' })}
                  description={
                    kind === 'view'
                      ? t({
                          id: 'print.fields.viewHelp',
                          message: 'Starts with the fields the view shows, in its order.',
                        })
                      : t({ id: 'print.fields.recordHelp', message: 'Starts with every field on the card.' })
                  }
                  items={choices.map(({ field }) => ({
                    id: field.id,
                    name: field.name,
                    isDisabled: field.id === primaryFieldId,
                    description:
                      field.id === primaryFieldId
                        ? t({ id: 'print.fields.always', message: 'Always included' })
                        : undefined,
                  }))}
                  selectedKeys={chosen}
                  selectionMode="multiple"
                  isDisabled={busy}
                  onSelectionChange={(keys) => setChosen([...keys].map(String))}
                />
              ) : (
                <CheckboxGroup
                  className="rio-print__fields"
                  label={t({ id: 'print.fields', message: 'Fields' })}
                  description={
                    kind === 'view'
                      ? t({
                          id: 'print.fields.viewHelp',
                          message: 'Starts with the fields the view shows, in its order.',
                        })
                      : t({ id: 'print.fields.recordHelp', message: 'Starts with every field on the card.' })
                  }
                  value={chosen}
                  isDisabled={busy}
                  onChange={setChosen}
                >
                  {choices.map(({ field }) => (
                    <Checkbox
                      key={field.id}
                      value={field.id}
                      isDisabled={field.id === primaryFieldId}
                      description={
                        field.id === primaryFieldId
                          ? t({ id: 'print.fields.always', message: 'Always included' })
                          : undefined
                      }
                    >
                      {field.name}
                    </Checkbox>
                  ))}
                </CheckboxGroup>
              )}
              {phase === 'loading' && (
                <ProgressBar
                  label={t({ id: 'print.loading', message: 'Loading records' })}
                  value={progress?.read ?? 0}
                  maxValue={Math.max(1, progress?.total ?? 1)}
                  isIndeterminate={progress === null}
                  valueLabel={
                    progress ? t({ id: 'print.loading.value', message: `${read} of ${total}` }) : undefined
                  }
                />
              )}
              {phase === 'confirm' && (
                <Banner tone="warning">
                  {t({
                    id: 'print.large.body',
                    message: `This view has ${count} records.  A PDF that long takes a while to make and can be slow to open.`,
                  })}
                </Banner>
              )}
              {phase === 'making' && (
                <ProgressBar isIndeterminate label={t({ id: 'print.making', message: 'Making the PDF' })} />
              )}
              {failure && (
                <Banner
                  tone="danger"
                  title={t({ id: 'print.failed', message: 'The PDF didn’t work.  Try again.' })}
                >
                  {failure.reason}
                </Banner>
              )}
              <p className="rio-print__note" role="status">
                {stopped ? t({ id: 'print.stopped', message: 'Stopped.  No PDF was made.' }) : ''}
              </p>
            </div>
          </DialogBody>
          <DialogFooter>
            {phase === 'loading' || phase === 'confirm' ? (
              <>
                <Button onPress={stop}>{t({ id: 'print.stop', message: 'Stop' })}</Button>
                {phase === 'confirm' && (
                  <Button variant="primary" onPress={goOn}>
                    {t({ id: 'print.continue', message: 'Continue' })}
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button isDisabled={busy} onPress={onClose}>
                  {t({ id: 'print.cancel', message: 'Cancel' })}
                </Button>
                <Button
                  isDisabled={busy}
                  isPending={busy && output === 'print'}
                  onPress={() => void start('print')}
                >
                  {t({ id: 'print.print', message: 'Print' })}
                </Button>
                <Button
                  variant="primary"
                  isDisabled={busy}
                  isPending={busy && output === 'save'}
                  onPress={() => void start('save')}
                >
                  {t({ id: 'print.save', message: 'Save PDF' })}
                </Button>
              </>
            )}
          </DialogFooter>
        </div>
      </Dialog>
    </Modal>
  );
}
