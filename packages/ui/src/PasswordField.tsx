import { faEye, faEyeSlash } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Icon } from '@riosoma/icons';
import {
  Button as AriaButton,
  Input as AriaInput,
  TextField as AriaTextField,
  type PressEvent,
  type TextFieldProps as AriaTextFieldProps,
} from 'react-aria-components';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { FieldShell, type FieldErrorMessage, type FieldSize } from './FieldShell';
import './PasswordField.css';
import { Tooltip, TooltipTrigger } from './Tooltip';

export interface PasswordFieldProps extends Omit<
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
  /** Whether the value starts out visible instead of masked. */
  defaultRevealed?: boolean;
  className?: string;
}

/**
 * A text field that masks its value, with a button that reveals it.  Revealing never takes focus
 * away from the input when the reader clicks, so the cursor stays where it was; from the keyboard
 * the button keeps focus, because moving it would throw away the reader's place.  `autoComplete`
 * is the caller's choice: `current-password` to sign in, `new-password` to choose one.
 */
export function PasswordField({
  label,
  description,
  errorMessage,
  placeholder,
  size = 'md',
  defaultRevealed = false,
  className,
  ...rest
}: PasswordFieldProps) {
  const { t } = useLingui();
  const [revealed, setRevealed] = useState(defaultRevealed);
  const inputRef = useRef<HTMLInputElement>(null);
  const revealLabel = revealed
    ? t({ id: 'ui.passwordField.hide', message: 'Hide password' })
    : t({ id: 'ui.passwordField.show', message: 'Show password' });

  function onPressStart(event: PressEvent) {
    // preventFocusOnPress keeps the browser from focusing the button, so a pointer press puts
    // focus back in the input; a keyboard press keeps the reader's place on the button.
    if (event.pointerType !== 'keyboard') inputRef.current?.focus();
  }

  return (
    <AriaTextField
      {...rest}
      type={revealed ? 'text' : 'password'}
      className={cx('rio-field', 'rio-password-field', className)}
      data-size={size}
    >
      <FieldShell
        label={label}
        description={description}
        errorMessage={errorMessage}
        isRequired={rest.isRequired}
        actions={
          <TooltipTrigger>
            <AriaButton
              className="rio-field__action rio-password-field__reveal"
              preventFocusOnPress
              onPressStart={onPressStart}
              onPress={() => setRevealed((wasRevealed) => !wasRevealed)}
              aria-label={revealLabel}
              data-tooltip={revealLabel}
            >
              <Icon icon={revealed ? faEyeSlash : faEye} size="0.85em" />
            </AriaButton>
            <Tooltip>{revealLabel}</Tooltip>
          </TooltipTrigger>
        }
      >
        <AriaInput ref={inputRef} className="rio-field__input" placeholder={placeholder} />
      </FieldShell>
    </AriaTextField>
  );
}
