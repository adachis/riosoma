import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { Dialog, DialogBody, DialogFooter, DialogTitle } from './Dialog';
import { Modal, type ModalSize } from './Modal';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
function DialogDemo({
  label,
  size = 'md',
  hideCloseButton,
  children,
}: {
  label: string;
  size?: ModalSize;
  hideCloseButton?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onPress={() => setOpen(true)}>{label}</Button>
      <Modal isOpen={open} onOpenChange={setOpen} size={size}>
        <Dialog hideCloseButton={hideCloseButton}>
          <DialogTitle>{label}</DialogTitle>
          {children}
        </Dialog>
      </Modal>
    </>
  );
}

const rows = Array.from({ length: 24 }, (_, index) => index + 1);

function RenderPropDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onPress={() => setOpen(true)}>Close from children</Button>
      <Modal isOpen={open} onOpenChange={setOpen} size="sm">
        <Dialog>
          {({ close }) => (
            <>
              <DialogTitle>Close from children</DialogTitle>
              <DialogBody>
                <p>Children can be a function that receives the way to close it.</p>
              </DialogBody>
              <DialogFooter>
                <Button variant="primary" onPress={close}>
                  Done
                </Button>
              </DialogFooter>
            </>
          )}
        </Dialog>
      </Modal>
    </>
  );
}

export const gallery: GalleryEntry = {
  id: 'ui.dialog',
  title: 'Dialog',
  examples: [
    {
      id: 'parts',
      render: () => (
        <DialogDemo label="Title, body, footer" size="sm">
          <DialogBody>
            <p>The body holds the content; the footer holds the actions.</p>
          </DialogBody>
          <DialogFooter>
            <Button>Cancel</Button>
            <Button variant="primary">Save</Button>
          </DialogFooter>
        </DialogDemo>
      ),
    },
    {
      id: 'scrolling-body',
      render: () => (
        <DialogDemo label="Tall body">
          <DialogBody>
            <ol>
              {rows.map((row) => (
                <li key={row}>Query {row} reads this column and has to be updated with it.</li>
              ))}
            </ol>
          </DialogBody>
          <DialogFooter>
            <Button variant="primary">Rename all</Button>
          </DialogFooter>
        </DialogDemo>
      ),
    },
    {
      id: 'without-close-button',
      render: () => (
        <DialogDemo label="No corner button" size="sm" hideCloseButton>
          <DialogBody>
            <p>This dialog has to be answered through its own buttons.</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="primary">Understood</Button>
          </DialogFooter>
        </DialogDemo>
      ),
    },
    {
      id: 'actions',
      render: () => (
        <DialogDemo label="Several actions" size="lg">
          <DialogBody>
            <p>Actions sit at the inline end, with the primary one last.</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="quiet">Learn more</Button>
            <Button variant="danger">Drop</Button>
            <Button>Cancel</Button>
            <Button variant="primary">Save</Button>
          </DialogFooter>
        </DialogDemo>
      ),
    },
    {
      id: 'render-props',
      render: () => <RenderPropDemo />,
    },
  ],
};
