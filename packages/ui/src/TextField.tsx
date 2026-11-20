import {
  Input as AriaInput,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
} from 'react-aria-components';
import type { IconDefinition } from '@riosoma/icons';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { FieldShell, type FieldErrorMessage, type FieldSize } from './FieldShell';
import './TextField.css';

export interface TextFieldProps extends Omit<
  AriaTextFieldProps,
  | 'className'
  | 'style'
  | 'children'
  | 'label'
  | 'description'
  | 'errorMessage'
  | 'placeholder'
  | 'validationState'
> {
  /** Visible label.  Callers pass text that is already translated. */
  label?: ReactNode;
  /** Help text under the control. */
  description?: ReactNode;
  /** Error text, shown only while the field is invalid. */
  errorMessage?: FieldErrorMessage;
  placeholder?: string;
  size?: FieldSize;
  /** Decorative leading icon. */
  icon?: IconDefinition;
  className?: string;
}

/**
 * A single-line text field: a label, the framed input, and the help or error text below it.  The
 * input always fills its container's inline size, so callers decide how wide a field is.
 */
export function TextField({
  label,
  description,
  errorMessage,
  placeholder,
  size = 'md',
  icon,
  className,
  ...rest
}: TextFieldProps) {
  return (
    <AriaTextField {...rest} className={cx('rio-field', 'rio-text-field', className)} data-size={size}>
      <FieldShell
        label={label}
        description={description}
        errorMessage={errorMessage}
        icon={icon}
        isRequired={rest.isRequired}
      >
        <AriaInput className="rio-field__input" placeholder={placeholder} />
      </FieldShell>
    </AriaTextField>
  );
}
