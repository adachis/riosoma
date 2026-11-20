import type { ChoiceColor } from '@riosoma/contracts';
import { useState } from 'react';
import { ChoicePill } from './ChoicePill';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
function LivePicker() {
  const [color, setColor] = useState<ChoiceColor>('green');
  return (
    <>
      <ColorSwatchPicker label="Choice color" value={color} onChange={setColor} />
      {/* What the color looks like once an option wears it. */}
      <ChoicePill name="Deployed" color={color} onRemove={() => {}} />
    </>
  );
}

export const gallery: GalleryEntry = {
  id: 'ui.color-swatch-picker',
  title: 'ColorSwatchPicker',
  examples: [
    {
      id: 'controlled',
      render: () => <LivePicker />,
    },
    {
      id: 'uncontrolled',
      render: () => <ColorSwatchPicker label="Person color" defaultValue="blue" />,
    },
    {
      id: 'disabled',
      render: () => <ColorSwatchPicker label="Choice color" defaultValue="red" isDisabled />,
    },
    {
      id: 'read-only',
      render: () => <ColorSwatchPicker label="Choice color" defaultValue="purple" isReadOnly />,
    },
  ],
};
