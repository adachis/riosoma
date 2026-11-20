import type { CSSProperties } from 'react';
import { SecretArea } from './SecretArea';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
const stack: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--rio-space-4)',
  inlineSize: 'min(360px, 100%)',
};

// A stand-in shaped like a key, assembled here so no key text sits in the source.
const edge = (word: string) => `-----${[word, 'PRIVATE', 'KEY'].join(' ')}-----`;
const SAMPLE_KEY = [edge('BEGIN'), 'sample-line-one-of-a-key', 'sample-line-two-of-a-key', edge('END')].join(
  '\n',
);

export const gallery: GalleryEntry = {
  id: 'ui.secretArea',
  title: 'SecretArea',
  examples: [
    {
      id: 'masked',
      render: () => (
        <div style={stack}>
          <SecretArea label="Private key (PEM)" defaultValue={SAMPLE_KEY} />
        </div>
      ),
    },
    {
      id: 'revealed',
      render: () => (
        <div style={stack}>
          <SecretArea label="Private key (PEM)" defaultValue={SAMPLE_KEY} defaultRevealed />
        </div>
      ),
    },
    {
      id: 'help-and-error',
      render: () => (
        <div style={stack}>
          <SecretArea label="Service account key (JSON)" description="The whole JSON key file" rows={3} />
          <SecretArea
            label="Private key (PEM)"
            rows={3}
            isRequired
            isInvalid
            errorMessage="Paste the key, starting with -----BEGIN"
          />
        </div>
      ),
    },
    {
      id: 'states',
      render: () => (
        <div style={stack}>
          <SecretArea label="Disabled" rows={3} isDisabled defaultValue={SAMPLE_KEY} />
        </div>
      ),
    },
  ],
};
