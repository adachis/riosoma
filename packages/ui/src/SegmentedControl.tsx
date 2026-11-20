import { Icon, type IconDefinition } from '@riosoma/icons';
import {
  ToggleButton,
  ToggleButtonGroup,
  type ToggleButtonGroupProps as AriaToggleButtonGroupProps,
} from 'react-aria-components';
import { cx } from './cx';
import './SegmentedControl.css';

/** One segment of the control.  The label is already translated by the caller. */
export interface SegmentedControlItem {
  id: string;
  label: string;
  /** Leading icon; decorative, since the label names the segment. */
  icon?: IconDefinition;
}

/** `sm` is the size for a dense toolbar, `md` the size for everywhere else. */
export type SegmentedControlSize = 'sm' | 'md';

export interface SegmentedControlProps extends Omit<
  AriaToggleButtonGroupProps,
  | 'className'
  | 'style'
  | 'children'
  | 'orientation'
  | 'selectionMode'
  | 'disallowEmptySelection'
  | 'selectedKeys'
  | 'defaultSelectedKeys'
  | 'onSelectionChange'
  | 'aria-label'
  | 'aria-labelledby'
> {
  items: SegmentedControlItem[];
  /** The id of the chosen segment.  One is always chosen. */
  selectedId: string;
  onChange: (id: string) => void;
  /** The group's name for assistive technology.  Nothing is drawn for it. */
  label: string;
  size?: SegmentedControlSize;
  className?: string;
}

/**
 * A row of segments where exactly one is chosen, for the few views a screen offers.  React Aria
 * gives a single-selection group radio semantics, so the arrow keys both move the focus and choose,
 * the group is one tab stop, and a segment that is already chosen stays chosen: there is no empty
 * state to get back out of.  The segments share their width, which is also what keeps a label from
 * moving its neighbors when the chosen one turns bold.
 */
export function SegmentedControl({
  items,
  selectedId,
  onChange,
  label,
  size = 'md',
  className,
  ...rest
}: SegmentedControlProps) {
  // The tab stop follows the selection; while the caller's id matches no segment, the first one
  // stands in, so the group can always be reached and focusing it settles the choice.
  const tabbableId = items.some((item) => item.id === selectedId) ? selectedId : items[0]?.id;
  return (
    <ToggleButtonGroup
      {...rest}
      className={cx('rio-segmented-control', className)}
      data-size={size}
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[selectedId]}
      onSelectionChange={(keys) => {
        for (const key of keys) {
          // Pressing the chosen segment again reports it unchanged, and there is nothing to do.
          if (typeof key === 'string' && key !== selectedId) onChange(key);
        }
      }}
    >
      {items.map((item) => (
        <ToggleButton
          key={item.id}
          id={item.id}
          className="rio-segmented-control__segment"
          excludeFromTabOrder={item.id !== tabbableId}
          // React Aria moves the focus with the arrow keys but leaves the selection alone; a radio
          // group chooses as it moves, so the segment the focus lands on becomes the chosen one.
          onFocus={() => {
            if (item.id !== selectedId) onChange(item.id);
          }}
        >
          <span className="rio-segmented-control__content">
            {item.icon == null ? null : <Icon icon={item.icon} />}
            <span className="rio-segmented-control__label">{item.label}</span>
          </span>
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
