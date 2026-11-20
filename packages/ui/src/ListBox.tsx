import {
  Header as AriaHeader,
  ListBox as AriaListBox,
  ListBoxItem as AriaListBoxItem,
  ListBoxSection as AriaListBoxSection,
  type ListBoxItemProps as AriaListBoxItemProps,
  type ListBoxProps as AriaListBoxProps,
  type ListBoxSectionProps as AriaListBoxSectionProps,
} from 'react-aria-components';
import { faCheck } from '@fortawesome/free-solid-svg-icons';
import { Icon, type IconDefinition } from '@riosoma/icons';
import { cx } from './cx';
import './ListBox.css';

export interface ListBoxProps<T extends object> extends Omit<AriaListBoxProps<T>, 'className'> {
  /** Picker overlays accept the current choice so they can close without changing it. */
  allowDuplicateSelectionEvents?: boolean;
  /** Row density.  A Select or ComboBox passes its own size down, so the panel matches the field. */
  size?: 'sm' | 'md' | 'lg';
  ref?: React.Ref<HTMLDivElement>;
  className?: string;
}

/**
 * A list of options, on its own or inside a Select or ComboBox.  React Aria owns the selection
 * state; this wrapper only adds the frame and the item layout.
 */
export function ListBox<T extends object>({ size, className, ...props }: ListBoxProps<T>) {
  return <AriaListBox {...props} data-size={size} className={cx('rio-listbox', className)} />;
}

export interface ListBoxSectionProps<T extends object> extends Omit<
  AriaListBoxSectionProps<T>,
  'className' | 'children'
> {
  /** Section header.  The section is named by it, so assistive tech announces the group. */
  title?: React.ReactNode;
  className?: string;
  /** Static options, or a `Collection` for items built from data. */
  children?: React.ReactNode;
}

export function ListBoxSection<T extends object>({
  title,
  className,
  children,
  ...props
}: ListBoxSectionProps<T>) {
  return (
    <AriaListBoxSection {...props} className={cx('rio-listbox-section', className)}>
      {title == null ? null : <AriaHeader className="rio-listbox-section__header">{title}</AriaHeader>}
      {children}
    </AriaListBoxSection>
  );
}

export interface ListBoxItemProps extends Omit<AriaListBoxItemProps, 'className' | 'style' | 'children'> {
  /** Leading icon; decorative, since the label names the option. */
  icon?: IconDefinition;
  group?: string;
  groupName?: string;
  /** Second line under the label. */
  description?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

/**
 * One option.  The selection indicator always occupies its column in a selectable list, so
 * checking an option changes colors only and never shifts the label.
 */
export function ListBoxItem({
  icon,
  description,
  className,
  children,
  group: _group,
  groupName: _groupName,
  ...props
}: ListBoxItemProps) {
  // The item's markup holds more than its label, so a plain-text label doubles as the text value
  // that typeahead and screen readers fall back to.
  const textValue = props.textValue ?? (typeof children === 'string' ? children : undefined);
  return (
    <AriaListBoxItem {...props} textValue={textValue} className={cx('rio-listbox-item', className)}>
      {(item) => (
        <>
          {item.selectionMode === 'none' ? null : (
            <span className="rio-listbox-item__indicator" aria-hidden="true">
              <Icon icon={faCheck} className="rio-listbox-item__check" />
            </span>
          )}
          {icon ? <Icon icon={icon} className="rio-listbox-item__icon" /> : null}
          <span className="rio-listbox-item__text">
            <span className="rio-listbox-item__label">{children}</span>
            {description == null ? null : (
              <span className="rio-listbox-item__description">{description}</span>
            )}
          </span>
        </>
      )}
    </AriaListBoxItem>
  );
}
