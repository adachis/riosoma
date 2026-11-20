import { faCalendarDays, faListUl, faTableCells } from '@fortawesome/free-solid-svg-icons';
import { useState } from 'react';
import { SegmentedControl, type SegmentedControlItem, type SegmentedControlSize } from './SegmentedControl';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
const VIEWS: SegmentedControlItem[] = [
  { id: 'grid', label: 'Grid' },
  { id: 'list', label: 'List' },
  { id: 'calendar', label: 'Calendar' },
];

const ICON_VIEWS: SegmentedControlItem[] = [
  { id: 'grid', label: 'Grid', icon: faTableCells },
  { id: 'list', label: 'List', icon: faListUl },
  { id: 'calendar', label: 'Calendar', icon: faCalendarDays },
];

const LONG_VIEWS: SegmentedControlItem[] = [
  { id: 'open', label: 'Everything still open' },
  { id: 'week', label: 'Modified this week' },
  { id: 'mine', label: 'Mine' },
];

function ViewSwitch({
  items = VIEWS,
  size,
  label = 'View',
}: {
  items?: SegmentedControlItem[];
  size?: SegmentedControlSize;
  label?: string;
}) {
  const [selectedId, setSelectedId] = useState(items[0]?.id ?? '');
  return (
    <SegmentedControl
      items={items}
      size={size}
      label={label}
      selectedId={selectedId}
      onChange={setSelectedId}
    />
  );
}

export const gallery: GalleryEntry = {
  id: 'ui.segmented-control',
  title: 'SegmentedControl',
  examples: [
    {
      id: 'sizes',
      render: () => (
        <>
          <ViewSwitch size="sm" />
          <ViewSwitch />
        </>
      ),
    },
    {
      id: 'icons',
      render: () => (
        <>
          <ViewSwitch size="sm" items={ICON_VIEWS} />
          <ViewSwitch items={ICON_VIEWS} />
        </>
      ),
    },
    {
      id: 'long-labels',
      render: () => (
        <>
          {/* Equal widths, so the short label cannot take room from the long ones. */}
          <ViewSwitch items={LONG_VIEWS} label="Filter" />
        </>
      ),
    },
    {
      id: 'disabled',
      render: () => (
        <SegmentedControl items={VIEWS} label="View" selectedId="grid" onChange={() => {}} isDisabled />
      ),
    },
  ],
};
