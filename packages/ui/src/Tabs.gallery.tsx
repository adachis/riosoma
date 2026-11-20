import { faDatabase, faKey, faSliders, faTable } from '@fortawesome/free-solid-svg-icons';
import { Tab, TabList, TabPanel, Tabs } from './Tabs';
import { Text } from './Text';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.tabs',
  title: 'Tabs',
  examples: [
    {
      id: 'horizontal',
      render: () => (
        <Tabs defaultSelectedKey="tables">
          <TabList aria-label="Database sections">
            <Tab id="tables" icon={faTable}>
              Tables
            </Tab>
            <Tab id="keys" icon={faKey}>
              Keys
            </Tab>
            <Tab id="settings" icon={faSliders}>
              Settings
            </Tab>
          </TabList>
          <TabPanel id="tables">
            <Text>Every table in this database, with row counts and sizes.</Text>
          </TabPanel>
          <TabPanel id="keys">
            <Text>Every key in this database, with the ranges they cover.</Text>
          </TabPanel>
          <TabPanel id="settings">
            <Text>Storage and replication settings for this database.</Text>
          </TabPanel>
        </Tabs>
      ),
    },
    {
      id: 'vertical',
      render: () => (
        <Tabs orientation="vertical" defaultSelectedKey="general">
          <TabList aria-label="Settings sections">
            <Tab id="general" icon={faDatabase}>
              General
            </Tab>
            <Tab id="keys" icon={faKey}>
              Keys
            </Tab>
            <Tab id="advanced" icon={faSliders}>
              Advanced
            </Tab>
          </TabList>
          <TabPanel id="general">
            <Text>Name, region, and the storage class of this database.</Text>
          </TabPanel>
          <TabPanel id="keys">
            <Text>Rotate the keys this database encrypts its data with.</Text>
          </TabPanel>
          <TabPanel id="advanced">
            <Text>Compaction, cache, and replication tuning.</Text>
          </TabPanel>
        </Tabs>
      ),
    },
    {
      id: 'without-icons',
      render: () => (
        <Tabs defaultSelectedKey="overview">
          <TabList aria-label="Monitoring sections">
            <Tab id="overview">Overview</Tab>
            <Tab id="queries">Queries</Tab>
            <Tab id="storage">Storage</Tab>
          </TabList>
          <TabPanel id="overview">
            <Text>Live throughput and latency for this database.</Text>
          </TabPanel>
          <TabPanel id="queries">
            <Text>The slowest queries over the last hour.</Text>
          </TabPanel>
          <TabPanel id="storage">
            <Text>Disk use, growth, and the next compaction.</Text>
          </TabPanel>
        </Tabs>
      ),
    },
    {
      id: 'states',
      render: () => (
        <Tabs defaultSelectedKey="tables" keyboardActivation="manual">
          <TabList aria-label="Sections with a disabled tab">
            <Tab id="tables" icon={faTable}>
              Tables
            </Tab>
            <Tab id="replicas" isDisabled icon={faDatabase}>
              Replicas
            </Tab>
            <Tab id="keys" icon={faKey}>
              Keys
            </Tab>
          </TabList>
          <TabPanel id="tables">
            <Text>Manual activation: arrows move the focus, Enter selects.</Text>
          </TabPanel>
          <TabPanel id="keys">
            <Text>Keys are listed here.</Text>
          </TabPanel>
        </Tabs>
      ),
    },
  ],
};
