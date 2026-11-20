import { Text } from './Text';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.text',
  title: 'Text',
  examples: [
    {
      id: 'variants',
      render: () => (
        <>
          <Text>Riosoma is a self-hosted database platform.</Text>
          <Text variant="muted">Two replicas follow the primary.</Text>
          <Text variant="small">Last compacted 4 minutes ago.</Text>
          <Text variant="mono">SELECT count(*) FROM orders;</Text>
        </>
      ),
    },
    {
      id: 'elements',
      render: () => (
        <>
          <Text elementType="p">
            A paragraph: every range in this database is stored on disk exactly once, and replicas stream the
            log rather than the files.
          </Text>
          <Text elementType="code" variant="mono">
            rio admin compact --database orders
          </Text>
        </>
      ),
    },
    {
      id: 'long-identifier',
      render: () => (
        <Text variant="mono">
          replica_eu_west_1a_shard_0000000000000042_partition_7_of_16_snapshot_2026_09_27
        </Text>
      ),
    },
  ],
};
