import { Button } from './Button';
import { Spinner } from './Spinner';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.spinner',
  title: 'Spinner',
  examples: [
    {
      id: 'sizes',
      render: () => (
        <>
          <Spinner size="sm" />
          <Spinner />
          <Spinner size="lg" />
        </>
      ),
    },
    {
      id: 'labels',
      render: () => (
        <>
          <Spinner />
          <Spinner label="Restoring backup" />
        </>
      ),
    },
    {
      id: 'in-context',
      render: () => (
        <>
          <span>
            Running query <Spinner size="sm" label="Running query" />
          </span>
          <Button isPending>Save</Button>
        </>
      ),
    },
  ],
};
