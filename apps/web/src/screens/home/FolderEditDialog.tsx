import { useLingui } from '@lingui/react/macro';
import { newId, type HomeFolder, type HomeAction } from '@riosoma/contracts';
import { Modal, Dialog, DialogTitle, DialogBody, DialogFooter, TextField, Button } from '@riosoma/ui';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../messages/errorInfo';

export function FolderEditDialog({
  editing,
  name,
  onName,
  folderId,
  pending,
  error,
  onClose,
  onChange,
}: {
  editing: HomeFolder | 'new';
  name: string;
  onName(name: string): void;
  folderId: string | null;
  pending: boolean;
  error: Error | null;
  onClose(): void;
  onChange(action: HomeAction): void;
}) {
  const { t } = useLingui();
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>
          {editing === 'new'
            ? t({ id: 'home.folders.new', message: 'New folder' })
            : t({ id: 'home.folders.rename', message: 'Rename' })}
        </DialogTitle>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim())
              onChange(
                editing === 'new'
                  ? { kind: 'folder.create', folderId: newId('folder'), parentId: folderId, name }
                  : { kind: 'folder.rename', folderId: editing.id, name },
              );
          }}
        >
          <DialogBody>
            {error ? <ErrorBanner error={errorInfo(error)} /> : null}
            <TextField
              autoFocus
              label={t({ id: 'home.folders.name', message: 'Folder name' })}
              value={name}
              onChange={onName}
              maxLength={120}
              isRequired
            />
          </DialogBody>
          <DialogFooter>
            <Button onPress={() => onClose()} isDisabled={pending}>
              {t({ id: 'common.cancel', message: 'Cancel' })}
            </Button>
            <Button type="submit" variant="primary" isPending={pending} isDisabled={!name.trim()}>
              {t({ id: 'common.save', message: 'Save' })}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </Modal>
  );
}
