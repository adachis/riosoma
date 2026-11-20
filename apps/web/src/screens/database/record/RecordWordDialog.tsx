import { useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Banner, Button, Checkbox, Dialog, DialogBody, DialogFooter, DialogTitle, Modal } from '@riosoma/ui';
import { ApiError, apiFile } from '../../../api';
import { serverMessage } from '../../../messages/useServerMessage';
import { saveFile } from '../view/download';
import '../view/office.css';

export interface RecordWordDialogProps {
  tableId: string;
  recordId: string;
  onClose(): void;
}

/** One record's Word document, in the reader's language and time zone. */
export function recordExportUrl(
  tableId: string,
  recordId: string,
  options: { timeZone: string; locale: string; comments: boolean },
): string {
  const query = new URLSearchParams({
    format: 'docx',
    timeZone: options.timeZone,
    locale: options.locale,
    comments: String(options.comments),
  });
  return `/api/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}/export?${query.toString()}`;
}

/**
 * Downloading a record as a Word document: its fields, its pictures, and its comments when asked
 * for.  The server makes the file, and the dialog stays open while it does, so a failure can say
 * why beside the choice that led to it.
 */
export function RecordWordDialog({ tableId, recordId, onClose }: RecordWordDialogProps) {
  const { t, i18n } = useLingui();
  const [comments, setComments] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ reason: string | null } | null>(null);
  const open = useRef(true);
  useEffect(
    () => () => {
      open.current = false;
    },
    [],
  );

  async function download() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const file = await apiFile(
        recordExportUrl(tableId, recordId, {
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale: i18n.locale || 'en-US',
          comments,
        }),
      );
      if (!open.current) return;
      saveFile(file.blob, file.filename ?? `${recordId}.docx`);
      onClose();
    } catch (error) {
      if (!open.current) return;
      setFailure({
        reason: serverMessage(
          i18n,
          error instanceof ApiError ? error.info.messageKey : 'errors.internal',
          error instanceof ApiError ? error.info.params : undefined,
        ),
      });
      setPending(false);
    }
  }

  return (
    <Modal
      isOpen
      isDismissable={!pending}
      isKeyboardDismissDisabled={pending}
      onOpenChange={(isOpen) => {
        if (!isOpen && !pending) onClose();
      }}
    >
      <Dialog hideCloseButton>
        <DialogTitle>{t({ id: 'export.record.menu', message: 'Download as Word' })}</DialogTitle>
        <DialogBody>
          <div className="rio-office-download__body">
            <p className="rio-record-word__note">
              {t({
                id: 'export.record.help',
                message: 'Every field you can see, in the card’s order, with the record’s pictures.',
              })}
            </p>
            <Checkbox isSelected={comments} isDisabled={pending} onChange={setComments}>
              {t({ id: 'export.record.comments', message: 'Include comments' })}
            </Checkbox>
            {failure && (
              <Banner
                tone="danger"
                title={t({ id: 'export.failed', message: 'The download didn’t work.  Try again.' })}
              >
                {failure.reason}
              </Banner>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button isDisabled={pending} onPress={onClose}>
            {t({ id: 'export.office.cancel', message: 'Cancel' })}
          </Button>
          <Button variant="primary" isPending={pending} onPress={() => void download()}>
            {t({ id: 'export.office.download', message: 'Download' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
