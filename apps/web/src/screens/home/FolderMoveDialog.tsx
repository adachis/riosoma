import { useLingui } from '@lingui/react/macro';
import type { AccessLoss, HomeFolder } from '@riosoma/contracts';
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
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../setup/useSetup';

export function FolderMoveDialog({
  moving,
  pending,
  error,
  destination,
  onDestination,
  destinations,
  folders,
  rootLabel,
  losses,
  onClose,
  onMove,
}: {
  moving: { name: string };
  pending: boolean;
  error: Error | null;
  destination: string;
  onDestination(key: string): void;
  destinations: HomeFolder[];
  folders: HomeFolder[];
  rootLabel: string;
  losses: AccessLoss[] | null;
  onClose(): void;
  onMove(): void;
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
        <DialogTitle>{t({ id: 'home.folders.moveTitle', message: `Move ${moving.name}` })}</DialogTitle>
        <DialogBody>
          {error ? <ErrorBanner error={errorInfo(error)} /> : null}
          <Select
            label={t({ id: 'home.folders.destination', message: 'Destination' })}
            isDisabled={pending}
            selectedKey={destination}
            onSelectionChange={(key) => {
              onDestination(String(key));
            }}
          >
            <ListBoxItem id="root">{rootLabel}</ListBoxItem>
            {destinations.map((folder) => (
              <ListBoxItem
                id={folder.id}
                key={folder.id}
                textValue={folder.name}
                group={folder.path.at(-1) ?? 'root'}
                groupName={folders.find((parent) => parent.id === folder.path.at(-1))?.name ?? rootLabel}
                description={folder.path
                  .map((id) => folders.find((parent) => parent.id === id)?.name)
                  .filter(Boolean)
                  .join(' / ')}
              >
                {[
                  ...folder.path
                    .map((id) => folders.find((parent) => parent.id === id)?.name)
                    .filter(Boolean),
                  folder.name,
                ].join(' / ')}
              </ListBoxItem>
            ))}
          </Select>
          {losses ? (
            <div role="alert">
              <p>
                {t({
                  id: 'home.folders.losses',
                  message: 'These people will lose access or have a lower role after this move.',
                })}
              </p>
              <ul>
                {[...new Set(losses.map((person) => person.name))].map((person) => (
                  <li key={person}>{person}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button onPress={() => onClose()} isDisabled={pending}>
            {t({ id: 'common.cancel', message: 'Cancel' })}
          </Button>
          <Button
            variant="primary"
            isPending={pending}
            onPress={() => {
              onMove();
            }}
          >
            {losses
              ? t({ id: 'home.folders.confirmMove', message: 'Confirm move' })
              : t({ id: 'home.folders.moveButton', message: 'Move' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
