import { Separator as AriaSeparator, type SeparatorProps as AriaSeparatorProps } from 'react-aria-components';
import { cx } from './cx';
import './Separator.css';

export interface SeparatorProps extends Omit<AriaSeparatorProps, 'className'> {
  className?: string;
}

/**
 * A hairline between two groups of content.  A horizontal rule renders as an `hr`, whose role and
 * orientation are implicit, and a vertical one as a `div` carrying `aria-orientation`; the styles
 * key off that attribute so both are one pixel of the theme's border color.
 */
export function Separator({ className, ...props }: SeparatorProps) {
  return <AriaSeparator {...props} className={cx('rio-separator', className)} />;
}
