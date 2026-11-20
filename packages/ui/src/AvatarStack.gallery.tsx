import { AvatarStack, type AvatarStackPerson } from './AvatarStack';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample names are plain text.
const PEOPLE: AvatarStackPerson[] = [
  { id: 'usr1', name: 'Ada Lovelace', color: 'gray' },
  { id: 'usr2', name: 'Grace Hopper', color: 'red' },
  { id: 'usr3', name: 'Alan Turing', color: 'orange' },
  { id: 'usr4', name: 'Katherine Johnson', color: 'yellow' },
  { id: 'usr5', name: 'Edsger Dijkstra', color: 'green' },
  { id: 'usr6', name: '山田 太郎', color: 'brown' },
];

export const gallery: GalleryEntry = {
  id: 'ui.avatar-stack',
  title: 'AvatarStack',
  examples: [
    {
      id: 'overflow',
      render: () => <AvatarStack people={PEOPLE} />,
    },
    {
      id: 'max',
      render: () => (
        <>
          <AvatarStack people={PEOPLE} max={2} />
          <AvatarStack people={PEOPLE} max={5} />
          <AvatarStack people={PEOPLE} max={PEOPLE.length} />
        </>
      ),
    },
    {
      id: 'sizes',
      render: () => (
        <>
          <AvatarStack size="sm" people={PEOPLE} />
          <AvatarStack people={PEOPLE} />
        </>
      ),
    },
    {
      id: 'fits',
      render: () => (
        <>
          {/* Everyone fits, so there is no chip and nothing to open. */}
          <AvatarStack people={PEOPLE.slice(0, 3)} />
          <AvatarStack people={PEOPLE.slice(0, 1)} />
        </>
      ),
    },
  ],
};
