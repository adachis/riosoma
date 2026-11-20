import {
  CheckboxGroup as AriaCheckboxGroup,
  type CheckboxGroupProps as AriaCheckboxGroupProps,
} from 'react-aria-components';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { Description, FieldError, Label } from './Field';
import './CheckboxGroup.css';

export interface CheckboxGroupProps extends Omit<AriaCheckboxGroupProps, 'className' | 'style' | 'children'> {
  /** Lays the checkboxes out in a row instead of a column. */
  orientation?: 'vertical' | 'horizontal';
  /** The group's name, which assistive technology announces with the checkboxes. */
  label?: ReactNode;
  description?: ReactNode;
  /** Shown while the group is invalid; falls back to the messages a `validate` function returns. */
  errorMessage?: ReactNode;
  className?: string;
  children?: ReactNode;
}

/**
 * A set of checkboxes that share one label, description, and error.  The checkboxes themselves are
 * ordinary `Checkbox` components; React Aria collects their values into the group's selection.
 */
export function CheckboxGroup({
  orientation = 'vertical',
  label,
  description,
  errorMessage,
  className,
  children,
  ...rest
}: CheckboxGroupProps) {
  return (
    <AriaCheckboxGroup {...rest} className={cx('rio-checkbox-group', className)}>
      {label == null ? null : <Label>{label}</Label>}
      {description == null ? null : <Description>{description}</Description>}
      {/* Only the checkboxes follow the orientation, so they get a box of their own. */}
      <div className="rio-checkbox-group__items" data-orientation={orientation}>
        {children}
      </div>
      <FieldError>{errorMessage}</FieldError>
    </AriaCheckboxGroup>
  );
}
