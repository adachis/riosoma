import {
  SelectionIndicator,
  Tab as AriaTab,
  TabList as AriaTabList,
  TabPanel as AriaTabPanel,
  Tabs as AriaTabs,
  type TabListProps as AriaTabListProps,
  type TabPanelProps as AriaTabPanelProps,
  type TabProps as AriaTabProps,
  type TabsProps as AriaTabsProps,
} from 'react-aria-components';
import { Icon, type IconDefinition } from '@riosoma/icons';
import { cx } from './cx';
import './Tabs.css';

export interface TabsProps extends Omit<AriaTabsProps, 'className' | 'children'> {
  className?: string;
  children?: React.ReactNode;
}

/**
 * Groups a tab list and its panels.  React Aria sets `data-orientation` on the root, so the whole
 * group flips between a stacked and a side-by-side layout from one prop.
 */
export function Tabs({ className, ...props }: TabsProps) {
  return <AriaTabs {...props} className={cx('rio-tabs', className)} />;
}

export interface TabListProps<T extends object> extends Omit<AriaTabListProps<T>, 'className'> {
  className?: string;
}

/** The row or column of tabs.  Arrow keys move between tabs and select them. */
export function TabList<T extends object>({ className, ...props }: TabListProps<T>) {
  return <AriaTabList<T> {...props} className={cx('rio-tab-list', className)} />;
}

export interface TabProps extends Omit<AriaTabProps, 'className' | 'children'> {
  /** Leading icon; decorative, since the tab's label names it. */
  icon?: IconDefinition;
  className?: string;
  children?: React.ReactNode;
}

/**
 * A single tab.  The underline is a `SelectionIndicator`, which React Aria animates from the tab
 * that lost the selection to the tab that gained it, so the bar travels instead of blinking.
 * Nothing here changes size between states: the bar is taken out of flow and the label keeps its
 * weight when selected.
 */
export function Tab({ icon, className, children, ...props }: TabProps) {
  return (
    <AriaTab {...props} className={cx('rio-tab', className)}>
      <SelectionIndicator className="rio-tab__indicator" />
      <span className="rio-tab__content">
        {icon ? <Icon icon={icon} /> : null}
        {children}
      </span>
    </AriaTab>
  );
}

export interface TabPanelProps extends Omit<AriaTabPanelProps, 'className' | 'children'> {
  className?: string;
  children?: React.ReactNode;
}

/** The panel for the selected tab; panels that are not selected stay out of the DOM. */
export function TabPanel({ className, ...props }: TabPanelProps) {
  return <AriaTabPanel {...props} className={cx('rio-tab-panel', className)} />;
}
