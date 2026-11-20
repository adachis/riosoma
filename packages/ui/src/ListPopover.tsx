import { Popover as AriaPopover, type PopoverProps as AriaPopoverProps } from 'react-aria-components';
import { cx } from './cx';
import './ListPopover.css';

export interface ListPopoverProps extends Omit<AriaPopoverProps, 'className'> {
  className?: string;
}

/**
 * The panel a Menu, Select, or ComboBox opens into.  React Aria positions it against the trigger,
 * caps its block size with an inline max-height, and publishes the trigger's width as
 * `--trigger-width`, so the panel is a flex column and lets the list inside it scroll.
 *
 * Shared by the three list components instead of exported, so the group has one overlay look.
 */
export function ListPopover({ className, offset = 4, ...props }: ListPopoverProps) {
  return <AriaPopover {...props} offset={offset} className={cx('rio-list-popover', className)} />;
}
