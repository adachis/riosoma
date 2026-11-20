import { useLingui } from '@lingui/react/macro';
import { roleAllows, type HomeListing, type HomeShortcut, type HomeAction } from '@riosoma/contracts';
import {
  Modal,
  Dialog,
  DialogTitle,
  DialogBody,
  DialogFooter,
  Select,
  ListBoxItem,
  Button,
} from '@riosoma/ui';

export function ShortcutMoveDialog({
  moving,
  listing,
  destination,
  onDestination,
  onClose,
  change,
  pending,
}: {
  moving: HomeShortcut;
  listing: HomeListing;
  destination: string;
  onDestination(key: string): void;
  onClose(): void;
  change(action: HomeAction): void;
  pending: boolean;
}) {
  const { t } = useLingui();
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>{t({ id: 'home.shortcuts.move', message: 'Move shortcut' })}</DialogTitle>
        <DialogBody>
          <Select
            label={t({ id: 'home.folders.destination', message: 'Destination' })}
            selectedKey={destination}
            onSelectionChange={(key) => onDestination(String(key))}
          >
            <ListBoxItem id="root">{t({ id: 'home.myFiles', message: 'My files' })}</ListBoxItem>
            {listing.folders
              .filter((folder) => !folder.trashed && roleAllows(folder.role, 'editRecords'))
              .map((folder) => (
                <ListBoxItem key={folder.id} id={folder.id}>
                  {folder.name}
                </ListBoxItem>
              ))}
          </Select>
        </DialogBody>
        <DialogFooter>
          <Button onPress={() => onClose()}>{t({ id: 'common.cancel', message: 'Cancel' })}</Button>
          <Button
            isPending={pending}
            onPress={() => {
              change({
                kind: 'shortcut.move',
                shortcutId: moving.id,
                parentId: destination === 'root' ? null : destination,
              });
              onClose();
            }}
          >
            {t({ id: 'home.folders.moveButton', message: 'Move' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
