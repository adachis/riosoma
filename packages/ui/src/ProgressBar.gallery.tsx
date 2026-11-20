import { ProgressBar } from './ProgressBar';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.progress-bar',
  title: 'ProgressBar',
  examples: [
    {
      id: 'determinate',
      render: () => (
        <>
          <ProgressBar label="Waiting for a worker" value={0} />
          <ProgressBar label="Uploading dump" value={35} />
          <ProgressBar label="Restoring" value={40} valueLabel="4 of 10 files" />
          <ProgressBar label="Compacting" value={100} />
        </>
      ),
    },
    {
      id: 'indeterminate',
      render: () => (
        <>
          <ProgressBar label="Connecting" isIndeterminate />
          <ProgressBar aria-label="Rebuilding index" isIndeterminate />
        </>
      ),
    },
    {
      id: 'shapes',
      render: () => (
        <>
          <ProgressBar aria-label="Copying rows" value={62} />
          <ProgressBar valueLabel="620 of 1000 rows" value={62} minValue={0} maxValue={1000} />
          <ProgressBar
            label="Vacuuming"
            value={3}
            minValue={0}
            maxValue={8}
            formatOptions={{ style: 'decimal' }}
          />
        </>
      ),
    },
  ],
};
