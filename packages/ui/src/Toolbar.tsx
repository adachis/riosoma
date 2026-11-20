import { Toolbar as AriaToolbar, type ToolbarProps as AriaToolbarProps } from 'react-aria-components';
import { cx } from './cx';
import './Toolbar.css';

/** comfortable: the default.  compact: dense places, such as the header of a table. */
export type ToolbarDensity = 'comfortable' | 'compact';

export interface ToolbarProps extends Omit<AriaToolbarProps, 'className' | 'children'> {
  density?: ToolbarDensity;
  className?: string;
  children?: React.ReactNode;
}

/**
 * A row (or column) of controls that is one tab stop: React Aria moves the arrow keys between the
 * controls inside it and Tab leaves the whole group.  Density changes the gaps and padding only, so
 * a control keeps its own size whichever toolbar it sits in.
 */
export function Toolbar({ density = 'comfortable', className, ...props }: ToolbarProps) {
  return <AriaToolbar {...props} data-density={density} className={cx('rio-toolbar', className)} />;
}
