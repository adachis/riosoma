import { faCopy, faPen, faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { Button } from './Button';
import { Separator } from './Separator';
import { Text } from './Text';
import { Toolbar } from './Toolbar';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.separator',
  title: 'Separator',
  examples: [
    {
      id: 'horizontal',
      render: () => (
        <div>
          <Text>Primary in eu-west-1</Text>
          <Separator />
          <Text variant="muted">Two replicas follow it.</Text>
        </div>
      ),
    },
    {
      id: 'vertical',
      render: () => (
        <Toolbar aria-label="Row actions">
          <Button variant="quiet" icon={faPen}>
            Edit
          </Button>
          <Button variant="quiet" icon={faCopy}>
            Duplicate
          </Button>
          <Separator orientation="vertical" />
          <Button variant="danger" icon={faTrashCan}>
            Delete
          </Button>
        </Toolbar>
      ),
    },
  ],
};
