import type { ReactNode, RefObject } from 'react';
import { Dialog } from 'react-aria-components';
import { Popover } from '@riosoma/ui';

/** The trigger stays mounted while positioning, focus management, and contents load. */
export function PopoverSurface({
  triggerRef,
  onClose,
  title,
  className,
  dialogClassName,
  children,
}: {
  triggerRef: RefObject<HTMLElement | null>;
  onClose(): void;
  title: string;
  className: string;
  dialogClassName: string;
  children: ReactNode;
}) {
  return (
    <Popover
      triggerRef={triggerRef}
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      placement="bottom end"
      className={className}
    >
      <Dialog aria-label={title} className={dialogClassName}>
        {children}
      </Dialog>
    </Popover>
  );
}
