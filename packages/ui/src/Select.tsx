import {
  Button as AriaButton,
  Select as AriaSelect,
  SelectValue,
  type SelectProps as AriaSelectProps,
} from 'react-aria-components';
import { faChevronDown } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Icon } from '@riosoma/icons';
import { Description, FieldError, Label } from './Field';
import { ListBox } from './ListBox';
import { ListPopover } from './ListPopover';
import { cx } from './cx';
import './Select.css';
import { LongSelectOptions, selectItems } from './LongSelect';

export interface SelectProps<T extends object> extends Omit<AriaSelectProps<T>, 'className'> {
  /** Matches the text field sizes, so a form can mix both. */
  size?: 'sm' | 'md' | 'lg';
  listId?: string;
  filterable?: boolean;
  /** Field label.  Without it, name the select with `aria-label`. */
  label?: React.ReactNode;
  description?: React.ReactNode;
  /** Shown only while the select is invalid. */
  errorMessage?: React.ReactNode;
  /**
   * Opens the panel without a modal underlay.  Use it where the select sits inside something that
   * is already modal, or where a panel must stay open next to the rest of the page.
   */
  isNonModal?: boolean;
  className?: string;
}

/**
 * A single choice from a fixed list.  The trigger is drawn like a text field, and the panel holds
 * a ListBox whose selected option carries a check.
 *
 * ```tsx
 * <Select label="Sort by" selectedKey={sort} onSelectionChange={setSort}>
 *   <ListBoxItem id="name">Name</ListBoxItem>
 *   <ListBoxItem id="created">Date created</ListBoxItem>
 * </Select>
 * ```
 */
export function Select<T extends object>({
  size = 'md',
  label,
  description,
  errorMessage,
  placeholder,
  isNonModal,
  className,
  children,
  listId,
  filterable,
  ...props
}: SelectProps<T>) {
  const { t } = useLingui();
  const options = typeof children === 'function' ? null : selectItems(children);
  const long = options && (filterable || options.length > 10);
  const pickerLabel =
    typeof label === 'string'
      ? label
      : (props['aria-label'] ?? t({ id: 'ui.select.placeholder', message: 'Choose…' }));
  const placeholderText = placeholder ?? t({ id: 'ui.select.placeholder', message: 'Choose…' });
  return (
    <AriaSelect
      {...props}
      placeholder={placeholderText}
      className={cx('rio-select', className)}
      data-size={size}
    >
      {label == null ? null : <Label>{label}</Label>}
      <AriaButton className="rio-select__trigger">
        {/*
          The trigger shows the chosen option's text, not its row: an option carries a check mark,
          an icon, and a description that belong in the panel only.  Options without a text value
          fall back to their own markup.
        */}
        <SelectValue className="rio-select__value">
          {({ isPlaceholder, selectedText, defaultChildren }) =>
            isPlaceholder ? placeholderText : selectedText || defaultChildren
          }
        </SelectValue>
        <Icon icon={faChevronDown} className="rio-select__chevron" />
      </AriaButton>
      {description == null ? null : <Description>{description}</Description>}
      {errorMessage == null ? null : <FieldError>{errorMessage}</FieldError>}
      <ListPopover isNonModal={isNonModal} className={long ? 'rio-picker-popover' : undefined}>
        {long ? (
          <LongSelectOptions options={options} label={pickerLabel} listId={listId} />
        ) : (
          <ListBox size={size}>{children}</ListBox>
        )}
      </ListPopover>
    </AriaSelect>
  );
}
