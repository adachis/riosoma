import type { CSSProperties } from 'react';
import { PasswordField } from './PasswordField';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
const stack: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--rio-space-4)',
  inlineSize: 'min(360px, 100%)',
};

export const gallery: GalleryEntry = {
  id: 'ui.passwordField',
  title: 'PasswordField',
  examples: [
    {
      id: 'sizes',
      render: () => (
        <div style={stack}>
          <PasswordField size="sm" label="Small" defaultValue="correct-horse" />
          <PasswordField label="Medium" defaultValue="correct-horse" />
          <PasswordField size="lg" label="Large" defaultValue="correct-horse" />
        </div>
      ),
    },
    {
      id: 'masked-and-revealed',
      render: () => (
        <div style={stack}>
          {/* The same field both ways: revealing swaps the mask for the mono font and changes
              nothing else, so the value stays where the reader left it. */}
          <PasswordField label="Masked" defaultValue="correct-horse" />
          <PasswordField label="Revealed" defaultValue="correct-horse" defaultRevealed />
        </div>
      ),
    },
    {
      id: 'autocomplete',
      render: () => (
        <div style={stack}>
          <PasswordField label="Password" autoComplete="current-password" placeholder="Enter it" />
          <PasswordField label="New password" autoComplete="new-password" placeholder="Choose one" />
        </div>
      ),
    },
    {
      id: 'help-and-error',
      render: () => (
        <div style={stack}>
          <PasswordField
            label="New password"
            description="At least 12 characters"
            autoComplete="new-password"
          />
          <PasswordField
            label="New password"
            errorMessage="Use 12 characters or more"
            autoComplete="new-password"
            defaultValue="short"
            isInvalid
          />
        </div>
      ),
    },
    {
      id: 'states',
      render: () => (
        <div style={stack}>
          <PasswordField label="Required" isRequired placeholder="Nothing entered yet" />
          <PasswordField label="Read only" isReadOnly defaultValue="correct-horse" />
          <PasswordField label="Disabled" isDisabled defaultValue="correct-horse" />
        </div>
      ),
    },
  ],
};
