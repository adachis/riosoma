import { ListBoxItem, ListBoxSection } from './ListBox';
import { Select } from './Select';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
const sizes = (
  <>
    <ListBoxItem id="name">Name</ListBoxItem>
    <ListBoxItem id="created">Date created</ListBoxItem>
    <ListBoxItem id="rows">Row count</ListBoxItem>
  </>
);

export const gallery: GalleryEntry = {
  id: 'ui.select',
  title: 'Select',
  examples: [
    {
      id: 'placeholder',
      render: () => <Select label="Sort by">{sizes}</Select>,
    },
    {
      id: 'sizes',
      render: () => (
        <>
          <Select aria-label="Sort by, small" size="sm" selectedKey="name">
            {sizes}
          </Select>
          <Select aria-label="Sort by, medium" selectedKey="name">
            {sizes}
          </Select>
          <Select aria-label="Sort by, large" size="lg" selectedKey="name">
            {sizes}
          </Select>
        </>
      ),
    },
    {
      id: 'help',
      render: () => (
        <Select label="Sort by" description="Applies to every view of this table" selectedKey="created">
          {sizes}
        </Select>
      ),
    },
    {
      id: 'invalid',
      render: () => (
        <Select label="Sort by" isInvalid errorMessage="Pick a column to sort by">
          {sizes}
        </Select>
      ),
    },
    {
      id: 'disabled',
      render: () => (
        <Select label="Sort by" isDisabled selectedKey="rows">
          {sizes}
        </Select>
      ),
    },
    {
      id: 'open',
      render: () => (
        // Open and non-modal, so the panel with its check mark sits next to the rest of the gallery.
        <Select label="Sort by" defaultOpen isNonModal selectedKey="created">
          <ListBoxSection title="Columns">
            <ListBoxItem id="name">Name</ListBoxItem>
            <ListBoxItem id="created" description="Newest first">
              Date created
            </ListBoxItem>
            <ListBoxItem id="rows">Row count</ListBoxItem>
          </ListBoxSection>
          <ListBoxSection title="Unavailable">
            <ListBoxItem id="size" isDisabled>
              Size on disk
            </ListBoxItem>
          </ListBoxSection>
        </Select>
      ),
    },
  ],
};
