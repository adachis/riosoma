import { faCheck } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { CHOICE_COLORS, type ChoiceColor } from '@riosoma/contracts';
import { Icon } from '@riosoma/icons';
import {
  RadioField,
  RadioButton,
  RadioGroup as AriaRadioGroup,
  type RadioGroupProps as AriaRadioGroupProps,
} from 'react-aria-components';
import type { ReactNode } from 'react';
import { Label } from './Field';
import { cx } from './cx';
import './ColorSwatchPicker.css';

export interface ColorSwatchPickerProps extends Omit<
  AriaRadioGroupProps,
  'className' | 'style' | 'children' | 'orientation' | 'value' | 'defaultValue' | 'onChange'
> {
  /** The group's name, which assistive technology announces with the swatches. */
  label: ReactNode;
  /** The chosen color (controlled). */
  value?: ChoiceColor;
  /** The color the picker starts on (uncontrolled). */
  defaultValue?: ChoiceColor;
  onChange?: (color: ChoiceColor) => void;
  className?: string;
}

/**
 * The ten choice colors as swatches in a row.  It is a radio group — React Aria owns the selection,
 * the arrow keys, and the single tab stop — and the color of a swatch is its whole label, so each
 * one is named by the color it shows.  The tick stays laid out and only fades, so picking a color
 * never moves a swatch.
 */
export function ColorSwatchPicker({
  label,
  value,
  defaultValue,
  onChange,
  className,
  ...rest
}: ColorSwatchPickerProps) {
  const { t } = useLingui();
  // Every color names itself, and a color the contracts do not define cannot be drawn here.
  const names: Record<ChoiceColor, string> = {
    gray: t({ id: 'ui.color.gray', message: 'Gray' }),
    red: t({ id: 'ui.color.red', message: 'Red' }),
    orange: t({ id: 'ui.color.orange', message: 'Orange' }),
    yellow: t({ id: 'ui.color.yellow', message: 'Yellow' }),
    green: t({ id: 'ui.color.green', message: 'Green' }),
    teal: t({ id: 'ui.color.teal', message: 'Teal' }),
    blue: t({ id: 'ui.color.blue', message: 'Blue' }),
    purple: t({ id: 'ui.color.purple', message: 'Purple' }),
    pink: t({ id: 'ui.color.pink', message: 'Pink' }),
    brown: t({ id: 'ui.color.brown', message: 'Brown' }),
  };
  return (
    <AriaRadioGroup
      {...rest}
      className={cx('rio-color-swatch-picker', className)}
      // The swatches sit in a row, so the arrow keys follow it.
      orientation="horizontal"
      value={value}
      defaultValue={defaultValue}
      onChange={(next) => {
        // The group reports a plain string; only one of our own swatches can produce it.
        const color = CHOICE_COLORS.find((each) => each === next);
        if (color != null) onChange?.(color);
      }}
    >
      <Label>{label}</Label>
      <div className="rio-color-swatch-picker__swatches">
        {CHOICE_COLORS.map((color) => (
          <RadioField
            key={color}
            value={color}
            className="rio-color-swatch-picker__field"
            aria-label={names[color]}
          >
            <RadioButton className="rio-color-swatch-picker__control">
              <span className="rio-color-swatch-picker__swatch" data-color={color} aria-hidden="true">
                <Icon icon={faCheck} className="rio-color-swatch-picker__check" size="var(--rio-text-xs)" />
              </span>
            </RadioButton>
          </RadioField>
        ))}
      </div>
    </AriaRadioGroup>
  );
}
