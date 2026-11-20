import { faEye, faEyeSlash } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Icon } from '@riosoma/icons';
import {
  Button as AriaButton,
  TextArea as AriaTextArea,
  TextField as AriaTextField,
  type PressEvent,
  type TextFieldProps as AriaTextFieldProps,
} from 'react-aria-components';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { FieldShell, type FieldErrorMessage, type FieldSize } from './FieldShell';
import './SecretArea.css';
import { Tooltip, TooltipTrigger } from './Tooltip';

export interface SecretAreaProps extends Omit<
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
  /** Whether the value starts out visible instead of masked. */
  defaultRevealed?: boolean;
  className?: string;
}

/**
 * The multi-line secret field: a block of text, like a PEM key or a JSON key file, masked line by
 * line as it is typed or pasted the way a password is, with a button that reveals it.  Paste keeps
 * its line breaks, since the value itself is never touched, only the glyphs drawn for it.  Revealing
 * never takes focus away from the textarea when the reader clicks, so the cursor stays where it was;
 * from the keyboard the button keeps focus, because moving it would throw away the reader's place.
 *
 * A password manager has nothing to offer a block of text, and a certificate has no words to spell
 * check, so both are turned off here.
 */
export function SecretArea({
  label,
  description,
  errorMessage,
  placeholder,
  size = 'md',
  rows = 4,
  defaultRevealed = false,
  className,
  ...rest
}: SecretAreaProps) {
  const { t } = useLingui();
  const [revealed, setRevealed] = useState(defaultRevealed);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const revealLabel = revealed
    ? t({ id: 'ui.secretArea.hide', message: 'Hide value' })
    : t({ id: 'ui.secretArea.show', message: 'Show value' });

  function onPressStart(event: PressEvent) {
    // preventFocusOnPress keeps the browser from focusing the button, so a pointer press puts
    // focus back in the textarea; a keyboard press keeps the reader's place on the button.
    if (event.pointerType !== 'keyboard') inputRef.current?.focus();
  }

  return (
    <AriaTextField
      {...rest}
      className={cx('rio-field', 'rio-text-area', 'rio-secret-area', className)}
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
              className="rio-field__action rio-secret-area__reveal"
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
        <AriaTextArea
          ref={inputRef}
          className="rio-field__input"
          placeholder={placeholder}
          rows={rows}
          // Masked while hidden; the value stays whole, so only what the reader sees changes.
          data-masked={revealed ? undefined : true}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          // Keep the common password managers from offering to fill or save a block of text.
          data-1p-ignore
          data-lpignore="true"
          data-bwignore=""
          data-form-type="other"
        />
      </FieldShell>
    </AriaTextField>
  );
}
