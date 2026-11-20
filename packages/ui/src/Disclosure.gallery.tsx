import { faKey, faSliders, faTable } from '@fortawesome/free-solid-svg-icons';
import { Disclosure, DisclosureGroup, DisclosurePanel, DisclosureTrigger } from './Disclosure';
import { Text } from './Text';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.disclosure',
  title: 'Disclosure',
  examples: [
    {
      id: 'closed',
      render: () => (
        <Disclosure>
          <DisclosureTrigger icon={faSliders}>Advanced settings</DisclosureTrigger>
          <DisclosurePanel>
            <Text variant="muted">Compaction, cache, and replication tuning.</Text>
          </DisclosurePanel>
        </Disclosure>
      ),
    },
    {
      id: 'open',
      render: () => (
        <Disclosure defaultExpanded>
          <DisclosureTrigger icon={faTable}>Storage</DisclosureTrigger>
          <DisclosurePanel>
            <Text>120 GiB used of 500 GiB.</Text>
            <Text variant="small">The next compaction is scheduled for 03:00 UTC.</Text>
          </DisclosurePanel>
        </Disclosure>
      ),
    },
    {
      id: 'accordion',
      render: () => (
        <DisclosureGroup defaultExpandedKeys={['replication']}>
          <Disclosure id="storage">
            <DisclosureTrigger icon={faTable}>Storage</DisclosureTrigger>
            <DisclosurePanel>
              <Text>120 GiB used of 500 GiB.</Text>
            </DisclosurePanel>
          </Disclosure>
          <Disclosure id="replication">
            <DisclosureTrigger>Replication</DisclosureTrigger>
            <DisclosurePanel>
              <Text>Two replicas follow the primary, one in each region.</Text>
            </DisclosurePanel>
          </Disclosure>
          <Disclosure id="keys">
            <DisclosureTrigger icon={faKey}>Encryption keys</DisclosureTrigger>
            <DisclosurePanel>
              <Text variant="mono">key/primary/2026-09</Text>
            </DisclosurePanel>
          </Disclosure>
        </DisclosureGroup>
      ),
    },
    {
      id: 'multiple',
      render: () => (
        <DisclosureGroup allowsMultipleExpanded defaultExpandedKeys={['storage', 'keys']}>
          <Disclosure id="storage">
            <DisclosureTrigger>Storage</DisclosureTrigger>
            <DisclosurePanel>
              <Text>120 GiB used of 500 GiB.</Text>
            </DisclosurePanel>
          </Disclosure>
          <Disclosure id="keys">
            <DisclosureTrigger>Encryption keys</DisclosureTrigger>
            <DisclosurePanel>
              <Text variant="mono">key/primary/2026-09</Text>
            </DisclosurePanel>
          </Disclosure>
        </DisclosureGroup>
      ),
    },
    {
      id: 'states',
      render: () => (
        <>
          <Disclosure isDisabled>
            <DisclosureTrigger icon={faSliders}>Advanced settings</DisclosureTrigger>
            <DisclosurePanel>
              <Text>Unavailable while this database is restoring.</Text>
            </DisclosurePanel>
          </Disclosure>
          <Disclosure defaultExpanded>
            <DisclosureTrigger level={4}>Quotas</DisclosureTrigger>
            <DisclosurePanel>
              <Text variant="small">A trigger at a fourth heading level, already open.</Text>
            </DisclosurePanel>
          </Disclosure>
        </>
      ),
    },
  ],
};
