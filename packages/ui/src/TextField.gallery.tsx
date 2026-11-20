import { faAt, faServer } from '@fortawesome/free-solid-svg-icons';
import type { CSSProperties } from 'react';
import { TextField } from './TextField';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
const stack: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--rio-space-4)',
  inlineSize: 'min(360px, 100%)',
};

export const gallery: GalleryEntry = {
  id: 'ui.textField',
  title: 'TextField',
  examples: [
    {
      id: 'sizes',
      render: () => (
        <div style={stack}>
          <TextField size="sm" label="Small" placeholder="db.example.com" />
          <TextField label="Medium" placeholder="db.example.com" />
          <TextField size="lg" label="Large" placeholder="db.example.com" />
        </div>
      ),
    },
    {
      id: 'leading-icon',
      render: () => (
        <div style={stack}>
          <TextField icon={faServer} label="Host" placeholder="db.example.com" />
          <TextField size="sm" icon={faAt} label="User" placeholder="admin" />
          <TextField size="lg" icon={faAt} label="User" placeholder="admin" />
        </div>
      ),
    },
    {
      id: 'help-and-error',
      render: () => (
        <div style={stack}>
          <TextField label="Port" description="Between 1 and 65535" defaultValue="5432" />
          <TextField
            label="Port"
            errorMessage="Enter a port between 1 and 65535"
            defaultValue="99999"
            isInvalid
          />
        </div>
      ),
    },
    {
      id: 'states',
      render: () => (
        <div style={stack}>
          <TextField label="Required" isRequired placeholder="Nothing entered yet" />
          <TextField label="Read only" isReadOnly defaultValue="riosoma" />
          <TextField label="Disabled" isDisabled defaultValue="riosoma" />
          <TextField label="Disabled and empty" isDisabled />
        </div>
      ),
    },
  ],
};
