import { useState } from 'react';
import { Button } from './Button';
import { Dialog, DialogBody, DialogFooter, DialogTitle } from './Dialog';
import { Drawer } from './Drawer';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
const settings = [
  'Theme follows the system setting',
  'Run queries with the connection role',
  'Keep fifty queries in the history',
  'Show row counts in the result grid',
  'Wrap long values in the result grid',
  'Send a copy of errors to the log',
];

function DrawerDemo({
  label,
  isDismissable,
  side,
}: {
  label: string;
  isDismissable?: boolean;
  side?: 'start' | 'end' | 'bottom';
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onPress={() => setOpen(true)}>{label}</Button>
      <Drawer isOpen={open} onOpenChange={setOpen} isDismissable={isDismissable} side={side}>
        <Dialog>
          <DialogTitle>{label}</DialogTitle>
          <DialogBody>
            {settings.map((setting) => (
              <p key={setting}>{setting}</p>
            ))}
          </DialogBody>
          <DialogFooter>
            <Button onPress={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" onPress={() => setOpen(false)}>
              Save
            </Button>
          </DialogFooter>
        </Dialog>
      </Drawer>
    </>
  );
}

function TallDrawerDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onPress={() => setOpen(true)}>Long sheet</Button>
      <Drawer isOpen={open} onOpenChange={setOpen} isDismissable>
        <Dialog>
          <DialogTitle>Long sheet</DialogTitle>
          <DialogBody>
            {Array.from({ length: 40 }, (_, index) => index + 1).map((row) => (
              <p key={row}>
                Connection {row} keeps its own copy of these settings, so the sheet scrolls instead of growing
                past the screen.
              </p>
            ))}
          </DialogBody>
          <DialogFooter>
            <Button variant="primary" onPress={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </Dialog>
      </Drawer>
    </>
  );
}

export const gallery: GalleryEntry = {
  id: 'ui.drawer',
  title: 'Drawer',
  examples: [
    {
      id: 'settings',
      render: () => <DrawerDemo label="Settings" isDismissable />,
    },
    {
      id: 'no-outside-close',
      render: () => <DrawerDemo label="Only a button closes it" />,
    },
    {
      id: 'scrolling',
      render: () => <TallDrawerDemo />,
    },
    {
      id: 'bottom-sheet',
      render: () => <DrawerDemo label="Bottom sheet" side="bottom" isDismissable />,
    },
  ],
};
