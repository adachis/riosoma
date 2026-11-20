import { faCheck, faMinus } from '@fortawesome/free-solid-svg-icons';
import { Icon } from '@riosoma/icons';
import { CheckboxButton, CheckboxField, type CheckboxFieldProps } from 'react-aria-components';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { Description, FieldError } from './Field';
import './Checkbox.css';

export interface CheckboxProps extends Omit<CheckboxFieldProps, 'className' | 'style' | 'children'> {
  /** Help text under the label; React Aria links it to the checkbox with `aria-describedby`. */
  description?: ReactNode;
  className?: string;
  /** The label, at the inline end of the box. */
  children?: ReactNode;
}

/**
 * A single checkbox.  The box keeps its size in every state: the tick and the dash stay mounted
 * and only fade, so moving to and from `isIndeterminate` never shifts the label.  Inside a
 * `CheckboxGroup` React Aria reports validation once for the group, so the error stays empty here
 * and shows the messages a `validate` function returns for a standalone checkbox.
 */
export function Checkbox({ description, className, children, ...rest }: CheckboxProps) {
  return (
    <CheckboxField {...rest} className={cx('rio-checkbox', className)}>
      <CheckboxButton className="rio-checkbox__control">
        <span className="rio-checkbox__box" aria-hidden="true">
          {/* Both marks stay mounted and only fade, which keeps the box the same size. */}
          <Icon icon={faCheck} className="rio-checkbox__tick" size="var(--rio-text-xs)" />
          <Icon icon={faMinus} className="rio-checkbox__dash" size="var(--rio-text-xs)" />
        </span>
        <span className="rio-checkbox__label">{children}</span>
      </CheckboxButton>
      {description == null ? null : <Description>{description}</Description>}
      <FieldError />
    </CheckboxField>
  );
}
