import { HelpDialogTitle } from '../../../docs/HelpDialogTitle';
import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { LIMITS, OFFICE_LIMITS, type DeckLayout } from '@riosoma/contracts';
import { Button, Dialog, DialogBody, DialogFooter, Modal, Radio, RadioGroup, TextField } from '@riosoma/ui';
import type { OfficeChoices, OfficeFormat } from './download';
import './office.css';

export interface OfficeDownloadDialogProps {
  format: OfficeFormat;
  /** The view's name, which the title starts as */
  viewName: string;
  onDownload(choices: OfficeChoices): void;
  onCancel(): void;
}

/**
 * What a Word document or a deck is called, and how a deck lays its records out, before it's made.
 * The server makes the file, so the dialog closes as the download starts and the usual notice
 * takes over.
 */
export function OfficeDownloadDialog({ format, viewName, onDownload, onCancel }: OfficeDownloadDialogProps) {
  const { t, i18n } = useLingui();
  const [title, setTitle] = useState(viewName);
  const [layout, setLayout] = useState<DeckLayout>('records');
  const slides = i18n.number(OFFICE_LIMITS.recordSlides);
  const rows = i18n.number(OFFICE_LIMITS.tableSlideRows);
  const records = i18n.number(OFFICE_LIMITS.documentRecords);
  const submit = () =>
    onDownload({ title: title.trim() || viewName, ...(format === 'pptx' ? { layout } : {}) });
  return (
    <Modal
      isOpen
      isDismissable
      className="rio-office-download"
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog hideCloseButton>
        <HelpDialogTitle
          moduleId="downloading"
          section={format === 'docx' ? 'word-documents' : 'powerpoint-decks'}
          anchorId="view.export"
        >
          {format === 'docx'
            ? t({ id: 'export.office.wordTitle', message: 'Download a Word document' })
            : t({ id: 'export.office.deckTitle', message: 'Download a PowerPoint deck' })}
        </HelpDialogTitle>
        <DialogBody>
          <form
            className="rio-office-download__body"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <TextField
              label={t({ id: 'export.office.title', message: 'Title' })}
              value={title}
              maxLength={LIMITS.nameLength}
              onChange={setTitle}
              autoFocus
            />
            {format === 'pptx' ? (
              <RadioGroup
                label={t({ id: 'export.office.layout', message: 'Slides' })}
                value={layout}
                onChange={(value) => setLayout(value === 'table' ? 'table' : 'records')}
              >
                <Radio
                  value="records"
                  description={t({
                    id: 'export.office.layout.recordsHelp',
                    message: `Each record’s fields and first picture, for up to ${slides} records.`,
                  })}
                >
                  {t({ id: 'export.office.layout.records', message: 'A slide for each record' })}
                </Radio>
                <Radio
                  value="table"
                  description={t({
                    id: 'export.office.layout.tableHelp',
                    message: `The view as a table, ${rows} records to a slide.`,
                  })}
                >
                  {t({ id: 'export.office.layout.table', message: 'A table' })}
                </Radio>
              </RadioGroup>
            ) : (
              <p className="rio-office-download__note">
                {t({
                  id: 'export.office.wordHelp',
                  message: `The view’s fields as a table, for up to ${records} records, with a heading for each group.`,
                })}
              </p>
            )}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button onPress={onCancel}>{t({ id: 'export.office.cancel', message: 'Cancel' })}</Button>
          <Button variant="primary" onPress={submit}>
            {t({ id: 'export.office.download', message: 'Download' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
