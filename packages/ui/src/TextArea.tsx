import {
  TextArea as AriaTextArea,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
} from 'react-aria-components';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { FieldShell, type FieldErrorMessage, type FieldSize } from './FieldShell';
import './TextArea.css';

export interface TextAreaProps extends Omit<
  AriaTextFieldProps,
  | 'className'
  | 'style'
  | 'children'
  | 'label'
  | 'description'
  | 'errorMessage'
  | 'placeholder'
  | 'validationState'
  | 'type'
> {
  /** Visible label.  Callers pass text that is already translated. */
  label?: ReactNode;
  /** Help text under the control. */
  description?: ReactNode;
  /** Error text, shown only while the field is invalid. */
  errorMessage?: FieldErrorMessage;
  placeholder?: string;
  size?: FieldSize;
  /** How many lines the field shows.  The height stays fixed; only the reader's resize changes it. */
  rows?: number;
  className?: string;
}

/**
 * The multi-line field.  Its height is `rows` lines and stays that way: nothing grows while the
 * reader types, because a control that changes size moves whatever is below it.  The browser's
 * vertical resize handle is the one way to make it taller.
 */
export function TextArea({
  label,
  description,
  errorMessage,
  placeholder,
  size = 'md',
  rows = 3,
  className,
  ...rest
}: TextAreaProps) {
  return (
    <AriaTextField {...rest} className={cx('rio-field', 'rio-text-area', className)} data-size={size}>
      <FieldShell
        label={label}
        description={description}
        errorMessage={errorMessage}
        isRequired={rest.isRequired}
      >
        <AriaTextArea className="rio-field__input" placeholder={placeholder} rows={rows} />
      </FieldShell>
    </AriaTextField>
  );
}
