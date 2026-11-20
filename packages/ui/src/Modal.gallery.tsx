import { useState } from 'react';
import { Button } from './Button';
import { Dialog, DialogBody, DialogFooter, DialogTitle } from './Dialog';
import { Modal, type ModalSize } from './Modal';
import type { GalleryEntry } from './gallery';

interface DemoProps {
  label: string;
  size?: ModalSize;
  isDismissable?: boolean;
}

// Gallery examples are a developer tool, so their sample labels are plain text.
function Demo({ label, size, isDismissable }: DemoProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onPress={() => setOpen(true)}>{label}</Button>
      <Modal isOpen={open} onOpenChange={setOpen} size={size} isDismissable={isDismissable}>
        <Dialog>
          <DialogTitle>{label}</DialogTitle>
          <DialogBody>
            <p>The scrim behind this panel is what a press outside lands on.</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="primary" onPress={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </Dialog>
      </Modal>
    </>
  );
}

export const gallery: GalleryEntry = {
  id: 'ui.modal',
  title: 'Modal',
  examples: [
    {
      id: 'sizes',
      render: () => (
        <>
          <Demo label="Small" size="sm" />
          <Demo label="Medium" size="md" />
          <Demo label="Large" size="lg" />
        </>
      ),
    },
    {
      id: 'dismissal',
      render: () => (
        <>
          <Demo label="Press outside closes" isDismissable />
          <Demo label="Only Escape or a button closes" />
        </>
      ),
    },
  ],
};
