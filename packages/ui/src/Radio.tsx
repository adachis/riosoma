import { RadioButton, RadioField, type RadioFieldProps } from 'react-aria-components';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { Description } from './Field';
import './Radio.css';

export interface RadioProps extends Omit<RadioFieldProps, 'className' | 'style' | 'children'> {
  /** Help text under the label; React Aria links it to the radio with `aria-describedby`. */
  description?: ReactNode;
  className?: string;
  /** The label, at the inline end of the circle. */
  children?: ReactNode;
}

/**
 * One option inside a `RadioGroup`, which owns the selection, the arrow key handling, and the
 * error: a radio that cannot be chosen on its own has no message of its own to show either.
 */
export function Radio({ description, className, children, ...rest }: RadioProps) {
  return (
    <RadioField {...rest} className={cx('rio-radio', className)}>
      <RadioButton className="rio-radio__control">
        <span className="rio-radio__box" aria-hidden="true" />
        <span className="rio-radio__label">{children}</span>
      </RadioButton>
      {description == null ? null : <Description>{description}</Description>}
    </RadioField>
  );
}
