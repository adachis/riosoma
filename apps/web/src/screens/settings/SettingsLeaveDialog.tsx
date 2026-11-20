import { useEffect } from 'react';
import { Trans } from '@lingui/react/macro';
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal } from '@riosoma/ui';

export function SettingsLeaveDialog({
  saving,
  error,
  onKeep,
  onDiscard,
  onSave,
}: {
  saving: boolean;
  error: string | null;
  onKeep(): void;
  onDiscard(): void;
  onSave(): void;
}) {
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>('[data-settings-keep]')?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onKeep();
      }}
    >
      <Dialog hideCloseButton>
        <DialogTitle>
          <Trans id="settings.draft.leave">You have unsaved changes on this page.</Trans>
        </DialogTitle>
        <DialogBody>{error && <p role="alert">{error}</p>}</DialogBody>
        <DialogFooter>
          <Button autoFocus data-settings-keep onPress={onKeep}>
            <Trans id="settings.draft.keep">Keep editing</Trans>
          </Button>
          <Button isDisabled={saving} onPress={onDiscard}>
            <Trans id="settings.draft.discardContinue">Discard and continue</Trans>
          </Button>
          <Button variant="primary" isPending={saving} isDisabled={saving} onPress={onSave}>
            <Trans id="settings.draft.saveContinue">Save and continue</Trans>
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
