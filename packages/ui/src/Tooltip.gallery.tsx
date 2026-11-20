import { faRotateRight, faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { Button } from './Button';
import { Tooltip, TooltipTrigger } from './Tooltip';
import type { GalleryEntry } from './gallery';

/*
 * Gallery examples are a developer tool, so their sample labels are plain text.  The first two
 * examples hold their tooltips open: a gallery is read in every theme at a glance, and a tooltip
 * only exists while it is open.  The last example is live, so the timing can be felt.
 */
export const gallery: GalleryEntry = {
  id: 'ui.tooltip',
  title: 'Tooltip',
  examples: [
    {
      id: 'placements',
      render: () => (
        <>
          <TooltipTrigger isOpen>
            <Button>Top</Button>
            <Tooltip>Appears above the control</Tooltip>
          </TooltipTrigger>
          <TooltipTrigger isOpen>
            <Button>Bottom</Button>
            <Tooltip placement="bottom">Appears below the control</Tooltip>
          </TooltipTrigger>
          <TooltipTrigger isOpen>
            <Button>Start</Button>
            <Tooltip placement="start">Appears before the control in the reading direction</Tooltip>
          </TooltipTrigger>
          <TooltipTrigger isOpen>
            <Button>End</Button>
            <Tooltip placement="end">Appears after the control</Tooltip>
          </TooltipTrigger>
        </>
      ),
    },
    {
      id: 'icon-only-controls',
      render: () => (
        <>
          <TooltipTrigger isOpen>
            <Button variant="quiet" icon={faRotateRight} aria-label="Retry" />
            <Tooltip>Run the query again</Tooltip>
          </TooltipTrigger>
          <TooltipTrigger isOpen>
            <Button variant="danger" icon={faTrashCan} aria-label="Delete" />
            <Tooltip>Drop the table and everything in it</Tooltip>
          </TooltipTrigger>
        </>
      ),
    },
    {
      id: 'behaviors',
      render: () => (
        <>
          <TooltipTrigger>
            <Button>Default delay</Button>
            <Tooltip>Appears after 600 milliseconds of hover or at once on focus</Tooltip>
          </TooltipTrigger>
          <TooltipTrigger delay={0}>
            <Button>Immediate</Button>
            <Tooltip>Appears as soon as the pointer arrives</Tooltip>
          </TooltipTrigger>
          <TooltipTrigger trigger="focus">
            <Button>Focus only</Button>
            <Tooltip>Opens on focus and never on hover</Tooltip>
          </TooltipTrigger>
          <TooltipTrigger isDisabled>
            <Button>No tooltip</Button>
            <Tooltip>Never shows</Tooltip>
          </TooltipTrigger>
        </>
      ),
    },
  ],
};
