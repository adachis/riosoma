import type { ReactNode } from 'react';
import { Dialog, DialogBody, DialogTitle, Drawer } from '@riosoma/ui';

export function ShellDrawer({
  title,
  side,
  onClose,
  children,
}: {
  title: string;
  side?: 'start';
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <Drawer
      side={side}
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
    >
      <Dialog aria-label={title} hideCloseButton={!side}>
        {side ? (
          <>
            <DialogTitle>{title}</DialogTitle>
            <DialogBody>{children}</DialogBody>
          </>
        ) : (
          children
        )}
      </Dialog>
    </Drawer>
  );
}
