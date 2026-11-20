import type { CSSProperties } from 'react';
import { SearchField } from './SearchField';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
const stack: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--rio-space-4)',
  inlineSize: 'min(360px, 100%)',
};

export const gallery: GalleryEntry = {
  id: 'ui.searchField',
  title: 'SearchField',
  examples: [
    {
      id: 'sizes',
      render: () => (
        <div style={stack}>
          <SearchField size="sm" label="Small" placeholder="Filter tables" />
          <SearchField label="Medium" placeholder="Filter tables" />
          <SearchField size="lg" label="Large" placeholder="Filter tables" />
        </div>
      ),
    },
    {
      id: 'clear',
      render: () => (
        <div style={stack}>
          {/* Empty and filled side by side: the query sits in the same place in both, and the clear
              button appears over space the input always keeps free. */}
          <SearchField label="Empty" placeholder="Filter tables" />
          <SearchField label="Filled" defaultValue="orders" />
        </div>
      ),
    },
    {
      id: 'help-and-error',
      render: () => (
        <div style={stack}>
          <SearchField label="Tables" description="Matches the start of a name" defaultValue="ord" />
          <SearchField
            label="Tables"
            errorMessage="Enter at least two characters"
            defaultValue="o"
            isInvalid
          />
        </div>
      ),
    },
    {
      id: 'states',
      render: () => (
        <div style={stack}>
          <SearchField label="Required" isRequired placeholder="Nothing entered yet" />
          <SearchField label="Read only" isReadOnly defaultValue="orders" />
          <SearchField label="Disabled" isDisabled defaultValue="orders" />
        </div>
      ),
    },
  ],
};
