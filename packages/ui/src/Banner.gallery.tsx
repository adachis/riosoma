import { Banner } from './Banner';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.banner',
  title: 'Banner',
  examples: [
    {
      id: 'tones',
      render: () => (
        <>
          <Banner tone="info" title="Nightly backup moved">
            Backups now start at 02:00 local time.
          </Banner>
          <Banner tone="success" title="Restore finished">
            Every table is back online.
          </Banner>
          <Banner tone="warning" title="Disk almost full">
            92% of the data volume is used. Free space to keep writes flowing.
          </Banner>
          <Banner tone="danger" title="Replication stopped">
            The replica is 4 hours behind the primary.
          </Banner>
        </>
      ),
    },
    {
      id: 'dismissible',
      render: () => (
        <>
          <Banner tone="info" title="Maintenance window" onDismiss={() => undefined}>
            Sunday, 03:00 to 04:00.
          </Banner>
          <Banner tone="danger" title="License expired" onDismiss={() => undefined}>
            Renew to restore write access.
          </Banner>
        </>
      ),
    },
    {
      id: 'shapes',
      render: () => (
        <>
          <Banner tone="warning">The connection pool was resized to 200.</Banner>
          <Banner tone="success" title="Index built" icon={null}>
            No icon, title only above the body.
          </Banner>
          <Banner tone="info" title="A very long notice">
            Riosoma keeps a write-ahead log for every change, so a replica that falls behind can catch up
            without a full copy. When the lag passes an hour, this notice explains what happened, what the
            platform is doing about it, and what an operator can do next.
          </Banner>
        </>
      ),
    },
  ],
};
