import { SwitchButton, SwitchField, type SwitchFieldProps } from 'react-aria-components';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { Description, FieldError } from './Field';
import './Switch.css';

export interface SwitchProps extends Omit<SwitchFieldProps, 'className' | 'style' | 'children'> {
  /** Help text under the label; React Aria links it to the switch with `aria-describedby`. */
  description?: ReactNode;
  className?: string;
  /** The label, at the inline end of the track. */
  children?: ReactNode;
}

/**
 * An on or off setting.  The thumb slides along `inset-inline-start`, which is what makes it travel
 * the right way in a right-to-left layout, and the track keeps its size in both states.
 */
export function Switch({ description, className, children, ...rest }: SwitchProps) {
  return (
    <SwitchField {...rest} className={cx('rio-switch', className)}>
      <SwitchButton className="rio-switch__control">
        <span className="rio-switch__track" aria-hidden="true">
          <span className="rio-switch__thumb" />
        </span>
        <span className="rio-switch__label">{children}</span>
      </SwitchButton>
      {description == null ? null : <Description>{description}</Description>}
      <FieldError />
    </SwitchField>
  );
}
