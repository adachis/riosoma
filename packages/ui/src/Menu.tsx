import {
  Header as AriaHeader,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuSection as AriaMenuSection,
  Separator as AriaSeparator,
  SubmenuTrigger as AriaSubmenuTrigger,
  Collection,
  RootMenuTriggerStateContext,
  type MenuItemProps as AriaMenuItemProps,
  type MenuProps as AriaMenuProps,
  type MenuSectionProps as AriaMenuSectionProps,
  type SeparatorProps as AriaSeparatorProps,
} from 'react-aria-components';
import { faArrowDown, faArrowUp, faArrowRight, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { Icon, type IconDefinition } from '@riosoma/icons';
import { useContext, type RefObject } from 'react';
import { SortableItemMenuContext } from './sortable-item-menu';
import { ListPopover } from './ListPopover';
import { cx } from './cx';
import './Menu.css';

// The trigger only supplies context, so React Aria's own component is the right one to use.
export { MenuTrigger, type MenuTriggerProps } from 'react-aria-components';

export interface MenuProps<T extends object> extends Omit<AriaMenuProps<T>, 'className'> {
  /**
   * Opens the panel without a modal underlay.  Use it where the menu sits inside something that is
   * already modal, or where a panel must stay open next to the rest of the page.
   */
  isNonModal?: boolean;
  triggerRef?: RefObject<HTMLElement | null>;
  /** Standalone triggers can keep their button mounted while the menu code loads. */
  isOpen?: boolean;
  onOpenChange?(open: boolean): void;
  className?: string;
  includeSortableActions?: boolean;
}

/**
 * A list of actions in its own overlay panel.  The panel belongs to the menu, so a caller only
 * composes a trigger and the items:
 *
 * ```tsx
 * <MenuTrigger>
 *   <Button>Actions</Button>
 *   <Menu aria-label="Actions">…</Menu>
 * </MenuTrigger>
 * ```
 */
export function Menu<T extends object>({
  className,
  children,
  isNonModal,
  triggerRef,
  isOpen,
  onOpenChange,
  includeSortableActions = true,
  ...props
}: MenuProps<T>) {
  const sortable = useContext(SortableItemMenuContext);
  const trigger = useContext(RootMenuTriggerStateContext);
  const sortableOpen = includeSortableActions && (isOpen ?? trigger?.isOpen ?? true);
  return (
    <ListPopover
      isNonModal={isNonModal ?? (isOpen === undefined ? undefined : true)}
      triggerRef={triggerRef}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      trigger={isOpen === undefined ? undefined : 'MenuTrigger'}
    >
      <AriaMenu {...props} items={undefined} className={cx('rio-menu', className)}>
        {typeof children === 'function' ? <Collection items={props.items}>{children}</Collection> : children}
        {sortable && sortableOpen ? (
          <>
            <MenuItem
              id="$sort-up"
              icon={faArrowUp}
              isDisabled={!sortable.canMove('up')}
              onAction={() => sortable.move('up')}
            >
              {sortable.labels.up}
            </MenuItem>
            <MenuItem
              id="$sort-down"
              icon={faArrowDown}
              isDisabled={!sortable.canMove('down')}
              onAction={() => sortable.move('down')}
            >
              {sortable.labels.down}
            </MenuItem>
            <SubmenuTrigger
              label={sortable.labels.to}
              icon={faArrowRight}
              isDisabled={
                !sortable.destinations.some((destination) => sortable.canMove(destination.location))
              }
            >
              {sortable.destinations.map((destination) => (
                <MenuItem
                  key={destination.id}
                  id={destination.id}
                  isDisabled={!sortable.canMove(destination.location)}
                  onAction={() => sortable.move(destination.location)}
                >
                  {destination.name}
                </MenuItem>
              ))}
            </SubmenuTrigger>
          </>
        ) : null}
      </AriaMenu>
    </ListPopover>
  );
}

export interface MenuItemProps extends Omit<AriaMenuItemProps, 'className' | 'style' | 'children'> {
  /** Leading icon; decorative, since the label names the item. */
  icon?: IconDefinition;
  /** Second line under the label. */
  description?: React.ReactNode;
  /** Keyboard shortcut, shown at the inline end and announced with the item. */
  shortcut?: React.ReactNode;
  /** `danger` colors the item for destructive actions. */
  tone?: 'default' | 'danger';
  className?: string;
  children?: React.ReactNode;
}

/**
 * One action.  The chevron of a submenu trigger mirrors in right-to-left, because it points the
 * way the submenu opens.
 */
export function MenuItem({
  icon,
  description,
  shortcut,
  tone = 'default',
  className,
  children,
  ...props
}: MenuItemProps) {
  // The item's markup holds more than its label, so a plain-text label doubles as the text value
  // that typeahead and screen readers fall back to.
  const textValue = props.textValue ?? (typeof children === 'string' ? children : undefined);
  return (
    <AriaMenuItem
      {...props}
      textValue={textValue}
      className={cx('rio-menu-item', className)}
      data-tone={tone}
    >
      {(item) => (
        <>
          {icon ? <Icon icon={icon} className="rio-menu-item__icon" /> : null}
          <span className="rio-menu-item__text">
            <span className="rio-menu-item__label">{children}</span>
            {description == null ? null : <span className="rio-menu-item__description">{description}</span>}
          </span>
          {shortcut == null ? null : <kbd className="rio-menu-item__shortcut">{shortcut}</kbd>}
          {item.hasSubmenu ? <Icon icon={faChevronRight} className="rio-menu-item__chevron" /> : null}
        </>
      )}
    </AriaMenuItem>
  );
}

export interface MenuSectionProps<T extends object> extends Omit<
  AriaMenuSectionProps<T>,
  'className' | 'children'
> {
  /** Section header.  The section is named by it, so assistive tech announces the group. */
  title?: React.ReactNode;
  className?: string;
  /** Static items, or a `Collection` for items built from data. */
  children?: React.ReactNode;
}

export function MenuSection<T extends object>({ title, className, children, ...props }: MenuSectionProps<T>) {
  return (
    <AriaMenuSection {...props} className={cx('rio-menu-section', className)}>
      {title == null ? null : <AriaHeader className="rio-menu-section__header">{title}</AriaHeader>}
      {children}
    </AriaMenuSection>
  );
}

export interface MenuSeparatorProps extends Omit<AriaSeparatorProps, 'className'> {
  className?: string;
}

/** The divider between groups of actions. */
export function MenuSeparator({ className, ...props }: MenuSeparatorProps) {
  return <AriaSeparator {...props} className={cx('rio-menu-separator', className)} />;
}

export interface SubmenuTriggerProps extends Omit<MenuItemProps, 'children'> {
  /** Text of the item that opens the submenu. */
  label: React.ReactNode;
  /** Milliseconds of hovering before the submenu opens.  React Aria's default is 200. */
  delay?: number;
  /** The submenu's own items. */
  children?: React.ReactNode;
}

/**
 * An item that opens a nested menu.  The nested menu is named after this item, so it needs no
 * label of its own.
 */
export function SubmenuTrigger({ label, delay, children, ...itemProps }: SubmenuTriggerProps) {
  return (
    <AriaSubmenuTrigger delay={delay}>
      <MenuItem {...itemProps}>{label}</MenuItem>
      <Menu includeSortableActions={false}>{children}</Menu>
    </AriaSubmenuTrigger>
  );
}
