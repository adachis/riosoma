import { useLingui } from '@lingui/react/macro';
import { Banner, Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal, TextField } from '@riosoma/ui';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';

export function UrlPicker({
  onAdd,
  onClose,
}: {
  onAdd(url: string, filename?: string): Promise<void>;
  onClose(): void;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (busy) return;
    // The menu restores its trigger's focus while closing; the dialog takes focus afterward.
    // A failed download also restores focus lost while the form's controls were disabled.
    const frame = requestAnimationFrame(() => form.current?.querySelector('input')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [busy]);
  async function add() {
    if (busy) return;
    try {
      const address = new URL(url.trim());
      if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password)
        throw new Error();
    } catch {
      setError(
        t({ id: 'files.url.invalid', message: 'Enter a full web address without a user name or password.' }),
      );
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onAdd(url.trim(), filename.trim() || undefined);
      onClose();
    } catch (error) {
      setError(
        error instanceof ApiError
          ? message(error.info.messageKey, error.info.params)
          : message('errors.internal'),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      isOpen
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
      size="md"
      onOpenChange={(open) => !open && onClose()}
    >
      <Dialog className="rio-url-picker" hideCloseButton={busy}>
        <DialogTitle>{t({ id: 'files.url.title', message: 'From a web address' })}</DialogTitle>
        <form
          ref={form}
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <DialogBody>
            <TextField
              autoFocus
              label={t({ id: 'files.url.address', message: 'Web address' })}
              value={url}
              onChange={setUrl}
              maxLength={8192}
              isDisabled={busy}
            />
            <TextField
              label={t({ id: 'files.url.filename', message: 'File name (optional)' })}
              value={filename}
              onChange={setFilename}
              maxLength={255}
              isDisabled={busy}
            />
            <p>
              {t({
                id: 'files.url.help',
                message:
                  'Use a direct HTTPS link to a file.  Riosoma copies it into this record and checks it for viruses when scanning is enabled.',
              })}
            </p>
            {error && <Banner tone="danger">{error}</Banner>}
            {busy && <p role="status">{t({ id: 'files.url.copying', message: 'Downloading the file…' })}</p>}
          </DialogBody>
          <DialogFooter>
            <Button isDisabled={busy} onPress={onClose}>
              {t({ id: 'files.cancel', message: 'Cancel' })}
            </Button>
            <Button type="submit" variant="primary" isDisabled={!url.trim() || busy} isPending={busy}>
              {t({ id: 'files.url.add', message: 'Add file' })}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </Modal>
  );
}
