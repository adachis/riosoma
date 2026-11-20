import {
  Button as AriaButton,
  ComboBox as AriaComboBox,
  Group,
  Input,
  type ComboBoxProps as AriaComboBoxProps,
  type ListBoxRenderProps,
  useFilter,
} from 'react-aria-components';
import { faChevronDown } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Icon } from '@riosoma/icons';
import { Description, FieldError, Label } from './Field';
import { ListBox } from './ListBox';
import { ListPopover } from './ListPopover';
import { cx } from './cx';
import './ComboBox.css';
import { Tooltip, TooltipTrigger } from './Tooltip';
import { LongComboBoxOptions, selectItems } from './LongSelect';
import { useCallback, useEffect, useRef, useState } from 'react';
import { rememberPickerItem, type PickerItem } from './FilterableList';

export interface ComboBoxProps<T extends object> extends Omit<AriaComboBoxProps<T>, 'className'> {
  /** Matches the text field sizes, so a form can mix both. */
  size?: 'sm' | 'md' | 'lg';
  listId?: string;
  /** Field label.  Without it, name the combo box with `aria-label`. */
  label?: React.ReactNode;
  description?: React.ReactNode;
  /** Shown only while the combo box is invalid. */
  errorMessage?: React.ReactNode;
  /** Temporary text inside the input while it is empty. */
  placeholder?: string;
  /** Content shown when nothing matches.  Defaults to a "No matches" message. */
  renderEmptyState?: (props: ListBoxRenderProps) => React.ReactNode;
  className?: string;
}

function useHiddenTabStops(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const saved = new Map<HTMLElement, string | null>();
    const restore = () => {
      for (const [element, value] of saved) {
        if (value === null) element.removeAttribute('tabindex');
        else element.setAttribute('tabindex', value);
      }
      saved.clear();
    };
    const update = () => {
      // Controls hidden by a virtual-focus picker must also leave the keyboard's tab order.
      for (const hidden of document.querySelectorAll<HTMLElement>('[aria-hidden="true"]')) {
        const controls = [
          hidden,
          ...hidden.querySelectorAll<HTMLElement>(
            'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]',
          ),
        ];
        for (const control of controls) {
          if (control.tabIndex < 0 || saved.has(control)) continue;
          saved.set(control, control.getAttribute('tabindex'));
          control.tabIndex = -1;
        }
      }
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-hidden'],
    });
    // Tab and an outside press close the picker; restore targets before their default actions.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab') restore();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', restore, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', restore, true);
      restore();
    };
  }, [open]);
}

/**
 * A choice you can also type.  Typing filters the options, and the panel stays open with an empty
 * state so "nothing matches" is a visible answer rather than a panel that disappears.
 *
 * ```tsx
 * <ComboBox label="Table" allowsCustomValue onSelectionChange={pick}>
 *   <ListBoxItem id="orders">orders</ListBoxItem>
 *   <ListBoxItem id="people">people</ListBoxItem>
 * </ComboBox>
 * ```
 */
export function ComboBox<T extends object>({
  size = 'md',
  label,
  description,
  errorMessage,
  placeholder,
  className,
  children,
  allowsEmptyCollection = true,
  renderEmptyState,
  listId,
  onSelectionChange,
  onOpenChange,
  ...props
}: ComboBoxProps<T>) {
  const { t } = useLingui();
  const [visibleItems, setVisibleItems] = useState<PickerItem[] | null>(null);
  const open = useRef(false);
  const [opened, setOpened] = useState(false);
  useHiddenTabStops(opened);
  const updateVisibleItems = useCallback(
    (items: PickerItem[]) => {
      // Closing can flush a last visibility effect from the departing list
      if (!open.current) return;
      setVisibleItems((previous) =>
        previous?.length === items.length &&
        previous.every(
          (item, index) =>
            item.id === items[index]?.id &&
            item.group === items[index]?.group &&
            item.groupName === items[index]?.groupName,
        )
          ? previous
          : items,
      );
    },
    [setVisibleItems],
  );
  const { contains } = useFilter({ sensitivity: 'base' });
  const options = typeof children === 'function' ? null : selectItems(children);
  const pickerLabel =
    typeof label === 'string'
      ? label
      : (props['aria-label'] ?? t({ id: 'ui.select.placeholder', message: 'Choose…' }));
  const pickerId = listId;
  const visibleKeys = visibleItems == null ? null : new Set(visibleItems.map((item) => item.id));
  // Controlled items keep keyboard navigation on the same collection that the picker filters
  return (
    <AriaComboBox<object>
      defaultFilter={contains}
      {...props}
      items={options && options.length > 10 ? options : props.items}
      disabledKeys={
        options && options.length > 10 && visibleKeys
          ? new Set([
              ...(props.disabledKeys ?? []),
              ...options.filter((item) => !visibleKeys.has(item.id)).map((item) => item.key),
            ])
          : props.disabledKeys
      }
      onSelectionChange={(key) => {
        if (key != null && options && options.length > 10) rememberPickerItem(pickerId, String(key));
        onSelectionChange?.(key);
      }}
      onOpenChange={(isOpen, focusStrategy) => {
        open.current = isOpen;
        setOpened(isOpen);
        if (!isOpen) setVisibleItems(null);
        onOpenChange?.(isOpen, focusStrategy);
      }}
      allowsEmptyCollection={allowsEmptyCollection}
      className={cx('rio-combobox', className)}
      data-size={size}
    >
      {label == null ? null : <Label>{label}</Label>}
      <Group className="rio-combobox__group">
        <Input className="rio-combobox__input" placeholder={placeholder} />
        <TooltipTrigger>
          <AriaButton
            className="rio-combobox__trigger"
            aria-label={t({ id: 'ui.comboBox.showSuggestions', message: 'Show suggestions' })}
            data-tooltip={t({ id: 'ui.comboBox.showSuggestions', message: 'Show suggestions' })}
          >
            <Icon icon={faChevronDown} />
          </AriaButton>
          <Tooltip>{t({ id: 'ui.comboBox.showSuggestions', message: 'Show suggestions' })}</Tooltip>
        </TooltipTrigger>
      </Group>
      {description == null ? null : <Description>{description}</Description>}
      {errorMessage == null ? null : <FieldError>{errorMessage}</FieldError>}
      <ListPopover className={options && options.length > 10 ? 'rio-picker-popover' : undefined}>
        {options && options.length > 10 ? (
          <LongComboBoxOptions
            options={options}
            label={pickerLabel}
            listId={pickerId}
            visibleItems={visibleItems}
            onVisibleItemsChange={updateVisibleItems}
          />
        ) : (
          <ListBox
            size={size}
            renderEmptyState={
              renderEmptyState ??
              (() => (
                <div className="rio-combobox__empty">
                  {t({ id: 'ui.comboBox.empty', message: 'No matches' })}
                </div>
              ))
            }
          >
            {children}
          </ListBox>
        )}
      </ListPopover>
    </AriaComboBox>
  );
}
