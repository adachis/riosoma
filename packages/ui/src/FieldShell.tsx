import { Icon, type IconDefinition } from '@riosoma/icons';
import { Group, type FieldErrorProps } from 'react-aria-components';
import type { ReactNode } from 'react';
import { Description, FieldError, Label } from './Field';
import './FieldShell.css';

/**
 * The control heights a field can take.  They are Button's heights, so a field and a button on the
 * same row line up.
 */
export type FieldSize = 'sm' | 'md' | 'lg';

/**
 * Anything a FieldError can render, including a function of the validation state, so callers can
 * list every reason a value was rejected.
 */
export type FieldErrorMessage = FieldErrorProps['children'];

export interface FieldShellProps {
  /** Visible label.  Callers pass text that is already translated. */
  label?: ReactNode;
  /** Help text under the control. */
  description?: ReactNode;
  /** Error text, rendered through FieldError so it appears only while the field is invalid. */
  errorMessage?: FieldErrorMessage;
  /** Decorative leading icon.  The label names the field, so the icon carries no text. */
  icon?: IconDefinition;
  /** Marks the label with a symbol that assistive technology ignores. */
  isRequired?: boolean;
  /** Controls at the inline end of the frame, such as a clear, reveal, or stepper button. */
  actions?: ReactNode;
  /** The input or textarea element itself. */
  children: ReactNode;
}

/**
 * The inside of every field in this group: label, framed control, help text, error text.  Each
 * component renders its own React Aria field around it, so the states and the wiring between the
 * label and the input stay the library's job while all of them look the same.
 */
export function FieldShell({
  label,
  description,
  errorMessage,
  icon,
  isRequired,
  actions,
  children,
}: FieldShellProps) {
  return (
    <>
      {label == null ? null : (
        <div className="rio-field__label">
          <Label>{label}</Label>
          {/* The symbol is a visual cue only; the requirement itself is on the input, and the
              symbol sits outside the label so it stays out of the label's own text. */}
          {isRequired ? (
            <span className="rio-field__required" aria-hidden="true">
              *
            </span>
          ) : null}
        </div>
      )}
      <Group className="rio-field__control">
        {icon ? <Icon className="rio-field__icon" icon={icon} /> : null}
        {children}
        {actions}
      </Group>
      {description == null ? null : <Description>{description}</Description>}
      {errorMessage == null ? null : <FieldError>{errorMessage}</FieldError>}
    </>
  );
}
