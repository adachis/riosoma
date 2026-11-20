import { DialogTrigger, type Placement } from 'react-aria-components';
import { Button } from './Button';
import { Popover } from './Popover';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
function PopoverDemo({ label, placement, arrow }: { label: string; placement?: Placement; arrow?: boolean }) {
  return (
    <DialogTrigger>
      <Button>{label}</Button>
      <Popover placement={placement} arrow={arrow} aria-label={label}>
        <p>Filters apply to this connection only.</p>
        <Button size="sm">Apply</Button>
      </Popover>
    </DialogTrigger>
  );
}

/** Long text wraps inside the surface's cap instead of stretching it across the screen. */
function LongPopoverDemo() {
  return (
    <DialogTrigger>
      <Button>Last error</Button>
      <Popover placement="bottom start" arrow aria-label="Last error">
        <p>
          The query planner gave up on this join because the right side has no index on the column it filters
          by, and reading all 4.2 million rows to find the eleven that match would take longer than the
          connection is willing to wait.
        </p>
      </Popover>
    </DialogTrigger>
  );
}

export const gallery: GalleryEntry = {
  id: 'ui.popover',
  title: 'Popover',
  examples: [
    {
      id: 'placements',
      render: () => (
        <>
          <PopoverDemo label="Below" placement="bottom" />
          <PopoverDemo label="Above" placement="top" />
          <PopoverDemo label="Left" placement="left" />
          <PopoverDemo label="Right" placement="right" />
        </>
      ),
    },
    {
      id: 'arrow',
      render: () => (
        <>
          <PopoverDemo label="With an arrow" placement="bottom" arrow />
          <PopoverDemo label="Without one" placement="bottom" />
        </>
      ),
    },
    {
      id: 'long-content',
      render: () => <LongPopoverDemo />,
    },
  ],
};
