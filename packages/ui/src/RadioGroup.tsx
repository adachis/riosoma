import {
  RadioGroup as AriaRadioGroup,
  type RadioGroupProps as AriaRadioGroupProps,
} from 'react-aria-components';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { Description, FieldError, Label } from './Field';
import './RadioGroup.css';

export interface RadioGroupProps extends Omit<AriaRadioGroupProps, 'className' | 'style' | 'children'> {
  /** Lays the radios out in a row instead of a column, and steers the arrow keys the same way. */
  orientation?: 'vertical' | 'horizontal';
  /** The group's name, which assistive technology announces with the radios. */
  label?: ReactNode;
  description?: ReactNode;
  /** Shown while the group is invalid; falls back to the messages a `validate` function returns. */
  errorMessage?: ReactNode;
  className?: string;
  children?: ReactNode;
}

/**
 * A set of mutually exclusive options.  React Aria owns the selection and the arrow key handling,
 * which follows `orientation`, so a group of radios behaves like a single control in the tab order.
 */
export function RadioGroup({
  orientation = 'vertical',
  label,
  description,
  errorMessage,
  className,
  children,
  ...rest
}: RadioGroupProps) {
  return (
    <AriaRadioGroup {...rest} orientation={orientation} className={cx('rio-radio-group', className)}>
      {label == null ? null : <Label>{label}</Label>}
      {description == null ? null : <Description>{description}</Description>}
      {/* Only the radios follow the orientation, so they get a box of their own. */}
      <div className="rio-radio-group__items" data-orientation={orientation}>
        {children}
      </div>
      <FieldError>{errorMessage}</FieldError>
    </AriaRadioGroup>
  );
}
