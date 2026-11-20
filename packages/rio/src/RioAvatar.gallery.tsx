import type { ReactNode } from 'react';
import { RioAvatar } from './RioAvatar';
import { RIO_MOODS } from './moods';
import { useRioMood } from './useRioMood';

// Structurally matches the shared gallery without introducing a UI package dependency.
interface GalleryEntry {
  id: string;
  title: string;
  examples: Array<{ id: string; render: () => ReactNode }>;
}

function MoodPicker() {
  const [mood, setMood] = useRioMood();
  return (
    <div>
      <RioAvatar mood={mood} size={200} scene autoNap={false} />
      <div>
        {RIO_MOODS.map((value) => (
          <button key={value} type="button" aria-pressed={mood === value} onClick={() => setMood(value)}>
            {value}
          </button>
        ))}
      </div>
    </div>
  );
}

export const gallery: GalleryEntry = {
  id: 'rio.avatar',
  title: 'RioAvatar',
  examples: [
    ...[false, true].map((scene) => ({
      id: scene ? 'scene' : 'transparent',
      render: () => (
        <>
          {RIO_MOODS.map((mood) => (
            <RioAvatar key={mood} mood={mood} size={200} scene={scene} autoNap={false} />
          ))}
        </>
      ),
    })),
    ...[48, 32].map((size) => ({
      id: `size-${size}`,
      render: () => (
        <>
          {RIO_MOODS.map((mood) => (
            <RioAvatar key={mood} mood={mood} size={size} autoNap={false} />
          ))}
        </>
      ),
    })),
    { id: 'poke', render: () => <RioAvatar size={200} scene onPoke={() => {}} /> },
    { id: 'mood-picker', render: () => <MoodPicker /> },
    {
      id: 'reduced-motion',
      render: () => (
        <>
          {RIO_MOODS.map((mood) => (
            <RioAvatar key={mood} mood={mood} size={200} motion="reduce" autoNap={false} />
          ))}
        </>
      ),
    },
  ],
};
