import { faCircleInfo, faDatabase } from '@fortawesome/free-solid-svg-icons';
import { Link } from './Link';
import { Text } from './Text';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.link',
  title: 'Link',
  examples: [
    {
      id: 'plain',
      render: () => (
        <Text>
          Read the <Link href="/docs/replication">replication guide</Link> before adding a replica.
        </Text>
      ),
    },
    {
      id: 'with-icon',
      render: () => (
        <>
          <Link href="/databases/orders" icon={faDatabase}>
            orders
          </Link>
          <Link href="/status" icon={faCircleInfo}>
            Cluster status
          </Link>
        </>
      ),
    },
    {
      id: 'external',
      render: () => (
        <>
          <Link href="https://riosoma.dev/docs" external>
            Documentation
          </Link>
          <Link href="https://riosoma.dev/community" external target="_blank" rel="nofollow">
            Community
          </Link>
        </>
      ),
    },
    {
      id: 'states',
      render: () => (
        <>
          <Link href="/databases" aria-current="page">
            Databases
          </Link>
          <Link href="/databases/orders" isDisabled>
            Orders
          </Link>
        </>
      ),
    },
  ],
};
