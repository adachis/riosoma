import { faFloppyDisk, faPlus, faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { Button } from './Button';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.button',
  title: 'Button',
  examples: [
    {
      id: 'variants',
      render: () => (
        <>
          <Button variant="primary">Save</Button>
          <Button>Cancel</Button>
          <Button variant="quiet">More</Button>
          <Button variant="danger" icon={faTrashCan}>
            Delete
          </Button>
        </>
      ),
    },
    {
      id: 'sizes',
      render: () => (
        <>
          <Button size="sm" icon={faPlus}>
            Add
          </Button>
          <Button icon={faPlus}>Add</Button>
          <Button size="lg" icon={faPlus}>
            Add
          </Button>
        </>
      ),
    },
    {
      id: 'states',
      render: () => (
        <>
          <Button variant="primary" isPending icon={faFloppyDisk}>
            Saving
          </Button>
          <Button isDisabled>Unavailable</Button>
        </>
      ),
    },
  ],
};
