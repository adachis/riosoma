import type { RefObject } from 'react';
import { Menu } from './Menu';

/** The shared menu loads when someone asks to arrange an item. */
export default function SortableActionsMenu({
  anchor,
  label,
  close,
  focus,
}: {
  anchor: RefObject<HTMLElement | null>;
  label: string;
  close(): void;
  focus: 'first' | 'last';
}) {
  return (
    <Menu
      aria-label={label}
      triggerRef={anchor}
      isOpen
      autoFocus={focus}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onClose={close}
    />
  );
}
