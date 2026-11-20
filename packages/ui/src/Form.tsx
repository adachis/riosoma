import { Form as AriaForm, type FormProps as AriaFormProps } from 'react-aria-components';
import { cx } from './cx';
import './Form.css';

export interface FormProps extends Omit<AriaFormProps, 'className'> {
  className?: string;
}

/**
 * A form with one rhythm: the same gap between every field, whatever control it holds, so screens
 * that stack several forms line up with each other.
 */
export function Form({ className, ...props }: FormProps) {
  return <AriaForm {...props} className={cx('rio-form', className)} />;
}

export interface FormActionsProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
}

/**
 * The row that submits or abandons the form.  It sits at the inline end, which is the right in a
 * left-to-right language and the left in a right-to-left one, because `justify-content` follows the
 * direction the row is written in.
 */
export function FormActions({ className, ...props }: FormActionsProps) {
  return <div {...props} className={cx('rio-form__actions', className)} />;
}
