import {
  faCopy,
  faFloppyDisk,
  faMagnifyingGlass,
  faPen,
  faRotateRight,
  faSliders,
  faTrashCan,
} from '@fortawesome/free-solid-svg-icons';
import { Button } from './Button';
import { Separator } from './Separator';
import { Toolbar } from './Toolbar';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.toolbar',
  title: 'Toolbar',
  examples: [
    {
      id: 'comfortable',
      render: () => (
        <Toolbar aria-label="Table actions">
          <Button icon={faPen}>Edit</Button>
          <Button icon={faCopy}>Duplicate</Button>
          <Separator orientation="vertical" />
          <Button icon={faRotateRight}>Refresh</Button>
          <Separator orientation="vertical" />
          <Button variant="danger" icon={faTrashCan}>
            Delete
          </Button>
        </Toolbar>
      ),
    },
    {
      id: 'compact',
      render: () => (
        <Toolbar aria-label="Row actions" density="compact">
          <Button size="sm" variant="quiet" icon={faPen} aria-label="Edit row" />
          <Button size="sm" variant="quiet" icon={faCopy} aria-label="Duplicate row" />
          <Separator orientation="vertical" />
          <Button size="sm" variant="quiet" icon={faTrashCan} aria-label="Delete row" />
        </Toolbar>
      ),
    },
    {
      id: 'vertical',
      render: () => (
        <Toolbar aria-label="View" orientation="vertical">
          <Button variant="quiet" icon={faSliders}>
            Group
          </Button>
          <Button variant="quiet" icon={faMagnifyingGlass}>
            Filter
          </Button>
          <Separator />
          <Button variant="quiet" icon={faRotateRight}>
            Reset view
          </Button>
        </Toolbar>
      ),
    },
    {
      id: 'states',
      render: () => (
        <Toolbar aria-label="Import">
          <Button variant="primary" isPending icon={faFloppyDisk}>
            Importing
          </Button>
          <Button isDisabled icon={faTrashCan}>
            Delete
          </Button>
        </Toolbar>
      ),
    },
  ],
};
