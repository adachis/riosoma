import { faChevronDown, faChevronUp } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Icon } from '@riosoma/icons';
import {
  Button as AriaButton,
  Input as AriaInput,
  NumberField as AriaNumberField,
  type NumberFieldProps as AriaNumberFieldProps,
} from 'react-aria-components';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { FieldShell, type FieldErrorMessage, type FieldSize } from './FieldShell';
import './NumberField.css';
import { Tooltip, TooltipTrigger } from './Tooltip';

export interface NumberFieldProps extends Omit<
  AriaNumberFieldProps,
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
  className?: string;
}

/**
 * A number field with steppers stacked at its inline end.  The value is a number in the caller's
 * hands and formatted text in the reader's: `formatOptions` decides the grouping, decimals, units,
 * and currency, in whatever locale the app runs.  The steppers keep their room at every bound, so
 * the value never moves when one of them becomes unavailable.
 */
export function NumberField({
  label,
  description,
  errorMessage,
  placeholder,
  size = 'md',
  className,
  ...rest
}: NumberFieldProps) {
  const { t } = useLingui();
  return (
    <AriaNumberField {...rest} className={cx('rio-field', 'rio-number-field', className)} data-size={size}>
      <FieldShell
        label={label}
        description={description}
        errorMessage={errorMessage}
        isRequired={rest.isRequired}
        actions={
          <span className="rio-number-field__steps">
            <TooltipTrigger>
              <AriaButton
                slot="increment"
                className="rio-field__action rio-number-field__step"
                aria-label={t({ id: 'ui.numberField.increase', message: 'Increase' })}
                data-tooltip={t({ id: 'ui.numberField.increase', message: 'Increase' })}
              >
                <Icon icon={faChevronUp} size="0.75em" />
              </AriaButton>
              <Tooltip>{t({ id: 'ui.numberField.increase', message: 'Increase' })}</Tooltip>
            </TooltipTrigger>
            <TooltipTrigger>
              <AriaButton
                slot="decrement"
                className="rio-field__action rio-number-field__step"
                aria-label={t({ id: 'ui.numberField.decrease', message: 'Decrease' })}
                data-tooltip={t({ id: 'ui.numberField.decrease', message: 'Decrease' })}
              >
                <Icon icon={faChevronDown} size="0.75em" />
              </AriaButton>
              <Tooltip>{t({ id: 'ui.numberField.decrease', message: 'Decrease' })}</Tooltip>
            </TooltipTrigger>
          </span>
        }
      >
        <AriaInput className="rio-field__input" placeholder={placeholder} />
      </FieldShell>
    </AriaNumberField>
  );
}
