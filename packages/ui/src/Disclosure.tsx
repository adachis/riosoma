import {
  Disclosure as AriaDisclosure,
  DisclosureGroup as AriaDisclosureGroup,
  DisclosurePanel as AriaDisclosurePanel,
  type DisclosureGroupProps as AriaDisclosureGroupProps,
  type DisclosurePanelProps as AriaDisclosurePanelProps,
  type DisclosureProps as AriaDisclosureProps,
} from 'react-aria-components';
import { faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { Icon } from '@riosoma/icons';
import { Button, type ButtonProps } from './Button';
import { Heading, type HeadingLevel } from './Heading';
import { cx } from './cx';
import './Disclosure.css';

export interface DisclosureProps extends Omit<AriaDisclosureProps, 'className' | 'children'> {
  className?: string;
  children?: React.ReactNode;
}

/**
 * A collapsible section: a trigger, a panel, and the state that ties them together.  Settings that
 * most people never touch live in one of these, so the screen stays short without hiding anything.
 */
export function Disclosure({ className, ...props }: DisclosureProps) {
  return <AriaDisclosure {...props} className={cx('rio-disclosure', className)} />;
}

export interface DisclosureTriggerProps extends Omit<ButtonProps, 'children' | 'variant'> {
  /** The heading level the trigger sits in; a settings screen usually wants a third level. */
  level?: HeadingLevel;
  className?: string;
  children?: React.ReactNode;
}

/**
 * The header of a disclosure: a heading around a full-width button, so the section shows up in the
 * heading outline and the whole row is one target.  The chevron points along the block axis once
 * the section is open and mirrors itself in a right-to-left language.
 */
export function DisclosureTrigger({ level = 3, className, children, ...props }: DisclosureTriggerProps) {
  return (
    <Heading level={level} className="rio-disclosure__heading">
      <Button {...props} slot="trigger" variant="quiet" className={cx('rio-disclosure__trigger', className)}>
        {children}
        <Icon icon={faChevronRight} className="rio-disclosure__chevron" />
      </Button>
    </Heading>
  );
}

export interface DisclosurePanelProps extends Omit<AriaDisclosurePanelProps, 'className'> {
  className?: string;
}

/**
 * The section's content.  It leaves the accessibility tree while collapsed and is taken out of the
 * layout, so nothing in it can be reached by mistake.
 */
export function DisclosurePanel({ className, ...props }: DisclosurePanelProps) {
  return <AriaDisclosurePanel {...props} className={cx('rio-disclosure__panel', className)} />;
}

export interface DisclosureGroupProps extends Omit<AriaDisclosureGroupProps, 'className' | 'children'> {
  className?: string;
  children?: React.ReactNode;
}

/**
 * A stack of disclosures that share one expanded state, so `allowsMultipleExpanded={false}` gives an
 * accordion where opening one section closes the others.
 */
export function DisclosureGroup({ className, ...props }: DisclosureGroupProps) {
  return <AriaDisclosureGroup {...props} className={cx('rio-disclosure-group', className)} />;
}
