import { Trans, useLingui } from '@lingui/react/macro';
import type { AttachmentMeta } from '@riosoma/contracts';
import { Button, Dialog, DialogBody, DialogTitle, Link, Modal, Text } from '@riosoma/ui';
import { useRef } from 'react';
import { fileKind } from './fileKind';
import './attachments.css';

export function AttachmentPreview({
  ids,
  selected,
  details,
  onSelect,
  onClose,
}: {
  ids: readonly string[];
  selected: string;
  details: ReadonlyMap<string, AttachmentMeta>;
  onSelect(id: string): void;
  onClose(): void;
}) {
  const { t } = useLingui();
  const root = useRef<HTMLDivElement>(null);
  const index = ids.indexOf(selected);
  const file = details.get(selected);
  const name = file?.name ?? selected;
  const kind = file && fileKind(file);
  const move = (delta: number) => {
    const id = ids[index + delta];
    if (id) {
      // A navigation button becomes disabled at either end; keep keyboard focus in the preview.
      if (index + delta === 0 || index + delta === ids.length - 1)
        root.current?.querySelector<HTMLElement>('[role="dialog"]')?.focus();
      onSelect(id);
    }
  };
  return (
    <Modal
      isOpen
      isDismissable
      size="lg"
      className="rio-file-preview"
      overlayClassName="rio-file-preview-overlay"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div
        className="rio-file-preview__root"
        ref={root}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
          // Native media controls retain their arrow-key seeking and volume controls.
          if (event.target instanceof Element && event.target.closest('audio, video')) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            move(event.key === 'ArrowLeft' ? -1 : 1);
          }
        }}
      >
        <Dialog>
          <DialogTitle>{t({ id: 'files.preview', message: `Preview of ${name}` })}</DialogTitle>
          <DialogBody>
            {file?.scanState === 'too_large_allowed' ? (
              <>
                <Text>
                  <Trans id="files.tooLargeAllowed">Too large to scan—download allowed, unscanned</Trans>
                </Text>
                <Link href={file.url} download={file.name}>
                  <Trans id="files.download">Download</Trans>
                </Link>
              </>
            ) : null}
            {file && (!file.scanState || file.scanState === 'clean') && (
              <>
                {kind === 'image' ? (
                  <>
                    <img
                      className="rio-file-preview__media"
                      src={file.thumbnails.large ?? file.url}
                      alt={name}
                    />
                    <Link href={file.url} external>
                      {t({ id: 'files.openOriginal', message: 'Open original' })}
                    </Link>
                  </>
                ) : kind === 'audio' ? (
                  <audio className="rio-file-preview__media" src={file.url} controls aria-label={name} />
                ) : kind === 'video' ? (
                  <video className="rio-file-preview__media" src={file.url} controls aria-label={name} />
                ) : kind === 'pdf' || kind === 'text' ? (
                  <Link href={file.url} external>
                    {t({ id: 'files.openInNewTab', message: 'Open in a new tab' })}
                  </Link>
                ) : (
                  <Link href={file.url} download={file.name}>
                    {t({ id: 'files.download', message: 'Download' })}
                  </Link>
                )}
              </>
            )}
            <div className="rio-files__actions">
              <Button isDisabled={index <= 0} onPress={() => move(-1)}>
                {t({ id: 'files.previous', message: 'Previous file' })}
              </Button>
              <Button isDisabled={index < 0 || index >= ids.length - 1} onPress={() => move(1)}>
                {t({ id: 'files.next', message: 'Next file' })}
              </Button>
            </div>
          </DialogBody>
        </Dialog>
      </div>
    </Modal>
  );
}
