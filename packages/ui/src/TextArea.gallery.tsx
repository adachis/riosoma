import type { CSSProperties } from 'react';
import { TextArea } from './TextArea';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
const stack: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--rio-space-4)',
  inlineSize: 'min(360px, 100%)',
};

export const gallery: GalleryEntry = {
  id: 'ui.textArea',
  title: 'TextArea',
  examples: [
    {
      id: 'sizes',
      render: () => (
        <div style={stack}>
          <TextArea size="sm" label="Small" rows={2} placeholder="Two short lines" />
          <TextArea label="Medium" placeholder="Three lines" />
          <TextArea size="lg" label="Large" rows={4} placeholder="Four tall lines" />
        </div>
      ),
    },
    {
      id: 'filled',
      render: () => (
        <div style={stack}>
          <TextArea label="Notes" defaultValue={'Restored from the 02:00 snapshot.\nNothing was lost.'} />
        </div>
      ),
    },
    {
      id: 'help-and-error',
      render: () => (
        <div style={stack}>
          <TextArea label="Query" description="Runs against the read replica" rows={2} />
          <TextArea
            label="Query"
            rows={2}
            errorMessage="The statement has to start with SELECT"
            defaultValue="DROP TABLE accounts"
            isInvalid
          />
        </div>
      ),
    },
    {
      id: 'states',
      render: () => (
        <div style={stack}>
          <TextArea label="Required" rows={2} isRequired placeholder="Nothing entered yet" />
          <TextArea label="Read only" rows={2} isReadOnly defaultValue="riosoma" />
          <TextArea label="Disabled" rows={2} isDisabled defaultValue="riosoma" />
        </div>
      ),
    },
  ],
};
