import type { CSSProperties } from 'react';
import { NumberField } from './NumberField';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
const stack: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--rio-space-4)',
  inlineSize: 'min(360px, 100%)',
};

export const gallery: GalleryEntry = {
  id: 'ui.numberField',
  title: 'NumberField',
  examples: [
    {
      id: 'sizes',
      render: () => (
        <div style={stack}>
          <NumberField size="sm" label="Small" defaultValue={2} />
          <NumberField label="Medium" defaultValue={2} />
          <NumberField size="lg" label="Large" defaultValue={2} />
        </div>
      ),
    },
    {
      id: 'formats',
      render: () => (
        <div style={stack}>
          <NumberField label="Plain" defaultValue={1234.5} step={0.5} />
          <NumberField
            label="Currency"
            defaultValue={1234.5}
            step={0.5}
            formatOptions={{ style: 'currency', currency: 'USD' }}
          />
          <NumberField
            label="Percent"
            defaultValue={0.25}
            step={0.05}
            formatOptions={{ style: 'percent', minimumFractionDigits: 0 }}
          />
          <NumberField
            label="Unit"
            defaultValue={64}
            step={8}
            formatOptions={{ style: 'unit', unit: 'gigabyte' }}
          />
        </div>
      ),
    },
    {
      id: 'bounds',
      render: () => (
        <div style={stack}>
          {/* Both steppers keep their room at a bound; only the unavailable one changes. */}
          <NumberField label="At the top" defaultValue={4} minValue={1} maxValue={4} />
          <NumberField label="At the bottom" defaultValue={1} minValue={1} maxValue={4} />
          <NumberField label="Empty" minValue={1} maxValue={4} placeholder="1 to 4" />
        </div>
      ),
    },
    {
      id: 'help-and-error',
      render: () => (
        <div style={stack}>
          <NumberField label="Pool size" description="Connections the server may open" defaultValue={8} />
          <NumberField label="Pool size" errorMessage="Enter 100 or fewer" defaultValue={500} isInvalid />
        </div>
      ),
    },
    {
      id: 'states',
      render: () => (
        <div style={stack}>
          <NumberField label="Required" isRequired placeholder="Nothing entered yet" />
          <NumberField label="Read only" isReadOnly defaultValue={8} />
          <NumberField label="Disabled" isDisabled defaultValue={8} />
        </div>
      ),
    },
  ],
};
