import {
  FieldError as AriaFieldError,
  Label as AriaLabel,
  Text,
  type FieldErrorProps,
  type LabelProps,
  type TextProps,
} from 'react-aria-components';
import { cx } from './cx';
import './Field.css';

/**
 * The pieces every form control shares.  React Aria wires them to the control through context,
 * so a Label inside a TextField labels its input and a FieldError is announced with it.
 */
export function Label({ className, ...props }: LabelProps) {
  return <AriaLabel {...props} className={cx('rio-label', className)} />;
}

export function Description({ className, ...props }: Omit<TextProps, 'slot'>) {
  return <Text {...props} slot="description" className={cx('rio-description', className)} />;
}

export function FieldError({
  className,
  ...props
}: Omit<FieldErrorProps, 'className'> & { className?: string }) {
  return <AriaFieldError {...props} className={cx('rio-field-error', className)} />;
}
