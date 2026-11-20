import { Heading } from './Heading';
import { Text } from './Text';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.heading',
  title: 'Heading',
  examples: [
    {
      id: 'levels',
      render: () => (
        <>
          <Heading level={1}>Riosoma</Heading>
          <Heading level={2}>Databases</Heading>
          <Heading level={3}>orders</Heading>
          <Heading level={4}>Columns</Heading>
        </>
      ),
    },
    {
      id: 'in-context',
      render: () => (
        <section>
          <Heading level={2}>Replication</Heading>
          <Text>Two replicas follow the primary, one in each region.</Text>
          <Heading level={3}>Lag</Heading>
          <Text variant="muted">Measured over the last five minutes.</Text>
          <Heading level={4}>Per replica</Heading>
          <Text variant="mono">replica-eu-west-1a</Text>
        </section>
      ),
    },
  ],
};
